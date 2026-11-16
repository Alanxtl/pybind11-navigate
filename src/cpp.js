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
    const lineStarts = [0];
    for (let offset = source.indexOf("\n"); offset !== -1; offset = source.indexOf("\n", offset + 1)) {
        lineStarts.push(offset + 1);
    }

    function position(offset) {
        let low = 0;
        let high = lineStarts.length;
        while (low + 1 < high) {
            const mid = (low + high) >> 1;
            if (lineStarts[mid] <= offset) low = mid;
            else high = mid;
        }
        return { line: low, column: offset - lineStarts[low] };
    }

    function add(module, className, name, kind, offset, extra = {}) {
        entries.push({ module, className, name, kind, ...position(offset), ...extra });
    }

    // Find the end of one argument without splitting template argument lists
    // or calls nested inside a cast. Braces and lambdas are skipped as units.
    function argumentEnd(start, limit) {
        let depth = 0;
        for (let i = start; i < limit; i++) {
            if (at(i) === "<") depth++;
            else if (at(i) === ">" && depth) depth--;
            else if (at(i) === "," && !depth) return i;
            if (ends.has(i)) i = ends.get(i);
        }
        return limit;
    }

    function implementation(start, limit) {
        if (at(start) === "[") return { kind: "lambda", ...position(tokens[start].offset) };
        // Search through casts/overload_cast, but ignore lambda bodies. The
        // last address expression is the callable in common pybind11 forms.
        let target;
        for (let i = start; i < limit; i++) {
            if (at(i) === "[" || at(i) === "{") {
                i = ends.get(i) ?? i;
                continue;
            }
            if (at(i) !== "&" || !identifier.test(at(i + 1) ?? "")) continue;
            let end = i + 1;
            while (at(end + 1) === "::" && identifier.test(at(end + 2) ?? "")) end += 2;
            target = { kind: "pointer", ...position(tokens[end].offset) };
            i = end;
        }
        return target;
    }

    function chain(start, limit, module, className, viaVariable = false) {
        let i = start;
        while (i < limit && at(i) === "." && at(i + 2) === "(") {
            const method = at(i + 1);
            if (method !== "def" && !(className && method?.startsWith("def_"))) break;
            const end = ends.get(i + 2);
            if (end === undefined || end >= limit) break;
            const name = stringArgument(at(i + 3), at(i + 4));
            if (name && (method === "def" || method === "def_static" ||
                (className && ["def_property", "def_property_readonly", "def_readwrite", "def_readonly"].includes(method)))) {
                const arg = i + 5;
                const argEnd = argumentEnd(arg, end);
                const target = at(i + 4) === "," ? implementation(arg, argEnd) : undefined;
                const setter = method === "def_property" && argEnd < end
                    ? implementation(argEnd + 1, argumentEnd(argEnd + 1, end)) : undefined;
                const targets = [target && { ...target, role: "getter" }, setter && { ...setter, role: "setter" }].filter(Boolean);
                add(module, className, name, className ? "method" : "function", tokens[i + 1].offset,
                    { ...(target ? { implementation: target } : {}),
                        ...(method === "def_property" && targets.length ? { implementations: targets } : {}),
                        ...((viaVariable || method.startsWith("def_property") || method.startsWith("def_read"))
                            ? { extended: true } : {}) });
            }
            i = end + 1;
        }
        return i;
    }

    function moduleBody(start, limit, module, receiver) {
        const classes = new Map();
        const modules = new Map([[receiver, module]]);
        for (let i = start; i < limit;) {
            if (classes.has(at(i)) && ![".", "::", ">", "-"].includes(at(i - 1))) {
                if (at(i + 1) === "=") classes.delete(at(i));
                else {
                    const cls = classes.get(at(i));
                    const end = chain(i + 1, limit, cls.module, cls.name, true);
                    if (end > i + 1) {
                        i = end;
                        continue;
                    }
                }
            }
            if (modules.has(at(i)) && ![".", "::", ">", "-"].includes(at(i - 1))) {
                const native = modules.get(at(i));
                if (at(i + 1) === "=" && at(i) !== receiver) {
                    modules.delete(at(i));
                } else if (at(i + 1) === "." && at(i + 2) === "def_submodule" && at(i + 3) === "(") {
                    const end = ends.get(i + 3);
                    const name = stringArgument(at(i + 4), at(i + 5));
                    const variable = at(i - 1) === "=" && identifier.test(at(i - 2) ?? "") ? at(i - 2) : undefined;
                    if (name && variable && end !== undefined && end < limit) {
                        modules.set(variable, `${native}.${name}`);
                        i = end + 1;
                        continue;
                    }
                }
                const end = chain(i + 1, limit, native, undefined, native !== module);
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
                const variable = identifier.test(at(args) ?? "") && at(args + 1) === "(" ? at(args++) :
                    at(i - 1) === "=" && identifier.test(at(i - 2) ?? "") ? at(i - 2) : undefined;
                const end = ends.get(args);
                const native = modules.get(at(args + 1));
                if (at(args) === "(" && end < limit && native && at(args + 2) === ",") {
                    const name = stringArgument(at(args + 3), at(args + 4));
                    if (name) {
                        add(native, undefined, name, "class", tokens[args + 3].offset + 1,
                            variable || native !== module ? { extended: true } : {});
                        if (variable) classes.set(variable, { module: native, name });
                        i = chain(end + 1, limit, native, name, native !== module);
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
