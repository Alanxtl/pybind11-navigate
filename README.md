# pybind11 Navigate

github: https://github.com/Alanxtl/pybind11-navigate

vscode marketplace: https://marketplace.visualstudio.com/items?itemName=XuetaoLi.pybind11-navigate

Use **Go to Definition** in Python to open the C++ registration of a pybind11
class, module function or method. The extension returns every registration of
an overloaded name. VS Code may display Pylance stub locations alongside the
C++ locations.

## Run in VS Code

1. Open the `pybind11-navigate` folder itself in VS Code Desktop. Use VS Code
   1.85 or newer and Python 3.10 or newer on the host running the extension.
2. In **Run and Debug**, select **pybind11 Navigate — minimal example** and
   press **F5**. VS Code opens the example workspace in an Extension
   Development Host. Trust the example workspace when prompted.
3. Open `demo.py` in that host. Put the cursor on a symbol and press **F12**,
   or use **Ctrl+click** with the default Windows/Linux settings (**Cmd+click**
   on macOS).

For details on the Extension Development Host, see the
[VS Code extension testing guide](https://code.visualstudio.com/api/working-with-extensions/testing-extension).

The extension has no npm dependencies or build step. It parses Python source
using the standard library AST and does not import the project. Set
`pybind11Navigation.pythonPath` in User Settings if `python3` (or `python` on
Windows) is unavailable on the extension host's PATH. Parser and indexing errors
appear in **Output → pybind11 Navigate**.

## Language services

- With the clangd extension installed, the index requests `textDocument/ast`
  for each `PYBIND11_MODULE` body and extracts the registered names and
  source positions from the AST. Give clangd your project's compile flags,
  usually through `compile_commands.json`. The output channel reports
  `Indexed with clangd` for files indexed this way. If clangd is unavailable
  or cannot parse the binding body, the extension uses the source index.
  Set `pybind11Navigation.useClangd` to `false` to select source indexing.
  [clangd project setup](https://clangd.llvm.org/installation#project-setup)
- With Pylance or another Python type-definition provider, the extension can
  resolve a receiver through its class declaration. A class in a `.pyi`
  can match by module basename. The module map also matches the full module
  path of a declaration in a stub or Python wrapper. When the service provides
  no usable declaration, the extension uses the Python AST lookup. Multiple
  distinct type targets produce no C++ result.
  [VS Code language-provider commands](https://code.visualstudio.com/api/references/commands)

To open your own project in the development host from the extension directory:

```sh
code --extensionDevelopmentPath="$PWD" /path/to/project
```

## Configure a project

Set the index globs and import mappings in your workspace settings as needed.

```json
{
  "pybind11Navigation.include": "{bindings,src}/**/*.{cc,cpp,hpp}",
  "pybind11Navigation.exclude": "{**/build/**,**/vendor/**}",
  "pybind11Navigation.moduleMap": {
    "acme.api": "_core",
    "acme.internal.native": "_core"
  }
}
```

The extension first checks the native module name. It can then trace
re-exports through workspace Python modules and packages, including relative
imports, aliases, and `__getattr__` forwarding to a literal
`importlib.import_module` target. For a backend selected through
`os.getenv` or `os.environ.get`, it follows the source-declared default.
The extension reads the wrapper source without importing it. If it cannot
identify a unique wrapper file or trace the export statically, set a module
map. Explicit mappings take precedence and use full Python import paths.
The configuration above directs both `from acme.api import Widget` and
`import acme.internal.native as native` to registrations in `_core`.
The include and exclude globs are relative to each workspace folder. Existing
binding files are reindexed on save. Creation and deletion refresh the file
list.

The C++ index supports direct `PYBIND11_MODULE` bodies, class construction
expressions with chained `.def(...)`, and module-level `m.def(...)` with literal
export names. The Python AST fallback uses absolute imports, aliases, direct
constructor calls and simple local or parameter annotations. Receivers whose
type is unresolved produce no C++ result. This version requires syntactically
valid Python. C++ binding helpers, macro-generated bindings, arbitrary
dynamic Python exports, and C++ function bodies are outside its scope.

## Verify

Run the automated indexing and matching tests with Node.js 18+ and Python 3.10+.

```sh
npm test
```

The tests cover the independent example and exercise both language-service
interfaces and save handling with a VS Code API stub.

For a manual pass in the **minimal example** development host:

| Select in `demo.py` | Expected C++ registrations |
| --- | --- |
| `native.twice` or `double` | One module-level `twice` |
| `Input` in `Input()` | One `Reader` class |
| `reader.setup` | Both `Reader.setup` overloads |
| `writer.setup` or `Writer().setup` | Only `Writer.setup` |
| `value.setup` | No C++ definition |
| `generated.setup` with a Python type-definition provider | Only `Writer.setup`, resolved through the factory's return type |

To check reindexing, rename `"twice"` in `bindings.cpp` and save the file.
Navigation to the old name should stop returning a C++ result. Undo and save
to restore it.

The navigation check requires only source files. To run the standalone example
as Python on Linux, install pybind11 in the active Python environment and
compile the module from `examples/minimal`:

```sh
python3 -m pip install pybind11
c++ -O2 -shared -std=c++17 -fPIC $(python3 -m pybind11 --includes) \
  bindings.cpp -o "_navigation_example$(python3-config --extension-suffix)"
python3 demo.py
```

For the clangd check in the minimal example, add a local `.clangd` with
`CompileFlags.Add` entries for `-std=c++17` and the include flags printed by
`python3 -m pybind11 --includes`. Reload the development host and check the
output channel after opening `demo.py`.


## Credit

Special thanks to:

- https://linux.do/
