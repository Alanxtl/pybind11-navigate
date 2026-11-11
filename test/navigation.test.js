const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { indexBindings } = require("../src/cpp");
const { activate } = require("../src/extension");
const { findBindings, groupBindings, pythonQuery } = require("../src/navigation");
const clangdAst = require("./minimal-clangd-ast.json");

const example = path.join(__dirname, "../examples/minimal");
const cpp = fs.readFileSync(path.join(example, "bindings.cpp"), "utf8");
const demo = fs.readFileSync(path.join(example, "demo.py"), "utf8");
const python = process.env.PYBIND11_TEST_PYTHON || (process.platform === "win32" ? "python" : "python3");
const index = groupBindings([{ uri: "bindings.cpp", entries: indexBindings(cpp) }]);

function registration(source, snippet) {
    const lines = source.split("\n");
    const line = lines.findIndex((text) => text.includes(snippet));
    assert.notEqual(line, -1, snippet);
    return line;
}

async function navigate(marked, moduleMap = {}, bindings = index) {
    const [before, after] = marked.split("|");
    assert.notEqual(after, undefined, marked);
    const lines = before.split("\n");
    const query = await pythonQuery(python, before + after, lines.length, Buffer.byteLength(lines.at(-1)));
    return findBindings(query?.symbol, moduleMap, bindings);
}

function mark(source, snippet, name) {
    const start = source.indexOf(snippet);
    const offset = start + snippet.indexOf(name);
    assert.ok(start >= 0 && snippet.includes(name), snippet);
    return source.slice(0, offset) + "|" + source.slice(offset);
}

