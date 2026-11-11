"""Resolve an editor position to an imported symbol without importing user code."""

import ast
import json
import sys
from dataclasses import dataclass, replace


@dataclass(frozen=True)
class Symbol:
    path: tuple
    module_parts: int
    instance: bool = False
    declared: bool = False
    member: str = ""
    # For "import pkg.sub" only the explicitly imported routes under pkg
    # are known. Aliased imports instead bind the full path directly.
    routes: tuple = ()


def prefix(path, other):
    return path == other[: len(path)]


def reference(node, bindings):
    if isinstance(node, ast.Name):
        return bindings.get(node.id)
    if isinstance(node, ast.Attribute):
        base = reference(node.value, bindings)
        if base and not base.member:
            if base.instance:
                return replace(base, member=node.attr)
            path = (*base.path, node.attr)
            if not base.routes:
                return replace(base, path=path)
            routes = tuple(
                route
                for route in base.routes
                if prefix(path, route) or prefix(route, path)
            )
            if routes:
                module_parts = min(len(path), max(map(len, routes)))
                return replace(
                    base, path=path, module_parts=module_parts, routes=routes
                )
    if isinstance(node, ast.Call):
        target = reference(node.func, bindings)
        if target and not target.instance and not target.member:
            return Symbol(target.path, target.module_parts, instance=True)
    return None


def annotated(node, bindings):
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        try:
            node = ast.parse(node.value, mode="eval").body
        except SyntaxError:
            return None
    if isinstance(node, (ast.Name, ast.Attribute)):
        target = reference(node, bindings)
        if target and not target.instance and not target.member:
            return replace(target, instance=True, declared=True)
    return None


class Writes(ast.NodeVisitor):
    """Collect names that may be rebound without descending into new scopes."""

    def __init__(self):
        self.names = set()

    def visit_Name(self, node):
        if isinstance(node.ctx, (ast.Store, ast.Del)):
            self.names.add(node.id)

    def visit_alias(self, node):
        self.names.add(node.asname or node.name.split(".")[0])

    def visit_FunctionDef(self, node):
        self.names.add(node.name)

    visit_AsyncFunctionDef = visit_FunctionDef
    visit_ClassDef = visit_FunctionDef

    def visit_Global(self, node):
        self.names.update(node.names)

    visit_Nonlocal = visit_Global

    def visit_ExceptHandler(self, node):
        if node.name:
            self.names.add(node.name)
        self.generic_visit(node)

    def visit_MatchAs(self, node):
        if node.name:
            self.names.add(node.name)
        self.generic_visit(node)

    visit_MatchStar = visit_MatchAs

    def visit_MatchMapping(self, node):
        if node.rest:
            self.names.add(node.rest)
        self.generic_visit(node)

    def visit_comprehension(self, node):
        self.visit(node.iter)
        for condition in node.ifs:
            self.visit(condition)


def invalidate(bindings, *nodes):
    writes = Writes()
    for node in nodes:
        writes.visit(node)
    bindings.update(dict.fromkeys(writes.names))


def apply(statement, bindings):
    if isinstance(statement, ast.Import):
        for alias in statement.names:
            path = tuple(alias.name.split("."))
            if alias.asname:
                bindings[alias.asname] = Symbol(path, len(path))
            else:
                root = path[0]
                previous = bindings.get(root)
                routes = previous.routes if previous else ()
                bindings[root] = Symbol((root,), 1, routes=(*routes, path))
        return

    if isinstance(statement, ast.ImportFrom):
        for alias in statement.names:
            if alias.name == "*":
                bindings.clear()
            else:
                symbol = None
                if statement.level == 0 and statement.module:
                    module = tuple(statement.module.split("."))
                    symbol = Symbol((*module, alias.name), len(module))
                bindings[alias.asname or alias.name] = symbol
        return

    if isinstance(statement, ast.AnnAssign) and isinstance(statement.target, ast.Name):
        target = statement.target.id
        declared = annotated(statement.annotation, bindings)
        inferred = (
            reference(statement.value, bindings)
            if isinstance(statement.value, ast.Call)
            else None
        )
        invalidate(bindings, statement)
        bindings[target] = declared or inferred
        return

    if isinstance(statement, ast.Assign):
        inferred = (
            reference(statement.value, bindings)
            if isinstance(statement.value, ast.Call)
            else None
        )
        declared = {
            target.id: bindings.get(target.id)
            for target in statement.targets
            if isinstance(target, ast.Name)
        }
        invalidate(bindings, statement)
        for name, previous in declared.items():
            bindings[name] = (
                previous if previous and previous.declared else inferred
            )
        return

    invalidate(bindings, statement)


