"""Trace explicit re-exports without importing or executing workspace code."""

import ast
import json
import sys
from dataclasses import dataclass
from importlib.util import resolve_name


@dataclass(frozen=True)
class Import:
    path: tuple[str, ...]

    def attribute(self, name):
        return Import((*self.path, name))


def absolute(name, package):
    try:
        return resolve_name(name, package)
    except ImportError:
        return None


def value(node, scope):
    if isinstance(node, ast.Name):
        return scope.get(node.id)
    if isinstance(node, ast.Constant) and isinstance(node.value, (str, bool)):
        return node.value
    if isinstance(node, ast.Attribute):
        base = value(node.value, scope)
        if isinstance(base, Import):
            return base.attribute(node.attr)
    if isinstance(node, (ast.Set, ast.List, ast.Tuple)):
        items = tuple(value(item, scope) for item in node.elts)
        if all(isinstance(item, str) for item in items):
            return items
    if isinstance(node, ast.Compare) and len(node.ops) == 1:
        left, right = value(node.left, scope), value(node.comparators[0], scope)
        operator = node.ops[0]
        if isinstance(left, str) and isinstance(right, tuple):
            if isinstance(operator, ast.In):
                return left in right
            if isinstance(operator, ast.NotIn):
                return left not in right
        if isinstance(left, str) and isinstance(right, str):
            if isinstance(operator, ast.Eq):
                return left == right
            if isinstance(operator, ast.NotEq):
                return left != right
    if isinstance(node, ast.BoolOp):
        for operand in node.values:
            result = value(operand, scope)
            if not isinstance(result, bool):
                return None
            if result != isinstance(node.op, ast.And):
                return result
        return result
    if isinstance(node, ast.Call) and not node.keywords:
        return call_value(node, scope)
    return None


def call_value(node, scope):
    function = value(node.func, scope)
    args = [value(arg, scope) for arg in node.args]
    if isinstance(function, Import):
        if function.path == ("importlib", "import_module") and 1 <= len(args) <= 2:
            name = args[0]
            package = args[1] if len(args) == 2 else None
            if isinstance(name, str) and (package is None or isinstance(package, str)):
                resolved = absolute(name, package)
                parts = tuple(resolved.split(".")) if resolved else ()
                if parts and all(part.isidentifier() for part in parts):
                    return Import(parts)
        if (
            function.path in {("os", "environ", "get"), ("os", "getenv")}
            and len(args) == 2
            and all(isinstance(arg, str) for arg in args)
        ):
            # Use the source-declared default. The debuggee may have a
            # different environment from the editor and this subprocess.
            return args[1]
    if isinstance(node.func, ast.Name) and node.func.id not in scope:
        if (
            node.func.id == "frozenset"
            and len(args) == 1
            and isinstance(args[0], tuple)
        ):
            return args[0]
        if node.func.id == "getattr" and len(args) == 2:
            base, name = args
            if isinstance(base, Import) and isinstance(name, str) and name.isidentifier():
                return base.attribute(name)
    return None


def invalidate(statement, scope):
    for node in ast.walk(statement):
        if isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del)):
            scope[node.id] = None
        elif isinstance(node, ast.alias):
            scope[node.asname or node.name.split(".")[0]] = None
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            scope[node.name] = None


FALLTHROUGH = object()


def trace(statements, scope, package, getter=False):
    for stmt in statements:
        if isinstance(stmt, ast.Import):
            for alias in stmt.names:
                path = tuple(alias.name.split("."))
                name = alias.asname or path[0]
                scope[name] = Import(path if alias.asname else path[:1])
        elif isinstance(stmt, ast.ImportFrom):
            module = absolute("." * stmt.level + (stmt.module or ""), package)
            for alias in stmt.names:
                if alias.name == "*":
                    # A star import can bind the requested name even when it
                    # was absent from our scope. Stop tracing this module.
                    return None
                scope[alias.asname or alias.name] = (
                    Import((*module.split("."), alias.name)) if module else None
                )
        elif isinstance(stmt, (ast.Assign, ast.AnnAssign)):
            result = value(stmt.value, scope)
            targets = stmt.targets if isinstance(stmt, ast.Assign) else [stmt.target]
            for target in targets:
                if isinstance(target, ast.Name):
                    if stmt.value is not None:
                        scope[target.id] = result
                else:
                    invalidate(target, scope)
        elif isinstance(stmt, ast.FunctionDef):
            scope[stmt.name] = stmt if stmt.name == "__getattr__" else None
        elif isinstance(stmt, (ast.If, ast.Try)):
            branch = None
            if isinstance(stmt, ast.If):
                condition = value(stmt.test, scope)
                if isinstance(condition, bool):
                    branch = stmt.body if condition else stmt.orelse
            elif not stmt.finalbody and all(
                handler.body and isinstance(handler.body[-1], ast.Raise)
                for handler in stmt.handlers
            ):
                branch = stmt.body + stmt.orelse
            if branch is None:
                if getter:
                    return None
                invalidate(stmt, scope)
            else:
                result = trace(branch, scope, package, getter)
                if result is not FALLTHROUGH:
                    return result
        elif isinstance(stmt, ast.Return):
            return value(stmt.value, scope)
        elif isinstance(stmt, ast.Raise):
            return None
        else:
            invalidate(stmt, scope)
    return FALLTHROUGH


def reexport(source, module, is_package, name):
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return None
    package = module if is_package else module.rpartition(".")[0]
    scope = {"__package__": package}
    if trace(tree.body, scope, package) is not FALLTHROUGH:
        return None
    target = scope.get(name)
    if name not in scope:
        getter = scope.get("__getattr__")
        if isinstance(getter, ast.FunctionDef):
            params = getter.args.posonlyargs + getter.args.args
            if len(params) == 1:
                scope[params[0].arg] = name
                target = trace(getter.body, scope, package, getter=True)
    if isinstance(target, Import) and len(target.path) >= 2:
        return {"module": ".".join(target.path[:-1]), "name": target.path[-1]}
    return None


if __name__ == "__main__":
    print(json.dumps(reexport(*json.load(sys.stdin))))
