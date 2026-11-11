const { spawn } = require("node:child_process");
const path = require("node:path");

const helper = path.join(__dirname, "python_symbols.py");

function pythonQuery(executable, source, line, byteColumn, signal) {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, ["-I", "-X", "utf8", helper], {
            signal,
            timeout: 5000,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
        });
        let output = "";
        let errors = "";
        child.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
        child.stderr.setEncoding("utf8").on("data", (chunk) => { errors += chunk; });
        child.on("error", reject);
        child.on("close", (code) => {
            if (code !== 0) {
                reject(new Error(errors.trim() || `Python parser exited with code ${code}`));
                return;
            }
            try {
                resolve(JSON.parse(output));
            } catch (error) {
                reject(error);
            }
        });
        // A canceled or failed process can close stdin before reading the source.
        child.stdin.on("error", reject);
        child.stdin.end(JSON.stringify([source, line, byteColumn]));
    });
}

function bindingKey(module, className, name, kind) {
    return JSON.stringify([module, className, name, kind]);
}

function groupBindings(files) {
    const index = new Map();
    for (const { uri, entries } of files) {
        for (const entry of entries) {
            const key = bindingKey(entry.module, entry.className, entry.name, entry.kind);
            const matches = index.get(key);
            const location = { uri, ...entry };
            if (matches) matches.push(location);
            else index.set(key, [location]);
        }
    }
    return index;
}

function findBindings(symbol, moduleMap, index) {
    if (!symbol) return [];
    const parts = symbol.path;
    const pythonModule = (size) => parts.slice(0, size).join(".");
    const mapped = (size) => Object.hasOwn(moduleMap, pythonModule(size));
    const nativeModule = (size) => mapped(size) ? moduleMap[pythonModule(size)] : parts[size - 1];
    if (symbol.instance) {
        if (!symbol.member || parts.length <= symbol.moduleParts) return [];
        const key = bindingKey(nativeModule(parts.length - 1), parts.at(-1), symbol.member, "method");
        return index.get(key) ?? [];
    }
    const sizes = [parts.length - 1, parts.length - 2].filter((size) => size >= symbol.moduleParts);
    // Prefer an explicit mapping, then an indexed class member, then a
    // module-level export. An import path cannot cross a known module boundary.
    const explicit = sizes.find(mapped);
    for (const size of explicit === undefined ? sizes.reverse() : [explicit]) {
        const module = nativeModule(size);
        const [first, second] = parts.slice(size);
        const classes = index.get(bindingKey(module, undefined, first, "class")) ?? [];
        if (!second) return [...classes, ...(index.get(bindingKey(module, undefined, first, "function")) ?? [])];
        if (classes.length) return index.get(bindingKey(module, first, second, "method")) ?? [];
    }
    return [];
}

module.exports = { bindingKey, findBindings, groupBindings, pythonQuery };
