const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");
const { activate } = require("../src/extension");

function uri(file) {
    const absolute = path.resolve(file);
    return { fsPath: absolute, path: absolute.split(path.sep).join("/"), toString: () => pathToFileURL(absolute).toString() };
}

function harness(workspacePath, settings) {
    const folder = { uri: uri(workspacePath) };
    const disposable = { dispose() {} };
    const noop = () => disposable;
    let provider, onSave, command, pick = 0;
    const callbacks = [];
    const shown = [];
    const messages = [];
    const calls = [];
    let definition = [];
    const v = {
        Uri: { file: uri, joinPath: (base, name) => uri(path.join(base.fsPath, name)) },
        FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
        RelativePattern: class { constructor(base, pattern) { Object.assign(this, { base, pattern }); } },
        Position: class { constructor(line, character) { Object.assign(this, { line, character }); } },
        Range: class { constructor(start, end) { Object.assign(this, { start, end }); } },
        Location: class { constructor(uri, position) { Object.assign(this, { uri, position }); } },
        CancellationTokenSource: class {
            token = { isCancellationRequested: false, onCancellationRequested: noop };
            dispose() {}
            cancel() { this.token.isCancellationRequested = true; }
        },
        SymbolKind: { Class: 4 },
        window: {
            createOutputChannel: () => ({ ...disposable, appendLine: (message) => messages.push(message) }),
            showQuickPick: async (items) => pick === null ? undefined : items[pick],
            showTextDocument: async (target, options) => { shown.push({ uri: target, ...options }); },
            showInformationMessage: async (message) => { messages.push(message); },
            showWarningMessage: async (message) => { messages.push(message); },
            showErrorMessage: async (message) => { messages.push(message); },
        },
        extensions: { getExtension: () => undefined },
        workspace: {
            workspaceFolders: [folder],
            getWorkspaceFolder: (documentUri) => documentUri.fsPath?.startsWith(folder.uri.fsPath + path.sep) ? folder : undefined,
            getConfiguration: () => ({ get: (key, fallback) => ({
                include: "**/*.{cpp,h}", exclude: "{**/.git/**,**/build*/**,**/node_modules/**}",
                useClangd: false, ...settings,
            })[key] ?? fallback }),
            createFileSystemWatcher: () => {
                const handlers = {};
                callbacks.push(handlers);
                return { ...disposable,
                    onDidCreate: (fn) => { handlers.create = fn; },
                    onDidDelete: (fn) => { handlers.delete = fn; },
                    onDidChange: (fn) => { handlers.change = fn; },
                };
            },
            findFiles: async (pattern) => {
                if (typeof pattern === "string") {
                    const result = [];
                    for (const [module, file] of Object.entries(settings.pythonWrappers ?? {})) {
                        if (pattern.includes(module.replaceAll(".", "/"))) result.push(uri(file));
                    }
                    return result;
                }
                const result = [];
                async function visit(dir) {
                    for (const item of await fsp.readdir(dir, { withFileTypes: true })) {
                        if (item.isDirectory()) await visit(path.join(dir, item.name));
                        else if (item.name.endsWith(".cpp")) result.push(uri(path.join(dir, item.name)));
                    }
                }
                await visit(workspacePath);
                return result;
            },
            fs: {
                readFile: (target) => fsp.readFile(target.fsPath),
                readDirectory: async (target) => (await fsp.readdir(target.fsPath, { withFileTypes: true }))
                    .map((item) => [item.name, item.isSymbolicLink() ? 64 : item.isDirectory() ? 2 : 1]),
            },
            openTextDocument: async (target) => makeDocument(await fsp.readFile(target.fsPath, "utf8"), target),
            onDidChangeWorkspaceFolders: noop,
            onDidChangeConfiguration: noop,
            onDidSaveTextDocument: (fn) => { onSave = fn; return disposable; },
        },
        commands: {
            registerCommand: (id, fn) => { assert.equal(id, "pybind11Navigation.goToImplementation"); command = fn; return disposable; },
            executeCommand: async (name, target, position) => {
                calls.push({ name, target, position });
                if (name === "vscode.executeDefinitionProvider") return definition;
                return [];
            },
        },
        languages: { registerDefinitionProvider: (_selector, fn) => { provider = fn; return disposable; } },
    };
    const context = { subscriptions: [] };
    activate(context, v);
    const token = { isCancellationRequested: false, onCancellationRequested: noop };
    function input(marked) {
        const marker = marked.includes("\uFFF0") ? "\uFFF0" : "|";
        const [before, after] = marked.split(marker);
        assert.notEqual(after, undefined);
        const line = before.split("\n");
        const document = makeDocument(before + after, uri(path.join(workspacePath, "use.py")));
        const position = new v.Position(line.length - 1, line.at(-1).length);
        return { document, position };
    }
    return {
        v, callbacks, shown, calls, messages,
        setPick: (value) => { pick = value; },
        setDefinition: (value) => { definition = value; },
        save: (file) => onSave({ uri: uri(file) }),
        async navigate(marked) {
            const { document, position } = input(marked);
            return provider.provideDefinition(document, position, token);
        },
        async implementation(marked) {
            const { document, position } = input(marked);
            v.window.activeTextEditor = { document, selection: { active: position } };
            await command();
        },
        dispose: () => context.subscriptions.forEach((subscription) => subscription.dispose()),
    };
}

