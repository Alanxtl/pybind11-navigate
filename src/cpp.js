// Consume comments, literals and preprocessing directives as units so their
// punctuation cannot interrupt a registration or start a spurious one.
const cppToken = /#(?:\\\r?\n|[^\r\n])*|\s+|\/\/[^\r\n]*|\/\*[\s\S]*?(?:\*\/|$)|(?:u8|[uUL])?R"([^ ()\\\t\r\n]{0,16})\([\s\S]*?\)\1"|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\d(?:[\w.]|'(?=\w))*|[a-zA-Z_]\w*|::|[^]/gm;
const identifier = /^[a-zA-Z_]\w*$/;
const closing = { "(": ")", "{": "}", "[": "]" };

function tokenize(source) {
    const tokens = [];
    const ends = new Map();
    const stack = [];
    for (const match of source.matchAll(cppToken)) {
        const value = match[0];
        if (/^\s*(?:#|\/\/|\/\*|$)/.test(value)) continue;
        const index = tokens.length;
        tokens.push({ value, offset: match.index });
        if (Object.hasOwn(closing, value)) {
            stack.push(index);
        } else if (closing[tokens[stack.at(-1)]?.value] === value) {
            ends.set(stack.pop(), index);
        }
    }
    return { tokens, ends };
}

function decodeExportName(token) {
    // Python export names are typically ordinary string literals. Keep the
    // decoded form for escaped quotes and Unicode escapes where supported.
    if (!token?.startsWith('"')) return undefined;
    try {
        return JSON.parse(token);
    } catch {
        return undefined;
    }
}

function stringArgument(token, separator) {
    if ([",", ")"].includes(separator)) return decodeExportName(token);
}

function* moduleBodies(tokens, ends) {
    const at = (index) => tokens[index]?.value;
    for (let i = 0; i < tokens.length; i++) {
        if (at(i) !== "PYBIND11_MODULE" || at(i + 1) !== "(" || at(i + 3) !== ",") continue;
        const module = at(i + 2);
        const receiver = at(i + 4);
        const body = ends.get(i + 1) + 1;
        const limit = ends.get(body);
        if (identifier.test(module) && identifier.test(receiver) &&
            [",", ")"].includes(at(i + 5)) && at(body) === "{" && limit !== undefined) {
            yield { module, receiver, body, limit };
            i = limit;
        }
    }
}

function moduleRanges(source) {
    if (!source.includes("PYBIND11_MODULE")) return [];
    const { tokens, ends } = tokenize(source);
    return Array.from(moduleBodies(tokens, ends), ({ module, receiver, body, limit }) => ({
        module, receiver, start: tokens[body].offset, end: tokens[limit].offset + 1,
    }));
}

function indexBindings(source) {
    if (!source.includes("PYBIND11_MODULE")) return [];
    const { tokens, ends } = tokenize(source);
    const at = (index) => tokens[index]?.value;
    const aliases = new Set(["py", "pybind11"]);
    const entries = [];
    let line = 0;
    let lineStart = 0;
    let nextLine = source.indexOf("\n");

    function add(module, className, name, kind, token) {
        const { offset } = tokens[token];
        while (nextLine !== -1 && nextLine < offset) {
            line++;
            lineStart = nextLine + 1;
            nextLine = source.indexOf("\n", lineStart);
        }
        entries.push({ module, className, name, kind, line, column: offset - lineStart });
    }

    function chain(start, limit, module, className) {
        let i = start;
        while (i < limit && at(i) === "." && at(i + 2) === "(") {
            const method = at(i + 1);
            if (method !== "def" && !(className && method?.startsWith("def_"))) break;
            const end = ends.get(i + 2);
            if (end === undefined || end >= limit) break;
            const name = stringArgument(at(i + 3), at(i + 4));
            if (name && (method === "def" || method === "def_static")) {
                add(module, className, name, className ? "method" : "function", i + 1);
            }
            i = end + 1;
        }
        return i;
    }

    function moduleBody(start, limit, module, receiver) {
        for (let i = start; i < limit;) {
            if (at(i) === receiver && ![".", "::", ">", "-"].includes(at(i - 1))) {
                const end = chain(i + 1, limit, module, undefined);
                if (end > i + 1) {
                    i = end;
                    continue;
                }
            }
            if (aliases.has(at(i)) && at(i + 1) === "::" && at(i + 2) === "class_" && at(i + 3) === "<") {
                let depth = 1;
                let args = i + 4;
                while (args < limit && depth) {
                    if (at(args) === "<") depth++;
                    if (at(args) === ">") depth--;
                    args = (ends.get(args) ?? args) + 1;
                }
                const end = ends.get(args);
                if (at(args) === "(" && end < limit && at(args + 1) === receiver && at(args + 2) === ",") {
                    const name = stringArgument(at(args + 3), at(args + 4));
                    if (name) {
                        add(module, undefined, name, "class", i + 2);
                        i = chain(end + 1, limit, module, name);
                        continue;
                    }
                }
            }
            // Skip other calls and nested bodies, including lambda bodies.
            i = (ends.get(i) ?? i) + 1;
        }
    }

    for (let i = 0; i < tokens.length; i++) {
        if (at(i) === "namespace" && at(i + 2) === "=" && at(i + 3) === "pybind11" && at(i + 4) === ";") {
            aliases.add(at(i + 1));
        }
    }
    for (const { module, receiver, body, limit } of moduleBodies(tokens, ends)) {
        moduleBody(body + 1, limit, module, receiver);
    }
    return entries;
}

module.exports = { decodeExportName, indexBindings, moduleRanges };