def parameters(args):
    yield from args.posonlyargs
    yield from args.args
    yield from args.kwonlyargs


def visible_bindings(path):
    bindings = {}
    enclosing_class = None
    for parent, child in zip(path, path[1:]):
        # These expressions introduce scope or can rebind a name partway
        # through the expression. Leave them to the Python language server.
        if isinstance(
            parent,
            (ast.Lambda, ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp),
        ):
            return {}
        for _, suite in ast.iter_fields(parent):
            if not isinstance(suite, list) or child not in suite:
                continue
            if isinstance(
                parent, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)
            ):
                if suite is parent.body:
                    if enclosing_class is not None:
                        bindings = enclosing_class.copy()
                    if isinstance(parent, ast.ClassDef):
                        enclosing_class = bindings.copy()
                    else:
                        enclosing_class = None
                        args = {
                            arg.arg: annotated(arg.annotation, bindings)
                            for arg in parameters(parent.args)
                        }
                        for arg in (parent.args.vararg, parent.args.kwarg):
                            if arg:
                                args[arg.arg] = None
                        # Python treats names assigned anywhere in a function
                        # as local, even before their first assignment.
                        invalidate(bindings, *suite)
                        bindings.update(args)
            elif not isinstance(parent, ast.Module):
                # A loop iteration, branch or handler may have changed a name.
                invalidate(bindings, parent)
            for statement in suite[: suite.index(child)]:
                if isinstance(statement, ast.stmt):
                    apply(statement, bindings)
            break
        else:
            if isinstance(parent, ast.stmt):
                # Walrus assignments in a statement can change a receiver
                # before a later expression in the same statement.
                for expr in ast.walk(parent):
                    if isinstance(expr, ast.NamedExpr):
                        invalidate(bindings, expr)
    return bindings


def selected(node, line, column):
    if isinstance(node, ast.Attribute) and isinstance(node.ctx, ast.Load):
        start = node.end_col_offset - len(node.attr.encode("utf-8"))
        return line == node.end_lineno and start <= column < node.end_col_offset
    if isinstance(node, (ast.Name, ast.alias)):
        return (
            (isinstance(node, ast.alias) or isinstance(node.ctx, ast.Load))
            and (node.lineno, node.col_offset)
            <= (line, column)
            < (node.end_lineno, node.end_col_offset)
        )
    return False


def symbol_data(symbol):
    if symbol:
        return {
            "path": symbol.path,
            "moduleParts": symbol.module_parts,
            "instance": symbol.instance,
            "member": symbol.member,
        }
    return None


def query(source, line, column):
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return None
    parents = {
        child: node for node in ast.walk(tree) for child in ast.iter_child_nodes(node)
    }
    for node in parents:
        if not selected(node, line, column):
            continue
        if isinstance(node, ast.alias):
            parent = parents[node]
            if isinstance(parent, ast.ImportFrom) and parent.level == 0:
                module = tuple(parent.module.split("."))
                return {"symbol": symbol_data(Symbol((*module, node.name), len(module)))}
            return None
        path = [node]
        while path[-1] in parents:
            path.append(parents[path[-1]])
        symbol = reference(node, visible_bindings(list(reversed(path))))
        result = {"symbol": symbol_data(symbol)}
        if isinstance(node, ast.Attribute) and isinstance(
            node.value, (ast.Name, ast.Attribute)
        ):
            receiver = node.value
            name = receiver.attr if isinstance(receiver, ast.Attribute) else receiver.id
            result["member"] = node.attr
            result["receiver"] = [
                receiver.end_lineno - 1,
                receiver.end_col_offset - len(name.encode("utf-8")),
            ]
        return result
    return None


if __name__ == "__main__":
    print(json.dumps(query(*json.load(sys.stdin))))
