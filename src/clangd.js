const { decodeExportName, moduleRanges } = require("./cpp");

const wrappers = new Set([
    "ExprWithCleanups", "MaterializeTemporary", "CXXBindTemporary", "ImplicitCast", "Paren",
]);
const clangdExtension = "llvm-vs-code-extensions.vscode-clangd";

function expressions(node) {
    return node?.children?.filter((child) => child.role === "expression") ?? [];
}

function unwrap(node) {
    while (wrappers.has(node?.kind)) [node] = expressions(node);
    return node;
}

function hasRecovery(body) {
    const pending = [body];
    while (pending.length) {
        const node = pending.pop();
        if (node.kind === "Recovery") return true;
        for (const child of node.children ?? []) pending.push(child);
    }
    return false;
}

function positionEquals(a, b) {
    return a?.line === b.line && a.character === b.character;
}

function indexModuleAst(document, ast, { module, receiver, start }) {
    const body = ast?.kind === "Function" ? ast.children?.find((node) => node.kind === "Compound") : ast;
    if (body?.kind !== "Compound" || !positionEquals(body.range?.start, document.positionAt(start)) ||
        hasRecovery(body)) return undefined;

    const entries = [];
    const moduleOwner = { className: undefined };
    const isModule = (node) => node?.kind === "DeclRef" && node.detail === receiver &&
        node.arcana?.includes("pybind11::module_");
    function literal(node) {
        const value = unwrap(node);
        if (value?.kind !== "StringLiteral" || !value.range) return undefined;
        const { start, end } = value.range;
        if (start.line !== end.line) return undefined;
        const text = document.lineAt(start.line).text.slice(start.character, end.character);
        return decodeExportName(text);
    }

    function add(position, name, kind, className) {
        if (!position || !name) return;
        entries.push({ module, name, kind, className, line: position.line, column: position.character });
    }

    // Follow only the receiver side of a fluent call chain. Arguments can
    // contain unrelated calls, including code inside a registration lambda.
    function owner(expression) {
        const node = unwrap(expression);
        if (isModule(node)) return moduleOwner;
        const [first, second] = expressions(node);
        if (node?.kind === "CXXMemberCall" && first?.kind === "Member") {
            const method = first.detail;
            if (method !== "def" && !method?.startsWith("def_")) return undefined;
            const base = owner(expressions(first)[0]);
            if (!base || (base === moduleOwner && method !== "def")) return undefined;
            if (method === "def" || method === "def_static") {
                const end = first.range?.end;
                const position = end && { line: end.line, character: end.character - method.length };
                add(position, literal(second), base.className ? "method" : "function", base.className);
            }
            return base;
        }
        if (node?.kind === "CXXFunctionalCast") return owner(first);
        if (["CXXTemporaryObject", "CXXConstruct"].includes(node?.kind) &&
            node.arcana?.includes("pybind11::class_<")) {
            let handle = unwrap(first);
            if (handle?.kind === "CXXConstruct" && handle.detail === "handle") {
                handle = unwrap(expressions(handle)[0]);
            }
            const className = literal(second);
            if (!isModule(handle) || !className) return undefined;
            const type = node.children.find((child) => child.role === "type");
            const template = type?.children?.find((child) => child.kind === "TemplateSpecialization");
            add(template?.range?.start ?? node.range?.start, className, "class");
            return { className };
        }
        return undefined;
    }

    for (const expression of expressions(body)) owner(expression);
    return entries;
}

function serverCapabilities(client, token) {
    if (client.initializeResult || token.isCancellationRequested) {
        return Promise.resolve(client.initializeResult?.capabilities);
    }
    // clangd's extension can export the client before it has finished starting.
    return new Promise((resolve) => {
        const state = client.onDidChangeState(() => {
            if (client.initializeResult) finish(client.initializeResult.capabilities);
        });
        const cancellation = token.onCancellationRequested(() => finish(undefined));
        function finish(capabilities) {
            state.dispose();
            cancellation.dispose();
            resolve(capabilities);
        }
    });
}

async function indexWithClangd(vscode, uri, source, log) {
    const extension = vscode.extensions?.getExtension(clangdExtension);
    if (!extension || !source.includes("PYBIND11_MODULE")) return undefined;
    const modules = moduleRanges(source);
    if (!modules.length) return undefined;
    const cancellation = new vscode.CancellationTokenSource();
    let timer;
    try {
        const astIndex = async () => {
            const api = extension.isActive ? extension.exports : await extension.activate();
            const client = api?.getApi?.(1)?.languageClient;
            if (!client || cancellation.token.isCancellationRequested) return undefined;
            const capabilities = await serverCapabilities(client, cancellation.token);
            if (!capabilities?.astProvider) return undefined;
            const document = await vscode.workspace.openTextDocument(uri);
            if (document.getText() !== source) return undefined;
            const version = document.version;
            const converter = client.code2ProtocolConverter;
            const entries = [];
            for (const module of modules) {
                if (cancellation.token.isCancellationRequested) return undefined;
                const range = new vscode.Range(document.positionAt(module.start), document.positionAt(module.end));
                const ast = await client.sendRequest("textDocument/ast", {
                    textDocument: converter.asTextDocumentIdentifier(document),
                    range: converter.asRange(range),
                }, cancellation.token);
                if (document.version !== version) return undefined;
                const bindings = indexModuleAst(document, ast, module);
                if (!bindings) return undefined;
                entries.push(...bindings);
            }
            return entries;
        };
        const timeout = new Promise((resolve) => {
            timer = setTimeout(() => {
                cancellation.cancel();
                resolve(undefined);
            }, 10000);
        });
        const entries = await Promise.race([astIndex(), timeout]);
        log.appendLine(entries ? `Indexed with clangd: ${uri.path}` : `clangd AST unavailable, using source: ${uri.path}`);
        return entries;
    } catch (error) {
        log.appendLine(`clangd AST unavailable for ${uri.path}: ${error}`);
        return undefined;
    } finally {
        clearTimeout(timer);
        cancellation.dispose();
    }
}

module.exports = { indexModuleAst, indexWithClangd };