function makeDocument(source, documentUri) {
    return { uri: documentUri, languageId: "python", version: 1,
        getText: () => source, lineAt: (line) => ({ text: source.split("\n")[line] }) };
}

function projectSource(owner) {
    return `PYBIND11_MODULE(_core, m) {
    auto reader = py::class_<${owner}Reader>(m, "Reader");
    reader.def("setup", &${owner}Reader::setup);
    reader.def("setup", [](${owner}Reader &self) { return 2; });
    auto writer = py::class_<${owner}Writer>(m, "Writer");
    writer.def("setup", &${owner}Writer::setup);
    reader.def_property("value", &${owner}Reader::get, &${owner}Reader::set);
}`;
}

test("external source mappings isolate same-named modules and update on save", async (t) => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "pybind-v2-"));
    t.after(() => fsp.rm(root, { recursive: true, force: true }));
    const workspace = path.join(root, "python");
    const first = path.join(root, "first");
    const second = path.join(root, "second");
    await Promise.all([workspace, first, second, path.join(first, "build")].map((dir) => fsp.mkdir(dir, { recursive: true })));
    await Promise.all([
        fsp.writeFile(path.join(workspace, "unrelated.cpp"), projectSource("Wrong")),
        fsp.writeFile(path.join(first, "bindings.cpp"), projectSource("First")),
        fsp.writeFile(path.join(second, "bindings.cpp"), projectSource("Second")),
        fsp.writeFile(path.join(first, "build", "ignored.cpp"), projectSource("Ignored")),
    ]);
    const app = harness(workspace, { moduleSources: {
        "pkg.api": { module: "_core", path: "../first" },
        "other.api": { module: "_core", path: second },
    } });
    t.after(app.dispose);
    const python = "from pkg.api import Reader\nreader: Reader\nreader.|setup()";
    let hits = await app.navigate(python);
    assert.equal(hits.length, 2);
    assert.ok(hits.every((item) => item.uri.fsPath === path.join(first, "bindings.cpp")));
    hits = await app.navigate("from pkg.api import Writer\nWriter().|setup()");
    assert.deepEqual(hits.map((item) => item.position.line), [5]);
    assert.equal(hits[0].uri.fsPath, path.join(first, "bindings.cpp"));
    hits = await app.navigate(python.replace("pkg.api", "other.api"));
    assert.ok(hits.every((item) => item.uri.fsPath === path.join(second, "bindings.cpp")));
    const changed = projectSource("First").replaceAll('"setup"', '"configure"');
    await fsp.writeFile(path.join(first, "bindings.cpp"), changed);
    app.save(path.join(first, "bindings.cpp"));
    assert.deepEqual(await app.navigate(python), []);
    hits = await app.navigate(python.replace("setup", "configure"));
    assert.equal(hits.length, 2);
    const added = path.join(first, "new.cpp");
    await fsp.writeFile(added, projectSource("New"));
    app.callbacks[1].create(uri(added));
    hits = await app.navigate(python);
    assert.equal(hits.length, 2);
    assert.ok(hits.every((item) => item.uri.fsPath === added));
    await fsp.unlink(added);
    app.callbacks[1].delete(uri(added));
    assert.deepEqual(await app.navigate(python), []);
});

