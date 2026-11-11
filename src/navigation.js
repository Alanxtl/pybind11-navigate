const { spawn } = require("node:child_process");
const path = require("node:path");

const helper = path.join(__dirname, "python_symbols.py");
const reexports = path.join(__dirname, "python_reexports.py");

function parsePython(executable, script, args, signal) {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, ["-I", "-X", "utf8", script], {
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
        child.stdin.end(JSON.stringify(args));
    });
}

function pythonQuery(executable, source, line, byteColumn, signal) {
    return parsePython(executable, helper, [source, line, byteColumn], signal);
}

function pythonReexport(executable, source, module, isPackage, name, signal) {
    return parsePython(executable, reexports, [source, module, isPackage, name], signal);
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

function bindingRequests(symbol, moduleMap) {
    if (!symbol) return [];
    const parts = symbol.path;
    if (symbol.instance && !symbol.member) return [];
    const sizes = symbol.instance ? [parts.length - 1] : [parts.length - 1, parts.length - 2];
    const requests = sizes.filter((size) => size >= symbol.moduleParts).map((size) => ({
        module: parts.slice(0, size).join("."),
        name: parts[size],
        member: symbol.instance ? symbol.member : parts[size + 1],
    }));
    // Prefer an explicit mapping, then an indexed class member, then a
    // module-level export. An import path cannot cross a known module boundary.
    const explicit = requests.find(({ module }) => Object.hasOwn(moduleMap, module));
    return explicit ? [explicit] : requests.reverse();
}

function lookupBindings(request, moduleMap, index) {
    const { module, name, member } = request;
    const native = Object.hasOwn(moduleMap, module) ? moduleMap[module] : module.split(".").at(-1);
    const classes = index.get(bindingKey(native, undefined, name, "class")) ?? [];
    if (member) {
        if (classes.length) return index.get(bindingKey(native, name, member, "method")) ?? [];
    } else {
        return [...classes, ...(index.get(bindingKey(native, undefined, name, "function")) ?? [])];
    }
    return undefined;
}

function findBindings(symbol, moduleMap, index) {
    for (const request of bindingRequests(symbol, moduleMap)) {
        const hits = lookupBindings(request, moduleMap, index);
        if (hits) return hits;
    }
    return [];
}

async function findReexportBindings(symbol, moduleMap, index, resolve) {
    for (const request of bindingRequests(symbol, moduleMap)) {
        const visited = new Set();
        let target = request;
        while (target && !Object.hasOwn(moduleMap, target.module)) {
            const key = JSON.stringify([target.module, target.name]);
            if (visited.has(key)) break;
            visited.add(key);
            target = await resolve(target.module, target.name);
            if (target) {
                const hits = lookupBindings({ ...target, member: request.member }, moduleMap, index);
                if (hits?.length || Object.hasOwn(moduleMap, target.module)) return hits ?? [];
            }
        }
    }
    return [];
}

module.exports = { bindingKey, findBindings, findReexportBindings, groupBindings, pythonQuery, pythonReexport };