test("C++ index records multiline registrations, lambda and pointer overloads", () => {
    const entries = indexBindings(cpp);
    assert.deepEqual(entries.map(({ module, className, name, kind }) => [module, className, name, kind]), [
        ["_navigation_example", undefined, "twice", "function"],
        ["_navigation_example", undefined, "Reader", "class"],
        ["_navigation_example", "Reader", "setup", "method"],
        ["_navigation_example", "Reader", "setup", "method"],
        ["_navigation_example", undefined, "Writer", "class"],
        ["_navigation_example", "Writer", "setup", "method"],
    ]);
    for (const { kind, line, column } of entries) {
        const target = cpp.split("\n")[line].slice(column);
        assert.match(target, kind === "class" ? /^class_</ : /^def\(/);
    }
});

test("C++ index ignores lookalikes in comments, raw strings, macros and lambda bodies", () => {
    const source = String.raw`
        // PYBIND11_MODULE(fake, m) { m.def("fake", f); }
        #define REGISTER(x) \
            PYBIND11_MODULE(fake, m) { m.def("fake", f); }
        /* PYBIND11_MODULE(fake, m) { m.def("fake", f); } */
        auto text = R"raw(PYBIND11_MODULE(fake, m) { m.def("fake", f); })raw";
        PYBIND11_MODULE(first, root, py::mod_gil_not_used()) {
            py::class_<Type<std::pair<int, double>>>(root, "Thing")
                .def("method", [root] {
                    root.def("nested", other);
                    return 1'000;
                })
                .def_property_readonly("property", &Type::property)
                .def_static("static_method", other);
            root.attr("sub").def("foreign", other);
            root.def("function", other);
        }
        PYBIND11_MODULE(second, root) {
            root.def("function", other);
        }`;
    assert.deepEqual(indexBindings(source).map(({ module, name }) => [module, name]), [
        ["first", "Thing"],
        ["first", "method"],
        ["first", "static_method"],
        ["first", "function"],
        ["second", "function"],
    ]);
});

test("Python resolves module function, imported function alias and class alias", async () => {
    const cases = [
        ["native.twice(3)", "twice", "function", "twice"],
        ["double(4)", "double", "function", "twice"],
        ["reader = Input()", "Input", "class", "Reader"],
        ["import Reader as Input", "Reader", "class", "Reader"],
        ["writer: native.Writer", "Writer", "class", "Writer"],
    ];
    for (const [snippet, selection, kind, name] of cases) {
        const hits = await navigate(mark(demo, snippet, selection));
        assert.deepEqual(hits.map((hit) => [hit.kind, hit.name]), [[kind, name]]);
    }
});

test("Python resolves constructor and annotation receivers to the correct setup overloads", async () => {
    const reader = await navigate(mark(demo, "reader.setup()", "setup"));
    assert.deepEqual(reader.map(({ className, line }) => [className, line]), [
        ["Reader", registration(cpp, '.def("setup", static_cast')],
        ["Reader", registration(cpp, '"setup", [](Reader')],
    ]);
    for (const snippet of ["Writer().setup()", "writer.setup()"]) {
        const writer = await navigate(mark(demo, snippet, "setup"));
        assert.deepEqual(writer.map(({ className, line }) => [className, line]), [
            ["Writer", registration(cpp, '.def("setup", &Writer::setup)')],
        ]);
    }
    assert.deepEqual(await navigate(mark(demo, "value.setup()", "setup")), []);
});

test("Python handles dotted imports, package aliases, explicit mappings and UTF-8 offsets", async () => {
    const cases = [
        ["import package._navigation_example\npackage._navigation_example.Reader().|setup()", {}],
        ["from package import _navigation_example as ext\nreader = ext.Reader()\nreader.|setup()", {}],
        ["from package.wrapper import Reader as R\nréader: 'R' = unknown()\nréader.|setup()", {
            "package.wrapper": "_navigation_example",
        }],
        ["import package.wrapper as ext\nreader: ext.Reader\nreader = factory()\nreader.|setup()", {
            "package.wrapper": "_navigation_example",
        }],
        ["from _navigation_example import Reader\nreader = Reader(\n)\n(reader\n    .|setup)()", {}],
    ];
    for (const [source, mapping] of cases) {
        assert.deepEqual((await navigate(source, mapping)).map((hit) => hit.className), ["Reader", "Reader"]);
    }
    const override = { "package._navigation_example": "different_module" };
    assert.deepEqual(await navigate(cases[0][0], override), []);
});

test("Python leaves unknown or shadowed receivers unresolved", async () => {
    const cases = [
        "reader = make_reader()\nreader.|setup()",
        "reader = Reader()\nreader = make_reader()\nreader.|setup()",
        "reader = Reader()\ndef f(reader):\n    reader.|setup()",
        "def f(*readers: Reader):\n    readers.|setup()",
        "reader = Reader()\ndef f():\n    reader.|setup()\n    reader = unrelated()",
        "reader = Reader()\nif condition:\n    reader = unrelated()\nreader.|setup()",
        "Reader = unrelated\nReader().|setup()",
        "def f(Reader):\n    Reader().|setup()",
        "reader = Reader()\nreader.other.|setup()",
        "reader = Reader()\n# reader.|setup()",
        'reader = Reader()\n"reader.|setup()"',
    ];
    for (const body of cases) {
        assert.deepEqual(await navigate("from _navigation_example import Reader\n" + body), [], body);
    }
});

test("DefinitionProvider uses clangd and falls back on save when the AST cannot be used", async () => {
    const folder = { uri: "/workspace" };
    const cppUri = {
        path: "/workspace/bindings.cpp",
        toString: () => "file:///workspace/bindings.cpp",
    };
    const pythonUri = "/workspace/demo.py";
    const stubUri = {
        path: "/workspace/package/wrapper/__init__.pyi",
        toString: () => "file:///workspace/package/wrapper/__init__.pyi",
    };
    const context = { subscriptions: [] };
    const disposable = { dispose() {} };
    const noopEvent = () => disposable;
    const content = new Map([[cppUri, cpp]]);
    const messages = [];
    const readerPosition = { line: 0, character: 6 };
    const writerPosition = { line: 4, character: 6 };
    let types = [writerPosition];
    let onSave;
    let provider;
    const vscode = {
        RelativePattern: class {
            constructor(base, pattern) { Object.assign(this, { base, pattern }); }
        },
        Position: class {
            constructor(line, character) { Object.assign(this, { line, character }); }
        },
        Location: class {
            constructor(uri, position) { Object.assign(this, { uri, position }); }
        },
        Range: class {
            constructor(start, end) { Object.assign(this, { start, end }); }
        },
        CancellationTokenSource: class {
            token = { isCancellationRequested: false };
            cancel() { this.token.isCancellationRequested = true; }
            dispose() {}
        },
        SymbolKind: { Class: 4 },
        window: { createOutputChannel: () => ({ ...disposable, appendLine: (msg) => messages.push(msg) }) },
        extensions: {
            getExtension(id) {
                assert.equal(id, "llvm-vs-code-extensions.vscode-clangd");
                return {
                    isActive: true,
                    exports: { getApi(version) {
                        assert.equal(version, 1);
                        return { languageClient: {
                            initializeResult: { capabilities: { astProvider: true } },
                            code2ProtocolConverter: {
                                asTextDocumentIdentifier: (document) => ({ uri: document.uri.toString() }),
                                asRange: (range) => range,
                            },
                            async sendRequest(method, params) {
                                assert.equal(method, "textDocument/ast");
                                assert.equal(params.textDocument.uri, cppUri.toString());
                                if (content.get(cppUri) !== cpp) return null;
                                assert.deepEqual(params.range.start, clangdAst.range.start);
                                assert.deepEqual(params.range.end, clangdAst.range.end);
                                return clangdAst;
                            },
                        } };
                    } },
                };
            },
        },
        commands: {
            async executeCommand(command, uri, position) {
                if (command === "vscode.executeTypeDefinitionProvider") {
                    assert.equal(uri, pythonUri);
                    if (position.line === 1 && position.character === 0) return [];
                    assert.deepEqual([position.line, position.character], [
                        registration(demo, "assert generated.setup()"), "assert ".length,
                    ]);
                    return types.map((start) => ({ targetUri: stubUri, targetSelectionRange: { start } }));
                }
                assert.equal(command, "vscode.executeDocumentSymbolProvider");
                assert.equal(uri, stubUri);
                return [["Reader", readerPosition], ["Writer", writerPosition]].map(([name, position]) => ({
                    name,
                    kind: vscode.SymbolKind.Class,
                    selectionRange: { contains: (start) => start === position },
                }));
            },
        },
        workspace: {
            workspaceFolders: [folder],
            getWorkspaceFolder: () => folder,
            getConfiguration: () => ({ get: (key, fallback) => ({
                include: "**/*.cpp", pythonPath: python,
                moduleMap: { "package.wrapper": "_navigation_example" },
            })[key] ?? fallback }),
            createFileSystemWatcher: () => ({
                ...disposable, onDidCreate: noopEvent, onDidDelete: noopEvent, onDidChange: noopEvent,
            }),
            findFiles: async (include) => {
                assert.equal(include.pattern, "**/*.cpp");
                return [...content.keys()];
            },
            fs: { readFile: async (uri) => Buffer.from(content.get(uri)) },
            async openTextDocument(uri) {
                const source = content.get(uri);
                const lines = source.split("\n");
                return {
                    uri,
                    version: 1,
                    getText: () => source,
                    lineAt: (line) => ({ text: lines[line] }),
                    positionAt(offset) {
                        const before = source.slice(0, offset).split("\n");
                        return { line: before.length - 1, character: before.at(-1).length };
                    },
                };
            },
            onDidChangeWorkspaceFolders: noopEvent,
            onDidChangeConfiguration: noopEvent,
            onDidSaveTextDocument: (listener) => { onSave = listener; return disposable; },
        },
        languages: {
            registerDefinitionProvider: (selector, definitionProvider) => {
                assert.equal(selector.language, "python");
                provider = definitionProvider;
                return disposable;
            },
        },
    };
    activate(context, vscode);
    try {
        function definition(marked) {
            const [before, after] = marked.split("|");
            const source = before + after;
            const lines = before.split("\n");
            return provider.provideDefinition({
                uri: pythonUri,
                version: 1,
                getText: () => source,
                lineAt: (line) => ({ text: source.split("\n")[line] }),
            }, { line: lines.length - 1, character: lines.at(-1).length }, {
                isCancellationRequested: false, onCancellationRequested: noopEvent,
            });
        }
        const twice = "import _navigation_example as native\nnative.|twice(3)";
        const [first] = await definition(twice);
        assert.equal(first.uri, cppUri);
        assert.equal(first.position.line, registration(cpp, 'module.def("twice"'));
        assert.deepEqual(messages, ["Indexed with clangd: /workspace/bindings.cpp"]);

        // The AST-only Python lookup cannot infer the factory's return type.
        const factoryCall = mark(demo, "generated.setup()", "setup");
        assert.deepEqual(await navigate(factoryCall), []);
        const writer = await definition(factoryCall);
        assert.deepEqual(writer.map(({ position }) => position.line), [
            registration(cpp, '.def("setup", &Writer::setup)'),
        ]);
        types = [readerPosition];
        const reader = await definition(factoryCall);
        assert.deepEqual(reader.map(({ position }) => position.line), [
            registration(cpp, '.def("setup", static_cast'),
            registration(cpp, '"setup", [](Reader'),
        ]);
        types = [readerPosition, writerPosition];
        assert.deepEqual(await definition(factoryCall), []);

        content.set(cppUri, "\n" + cpp.replace('module.def("twice"', 'module.def("thrice"'));
        onSave({ uri: cppUri });
        assert.deepEqual(await definition(twice), []);
        const [updated] = await definition(twice.replace("twice", "thrice"));
        assert.equal(updated.uri, cppUri);
        assert.equal(updated.position.line, first.position.line + 1);
        assert.deepEqual(messages, [
            "Indexed with clangd: /workspace/bindings.cpp",
            "clangd AST unavailable, using source: /workspace/bindings.cpp",
        ]);
    } finally {
        context.subscriptions.forEach((subscription) => subscription.dispose());
    }
});