test("optional real checkout: SGLang import and Mooncake registrations", async (t) => {
    const root = process.env.PYBIND11_TEST_REAL_ROOT;
    const example = process.env.PYBIND11_TEST_REAL_PYTHON;
    if (!root || !example) return t.skip("set PYBIND11_TEST_REAL_ROOT and PYBIND11_TEST_REAL_PYTHON");
    const workspace = await fsp.mkdtemp(path.join(os.tmpdir(), "pybind-real-python-"));
    t.after(() => fsp.rm(workspace, { recursive: true, force: true }));
    const app = harness(workspace, { moduleSources: { "mooncake.store": { module: "_store", path: root } } });
    t.after(app.dispose);
    const pythonSource = await fsp.readFile(example, "utf8");
    const marked = pythonSource.replace("from mooncake.store import MooncakeDistributedStore",
        "from mooncake.store import \uFFF0MooncakeDistributedStore");
    assert.notEqual(marked, pythonSource);
    const cppPath = path.join(root, "mooncake-integration/store/store_py.cpp");
    const cpp = await fsp.readFile(cppPath, "utf8");
    const imported = await app.navigate(marked);
    assert.equal(imported.length, 1);
    assert.equal(imported[0].uri.fsPath, cppPath);
    assert.ok(cpp.split("\n")[imported[0].position.line].includes('"MooncakeDistributedStore"'));
    for (const [method, expected] of [["get", 1], ["put", 1], ["setup", 2]]) {
        const hits = await app.navigate(`from mooncake.store import MooncakeDistributedStore\nstore: MooncakeDistributedStore\nstore.|${method}()`);
        assert.equal(hits.length, expected, method);
        for (const hit of hits) {
            assert.equal(hit.uri.fsPath, cppPath);
            assert.ok(cpp.split("\n").slice(hit.position.line, hit.position.line + 3).join("\n").includes(`"${method}"`));
        }
    }
    assert.deepEqual(await app.navigate("from mooncake.store import ReplicateConfig\nconfig: ReplicateConfig\nconfig.|setup()"), []);
});

test("implementation command asks for overload, follows pointers and opens lambdas", async (t) => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "pybind-command-"));
    t.after(() => fsp.rm(root, { recursive: true, force: true }));
    const workspace = path.join(root, "python"), source = path.join(root, "native");
    await Promise.all([fsp.mkdir(workspace), fsp.mkdir(source)]);
    const bindingPath = path.join(source, "bindings.cpp");
    await fsp.writeFile(bindingPath, projectSource("First"));
    const app = harness(workspace, { moduleSources: { "pkg.api": { module: "_core", path: source } } });
    t.after(app.dispose);
    const request = "from pkg.api import Reader\nReader().|setup()";
    const definitionUri = uri(path.join(source, "impl.cpp"));
    app.setDefinition([{ uri: definitionUri, range: { start: { line: 30, character: 5 } } }]);
    await app.implementation(request);
    let call = app.calls.find((item) => item.name === "vscode.executeDefinitionProvider");
    assert.equal(call.target.fsPath, bindingPath);
    const bindingLine = projectSource("First").split("\n")[call.position.line];
    assert.equal(bindingLine.slice(call.position.character), 'setup);');
    assert.equal(app.shown.at(-1).uri.fsPath, definitionUri.fsPath);
    assert.equal(app.shown.at(-1).selection.start.line, 30);
    app.calls.length = 0;
    app.setPick(1);
    await app.implementation(request);
    assert.equal(app.calls.filter((item) => item.name === "vscode.executeDefinitionProvider").length, 0);
    assert.equal(app.shown.at(-1).uri.fsPath, bindingPath);
    const pos = app.shown.at(-1).selection.start;
    assert.equal(projectSource("First").split("\n")[pos.line][pos.character], "[");
    app.setPick(null);
    const previouslyShown = app.shown.length;
    await app.implementation(request);
    assert.equal(app.shown.length, previouslyShown);
    app.setPick(1);
    await app.implementation("from pkg.api import Reader\nReader().|value");
    call = app.calls.findLast((item) => item.name === "vscode.executeDefinitionProvider");
    const line = projectSource("First").split("\n")[call.position.line];
    assert.ok(line.slice(call.position.character).startsWith("set"));
    app.setPick(0);
    app.setDefinition([]);
    await app.implementation(request);
    assert.ok(app.messages.some((message) => message.includes("C++ language service could not find a definition")));
});

test("environment-dependent re-exports show a one-time source-default warning", async (t) => {
    const workspace = await fsp.mkdtemp(path.join(os.tmpdir(), "pybind-warning-"));
    t.after(() => fsp.rm(workspace, { recursive: true, force: true }));
    const wrapper = path.join(workspace, "api.py");
    await fsp.writeFile(path.join(workspace, "bindings.cpp"), projectSource("First"));
    await fsp.writeFile(wrapper, `import os\nif os.getenv("BACKEND", "cpp") == "cpp":\n    from pkg._core import Reader\n`);
    const app = harness(workspace, { pythonWrappers: { "pkg.api": wrapper } });
    t.after(app.dispose);
    const request = "from pkg.api import Reader\nReader().|setup()";
    assert.equal((await app.navigate(request)).length, 2);
    assert.equal((await app.navigate(request)).length, 2);
    assert.equal(app.messages.filter((message) => message.includes("runtime environment may select")).length, 2);
    // One log entry and one visible warning; repeated navigation does not warn again.
});
