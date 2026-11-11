const { indexBindings } = require("./cpp");
const { indexWithClangd } = require("./clangd");
const { findBindings, findReexportBindings, groupBindings, pythonQuery, pythonReexport } = require("./navigation");
const { typeDefinitionBindings } = require("./python_language_service");

const namespace = "pybind11Navigation";
const pythonModuleExclude = "{**/.git/**,**/.venv/**,**/build*/**,**/site-packages/**,**/node_modules/**}";
const pythonIdentifier = /^[_\p{ID_Start}][\p{ID_Continue}]*$/u;

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

class WorkspaceIndex {
    constructor(vscode, folder, log) {
        this.vscode = vscode;
        this.workspace = vscode.workspace;
        this.folder = folder;
        this.log = log;
        this.files = new Map();
        this.bindings = new Map();
        this.ready = Promise.resolve();
        const settings = vscode.workspace.getConfiguration(namespace, folder.uri);
        this.useClangd = settings.get("useClangd", true);
        this.include = new vscode.RelativePattern(folder, settings.get("include"));
        const exclude = settings.get("exclude");
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
            const uris = await this.workspace.findFiles(this.include, this.exclude);
            this.files.clear();
            // Avoid opening the entire workspace's C++ files at once.
            for (let start = 0; start < uris.length; start += 8) {
                await Promise.all(uris.slice(start, start + 8).map((uri) => this.read(uri)));
            }
            this.reindex();
        });
    }

    async read(uri) {
        const key = uri.toString();
        try {
            const source = Buffer.from(await this.workspace.fs.readFile(uri)).toString("utf8");
            const clangd = this.useClangd
                ? await indexWithClangd(this.vscode, uri, source, this.log)
                : undefined;
            this.files.set(key, { uri, entries: clangd ?? indexBindings(source) });
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

    function reset() {
        folders.forEach((folder) => folder.dispose());
        folders = (vscode.workspace.workspaceFolders ?? []).map(
            (folder) => new WorkspaceIndex(vscode, folder, log)
        );
    }

    reset();
    context.subscriptions.push(
        log,
        { dispose: () => folders.forEach((folder) => folder.dispose()) },
        vscode.workspace.onDidChangeWorkspaceFolders(reset),
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration(`${namespace}.include`) ||
                event.affectsConfiguration(`${namespace}.exclude`) ||
                event.affectsConfiguration(`${namespace}.useClangd`)) reset();
        }),
        vscode.workspace.onDidSaveTextDocument((document) => {
            const folder = vscode.workspace.getWorkspaceFolder(document.uri);
            folders.find((index) => index.folder.uri.toString() === folder?.uri.toString())?.update(document.uri);
        }),
        vscode.languages.registerDefinitionProvider({ language: "python" }, {
            async provideDefinition(document, position, token) {
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
                    await Promise.all(indexes.map((folder) => folder.ready));
                    if (token.isCancellationRequested || version !== document.version || folders !== indexes) return;
                    const entries = {
                        get: (key) => indexes.flatMap((folder) => folder.bindings.get(key) ?? []),
                    };
                    const moduleMap = settings.get("moduleMap", {});
                    let fallback = findBindings(query.symbol, moduleMap, entries);
                    if (!fallback.length) {
                        fallback = await findReexportBindings(query.symbol, moduleMap, entries,
                            (module, name) => readReexport(vscode, executable, module, name, token, abort.signal));
                    }
                    // Existing module-level symbols need no receiver type query.
                    const typed = fallback.some(({ kind }) => kind !== "method") ? undefined :
                        await typeDefinitionBindings(vscode, document, query, moduleMap, entries, token)
                            .catch((error) => {
                                if (!token.isCancellationRequested) log.appendLine(String(error));
                            });
                    if (token.isCancellationRequested || version !== document.version || folders !== indexes) return;
                    return (typed ?? fallback).map(
                        ({ uri, line, column: character }) => new vscode.Location(uri, new vscode.Position(line, character))
                    );
                } catch (error) {
                    if (!token.isCancellationRequested) log.appendLine(String(error));
                } finally {
                    cancellation.dispose();
                }
            },
        })
    );
}

module.exports = { activate };
