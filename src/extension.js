const { indexBindings } = require("./cpp");
const path = require("node:path");
const os = require("node:os");
const picomatch = require("picomatch");
const { indexWithClangd } = require("./clangd");
const { findBindings, findReexportBindings, groupBindings, pythonQuery, pythonReexport } = require("./navigation");
const { typeDefinitionBindings } = require("./python_language_service");

const namespace = "pybind11Navigation";
const pythonModuleExclude = "{**/.git/**,**/.venv/**,**/build*/**,**/site-packages/**,**/node_modules/**}";
const pythonIdentifier = /^[_\p{ID_Start}][\p{ID_Continue}]*$/u;

function mergeBindings(ast, source) {
    if (!ast) return source;
    const key = (entry) => JSON.stringify([entry.module, entry.className, entry.name, entry.kind, entry.line, entry.column]);
    const lexical = new Map(source.map((entry) => [key(entry), entry]));
    const seen = new Set();
    const merged = ast.map((entry) => {
        const id = key(entry);
        seen.add(id);
        return { ...entry, ...lexical.get(id) };
    });
    // clangd's AST extractor handles fluent registrations. Source indexing
    // supplements forms the extractor does not yet visit.
    for (const entry of source) {
        if (entry.extended && !seen.has(key(entry))) merged.push(entry);
    }
    return merged;
}

async function readReexport(vscode, executable, module, name, token, signal) {
    const parts = module.split(".");
    if (!parts.every((part) => pythonIdentifier.test(part)) || token.isCancellationRequested) return;
    const suffix = parts.join("/");
    const files = await vscode.workspace.findFiles(
        `{**/${suffix}.py,**/${suffix}/__init__.py}`, pythonModuleExclude, 2, token
    );
    if (files.length !== 1 || token.isCancellationRequested) return;
    const document = await vscode.workspace.openTextDocument(files[0]);
    if (token.isCancellationRequested) return;
    return pythonReexport(executable, document.getText(), module, files[0].path.endsWith("/__init__.py"), name, signal);
}

async function externalFiles(vscode, root, include, exclude, log) {
    const match = picomatch(include, { dot: true });
    const matchesExclude = exclude ? picomatch(exclude, { dot: true }) : () => false;
    // In a brace group picomatch's **/ does not match zero directories;
    // the synthetic prefix also lets the VS Code default exclude match at root.
    const skip = (item) => matchesExclude(item) || matchesExclude(`__root__/${item}`);
    const results = [];
    async function visit(uri, relative) {
        let children;
        try {
            children = await vscode.workspace.fs.readDirectory(uri);
        } catch (error) {
            log.appendLine(`Cannot scan ${uri.fsPath ?? uri.path}: ${error}`);
            return;
        }
        for (const [name, type] of children) {
            const item = relative ? `${relative}/${name}` : name;
            const child = vscode.Uri.joinPath(uri, name);
            // Do not follow links to avoid cycles or escaping the configured root.
            if (type & vscode.FileType.SymbolicLink) continue;
            if (type & vscode.FileType.Directory) {
                if (!skip(`${item}/`) && !skip(`${item}/__pybind11_scan__`)) await visit(child, item);
            } else if ((type & vscode.FileType.File) && match(item) && !skip(item)) {
                results.push(child);
            }
        }
    }
    await visit(root, "");
    return results;
}

class WorkspaceIndex {
    constructor(vscode, folder, log, options = {}) {
        this.vscode = vscode;
        this.workspace = vscode.workspace;
        this.folder = folder;
        this.log = log;
        this.files = new Map();
        this.bindings = new Map();
        this.ready = Promise.resolve();
        const settings = options.settings ?? vscode.workspace.getConfiguration(namespace, folder.uri);
        this.useClangd = settings.get("useClangd", true);
        this.includeGlob = settings.get("include");
        this.excludeGlob = settings.get("exclude");
        this.external = options.external ?? false;
        this.include = new vscode.RelativePattern(this.external ? folder.uri : folder, this.includeGlob);
        const exclude = this.excludeGlob;
        this.exclude = exclude ? new vscode.RelativePattern(folder, exclude) : null;
        this.watcher = vscode.workspace.createFileSystemWatcher(this.include);
        this.watcher.onDidCreate(() => this.scheduleScan());
        this.watcher.onDidDelete(() => this.scheduleScan());
        this.watcher.onDidChange((uri) => this.update(uri));
        this.scheduleScan();
    }

    enqueue(task) {
        this.ready = this.ready.then(task).catch((error) => this.log.appendLine(String(error)));
    }

    scheduleScan() {
        if (this.scanQueued) return;
        this.scanQueued = true;
        this.enqueue(async () => {
            this.scanQueued = false;
            const uris = this.external
                ? await externalFiles(this.vscode, this.folder.uri, this.includeGlob, this.excludeGlob, this.log)
                : await this.workspace.findFiles(this.include, this.exclude);
            this.files.clear();
            // Avoid opening the entire workspace's C++ files at once.
            for (let start = 0; start < uris.length; start += 8) {
                await Promise.all(uris.slice(start, start + 8).map((uri) => this.read(uri)));
            }
            this.reindex();
            if (this.external) this.log.appendLine(`Indexed ${uris.length} source files under ${this.folder.uri.fsPath}`);
        });
    }

