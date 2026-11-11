const { bindingKey } = require("./navigation");

function moduleFromPath(path, moduleMap) {
    if (!/\.pyi?$/.test(path)) return undefined;
    const modulePath = path.replace(/\.pyi?$/, "").replace(/\/__init__$/, "");
    const mapped = Object.keys(moduleMap)
        .filter((name) => modulePath.endsWith("/" + name.replaceAll(".", "/")))
        .sort((a, b) => b.length - a.length);
    if (mapped.length) return moduleMap[mapped[0]];
    if (path.endsWith(".pyi")) return modulePath.split("/").at(-1);
    return undefined;
}

function startsAt(range, position) {
    return range?.start.line === position.line && range.start.character === position.character;
}

async function typeDefinitionBindings(vscode, document, query, moduleMap, index, token) {
    if (!query.receiver || !vscode.commands || token.isCancellationRequested) return undefined;
    const [line, byteColumn] = query.receiver;
    const text = document.lineAt(line).text;
    const character = Buffer.from(text).subarray(0, byteColumn).toString("utf8").length;
    const locations = await vscode.commands.executeCommand(
        "vscode.executeTypeDefinitionProvider", document.uri, new vscode.Position(line, character)
    );
    if (token.isCancellationRequested || !locations?.length) return undefined;

    const targets = new Map();
    for (const location of locations) {
        const uri = location.targetUri ?? location.uri;
        const range = location.targetSelectionRange ?? location.range;
        if (!uri || !range) return undefined;
        targets.set(JSON.stringify([uri.toString(), range.start.line, range.start.character]), { uri, range });
    }
    // Distinct declarations may be members of a union. Do not choose one
    // just because it happens to appear in the C++ index.
    if (targets.size !== 1) return [];
    const [{ uri, range }] = targets.values();
    const module = moduleFromPath(uri.path, moduleMap);
    if (!module) return undefined;

    const symbols = await vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", uri);
    if (token.isCancellationRequested) return undefined;
    const declaration = symbols?.find((symbol) => {
        if (symbol.kind !== vscode.SymbolKind.Class) return false;
        if (symbol.selectionRange) {
            return symbol.selectionRange.contains(range.start) || startsAt(symbol.range, range.start);
        }
        return startsAt(symbol.location?.range, range.start);
    });
    if (!declaration || !index.get(bindingKey(module, undefined, declaration.name, "class"))?.length) {
        return undefined;
    }
    return index.get(bindingKey(module, declaration.name, query.member, "method")) ?? [];
}

module.exports = { typeDefinitionBindings };