    async read(uri) {
        const key = uri.toString();
        try {
            const source = Buffer.from(await this.workspace.fs.readFile(uri)).toString("utf8");
            const clangd = this.useClangd
                ? await indexWithClangd(this.vscode, uri, source, this.log)
                : undefined;
            this.files.set(key, { uri, entries: mergeBindings(clangd, indexBindings(source)) });
        } catch (error) {
            this.files.delete(key);
            if (error.code !== "FileNotFound") this.log.appendLine(String(error));
        }
    }

    update(uri) {
        this.enqueue(async () => {
            if (!this.files.has(uri.toString())) return;
            await this.read(uri);
            this.reindex();
        });
    }

    reindex() {
        this.bindings = groupBindings(this.files.values());
    }

    dispose() {
        this.watcher.dispose();
    }
}

function activate(context, vscode = require("vscode")) {
    const log = vscode.window.createOutputChannel("pybind11 Navigate");
    let folders = [];
    let external = [];
    let sourcesByFolder = new Map();
    const warnedDefaults = new Set();

    function reset() {
        [...folders, ...external].forEach((folder) => folder.dispose());
        folders = (vscode.workspace.workspaceFolders ?? []).map(
            (folder) => new WorkspaceIndex(vscode, folder, log)
        );
        external = [];
        sourcesByFolder = new Map();
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
            const settings = vscode.workspace.getConfiguration(namespace, folder.uri);
            const roots = new Map();
            const sources = [];
            for (const [module, config] of Object.entries(settings.get("moduleSources", {}))) {
                if (!module.split(".").every((part) => pythonIdentifier.test(part)) ||
                    typeof config?.module !== "string" || !config.module.split(".").every((part) => pythonIdentifier.test(part)) ||
                    typeof config?.path !== "string" || !config.path.trim()) {
                    log.appendLine(`Invalid moduleSources entry for ${module}; expected { module, path }.`);
                    continue;
                }
                const sourcePath = config.path.replace(/^~(?=$|[\\/])/, os.homedir());
                const absolute = path.resolve(folder.uri.fsPath, sourcePath);
                let index = roots.get(absolute);
                if (!index) {
                    index = new WorkspaceIndex(vscode, { uri: vscode.Uri.file(absolute) }, log, { external: true, settings });
                    roots.set(absolute, index);
                    external.push(index);
                }
                sources.push({ module, native: config.module, index });
            }
            sources.sort((a, b) => b.module.length - a.module.length);
            sourcesByFolder.set(folder.uri.toString(), sources);
        }
    }

    async function resolveBindings(document, position, token) {
        if (!vscode.workspace.getWorkspaceFolder(document.uri) || token.isCancellationRequested) return;
        const settings = vscode.workspace.getConfiguration(namespace, document.uri);
        const executable = settings.get("pythonPath") || (process.platform === "win32" ? "python" : "python3");
        const column = Buffer.byteLength(document.lineAt(position.line).text.slice(0, position.character));
        const version = document.version;
        const abort = new AbortController();
        const cancellation = token.onCancellationRequested(() => abort.abort());
        try {
            const query = await pythonQuery(executable, document.getText(), position.line + 1, column, abort.signal);
            if (!query || token.isCancellationRequested) return;
            const indexes = folders;
            const configured = sourcesByFolder.get(vscode.workspace.getWorkspaceFolder(document.uri).uri.toString()) ?? [];
            await Promise.all([...indexes, ...configured.map(({ index }) => index)].map((index) => index.ready));
            if (token.isCancellationRequested || version !== document.version || folders !== indexes) return;
            const entries = {
                get: (key, module) => {
                    const source = configured.find((entry) => module === entry.module || module?.startsWith(entry.module + "."));
                    if (source) return source.index.bindings.get(key) ?? [];
                    if (!module) {
                        const native = JSON.parse(key)[0];
                        const possible = configured.filter((entry) => native === entry.native || native.startsWith(entry.native + "."));
                        if (possible.length === 1) return possible[0].index.bindings.get(key) ?? [];
                        if (possible.length > 1) return [];
                    }
                    return indexes.flatMap((index) => index.bindings.get(key) ?? []);
                },
            };
            const moduleMap = { ...settings.get("moduleMap", {}) };
            for (const source of configured) moduleMap[source.module] = source.native;
            let fallback = findBindings(query.symbol, moduleMap, entries);
            const assumedDefaults = new Set();
            if (!fallback.length) {
                fallback = await findReexportBindings(query.symbol, moduleMap, entries,
                    async (module, name) => {
                        const result = await readReexport(vscode, executable, module, name, token, abort.signal);
                        if (result?.assumedDefault) assumedDefaults.add(module);
                        return result;
                    });
            }
            const typed = fallback.some(({ kind }) => kind !== "method") ? undefined :
                await typeDefinitionBindings(vscode, document, query, moduleMap, entries, token)
                    .catch((error) => {
                        if (!token.isCancellationRequested) log.appendLine(String(error));
                    });
            if (token.isCancellationRequested || version !== document.version || folders !== indexes) return;
            if (!typed && fallback.length) for (const module of assumedDefaults) {
                if (warnedDefaults.has(module)) continue;
                warnedDefaults.add(module);
                const message = `pybind11 Navigate used the source-declared backend default in ${module}. The runtime environment may select another backend; configure moduleMap if needed.`;
                log.appendLine(message);
                void vscode.window.showWarningMessage(message);
            }
            return typed ?? fallback;
        } catch (error) {
            if (!token.isCancellationRequested) log.appendLine(String(error));
        } finally {
            cancellation.dispose();
        }
    }

    async function reveal(uri, position) {
        return vscode.window.showTextDocument(uri, { selection: new vscode.Range(position, position) });
    }

    async function choose(entries, title, describe) {
        if (entries.length === 1) return entries[0];
        const selected = await vscode.window.showQuickPick(entries.map((entry) => ({
            ...describe(entry), entry,
        })), { title, matchOnDescription: true, matchOnDetail: true });
        return selected?.entry;
    }

    async function goToImplementation() {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== "python") return;
        const cancellation = new vscode.CancellationTokenSource();
        try {
            const bindings = await resolveBindings(editor.document, editor.selection.active, cancellation.token);
            if (!bindings?.length) {
                await vscode.window.showInformationMessage("No matching pybind11 registration was found. Check the pybind11 Navigate output for details.");
                return;
            }
            const binding = await choose(bindings, "Select a pybind11 registration", (entry) => ({
                label: `${entry.className ? entry.className + "." : ""}${entry.name}`,
                description: `${entry.uri.fsPath ?? entry.uri.path}:${entry.line + 1}`,
                detail: entry.implementation?.kind ?? "Implementation unavailable",
            }));
            if (!binding) return;
            const target = binding.implementations
                ? await choose(binding.implementations, "Select a property accessor", (accessor) => ({
                    label: accessor.role === "setter" ? "Setter" : "Getter",
                    description: accessor.kind,
                }))
                : binding.implementation;
            if (binding.implementations && !target) return;
            if (target?.kind === "lambda") {
                await reveal(binding.uri, new vscode.Position(target.line, target.column));
                return;
            }
            if (target?.kind === "pointer") {
                const position = new vscode.Position(target.line, target.column);
                await vscode.workspace.openTextDocument(binding.uri);
                const locations = await vscode.commands.executeCommand("vscode.executeDefinitionProvider", binding.uri, position) ?? [];
                const usable = locations.map((location) => ({
                    uri: location.targetUri ?? location.uri,
                    range: location.targetSelectionRange ?? location.range ?? location.targetRange,
                })).filter(({ uri, range }) => uri && range);
                const selected = await choose(usable, "Select a C++ definition", ({ uri, range }) => ({
                    label: uri.fsPath ?? uri.path,
                    description: `Line ${range.start.line + 1}`,
                }));
                if (selected) {
                    await reveal(selected.uri, selected.range.start);
                    return;
                }
                if (usable.length) return; // The user canceled the picker.
            }
            const open = "Go to registration";
            const message = target?.kind === "pointer"
                ? "The C++ language service could not find a definition. Check that clangd or another C++ extension is configured for this source."
                : "This registration does not contain a supported function pointer or lambda.";
            if (await vscode.window.showInformationMessage(message, open) === open) {
                await reveal(binding.uri, new vscode.Position(binding.line, binding.column));
            }
        } catch (error) {
            log.appendLine(`Go to C++ implementation: ${error}`);
            await vscode.window.showErrorMessage("Could not navigate to the C++ implementation. See the pybind11 Navigate output.");
        } finally {
            cancellation.dispose();
        }
    }

    reset();
    context.subscriptions.push(
        log,
        { dispose: () => [...folders, ...external].forEach((folder) => folder.dispose()) },
        vscode.workspace.onDidChangeWorkspaceFolders(reset),
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration(`${namespace}.include`) ||
                event.affectsConfiguration(`${namespace}.exclude`) ||
                event.affectsConfiguration(`${namespace}.useClangd`) ||
                event.affectsConfiguration(`${namespace}.moduleSources`)) reset();
        }),
        vscode.workspace.onDidSaveTextDocument((document) => {
            for (const index of [...folders, ...external]) index.update(document.uri);
        }),
        vscode.commands.registerCommand("pybind11Navigation.goToImplementation", goToImplementation),
        vscode.languages.registerDefinitionProvider({ language: "python" }, {
            async provideDefinition(document, position, token) {
                const bindings = await resolveBindings(document, position, token);
                return bindings?.map(({ uri, line, column: character }) =>
                    new vscode.Location(uri, new vscode.Position(line, character)));
            },
        })
    );
}

module.exports = { activate, mergeBindings };
