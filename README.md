# pybind11 Navigate

[![VS Code Marketplace](https://img.shields.io/badge/VS%20Code-Marketplace-blue?logo=visualstudiocode)](https://marketplace.visualstudio.com/items?itemName=XuetaoLi.pybind11-navigate)
[![GitHub](https://img.shields.io/badge/GitHub-Source-181717?logo=github)](https://github.com/Alanxtl/pybind11-navigate)
[![License: MIT](https://img.shields.io/badge/License-MIT-green)](https://github.com/Alanxtl/pybind11-navigate/blob/main/LICENSE)

Jump from a Python class, method, or module function to its pybind11
registration in C++. Press **F12** or **Ctrl+click** (**Cmd+click** on macOS)
on the Python symbol. If a name has multiple registrations, all matching
locations are returned.

To navigate to the C++ callable, right-click the Python symbol and choose
**pybind11 Navigate: Go to C++ Implementation**, or run that command from
the Command Palette. Choose a registration when there are overloads. For a
function pointer, the command uses your C++ language service (such as clangd
or the Microsoft C/C++ extension); configure it for your C++ project. The
available definition depends on that service's project configuration. A
lambda opens directly at the lambda in the registration.

## Getting started

1. Install [pybind11 Navigate](https://marketplace.visualstudio.com/items?itemName=XuetaoLi.pybind11-navigate) in VS Code.
2. Open and trust a workspace containing your Python code and C++ binding source.
3. Open a Python file and use **F12** or **Ctrl+click** on a pybind11 export.

The extension requires VS Code 1.85+ and Python 3.10+ on the extension host.
It uses `python3` from PATH (`python` on Windows). If needed, set
`pybind11Navigation.pythonPath` in VS Code user settings.

## Automatic scanning

When you open a Python file, the extension scans C++ files in each workspace
folder for `PYBIND11_MODULE`, classes, functions, properties, and named
submodules, including registrations made through class variables. It
updates indexed files when they are saved or changed, and refreshes the file
list when matching C++ files are created or deleted.

By default, the scan includes `*.cc`, `*.cpp`, `*.cxx`, `*.h`, `*.hh`,
`*.hpp`, `*.hxx`, `*.cu`, and `*.cuh`. It excludes directories such as
`.git`, `.venv`, `build*`, and `node_modules`. To change the scan scope, set
`pybind11Navigation.include` and `pybind11Navigation.exclude` to workspace
relative glob patterns.

The extension matches Python imports to native modules and can follow common
re-exports in the workspace. If a wrapper chooses a backend from an environment
variable, automatic navigation uses the default declared in the source and
shows a warning: the runtime may select a different backend. Use an explicit
mapping below when necessary. Method navigation requires a known receiver
type, such as one determined from a constructor call or type annotation.

## Working across projects

You can add the project containing the C++ source to the same workspace using
**File → Add Folder to Workspace…**. Alternatively, leave the Python project
open on its own and associate an import with an external source directory in
the Python project's `.vscode/settings.json`:

```json
{
  "pybind11Navigation.moduleSources": {
    "acme.api": {
      "module": "_core",
      "path": "/path/to/cpp-project"
    }
  }
}
```

Here `acme.api` is the Python import path and `_core` is the name in
`PYBIND11_MODULE(_core, m)`. A relative `path` is resolved against the Python
workspace folder; the directory must be accessible on the extension host. The
same include and exclude settings apply to external sources. This association
restricts the import to that directory, which keeps checkouts with identically
named modules separate.

## Configure a module mapping

If the import goes through a Python wrapper and the native module cannot be
identified automatically, add a mapping to the Python project's
`.vscode/settings.json`. In a multi-root workspace, you can also add it
under `settings` in the `.code-workspace` file. The key is the full Python
import path and the value is the module name in `PYBIND11_MODULE`.

For example, if Python imports from `acme.api` and C++ registers the same
export under `PYBIND11_MODULE(_core, m)`, add:

```json
{
  "pybind11Navigation.moduleMap": {
    "acme.api": "_core"
  }
}
```

An explicit mapping takes precedence over automatic matching. The Python
export name must match the name in the C++ registration.

If navigation still fails, check that the binding file is included by the
scan or by a `moduleSources` directory. Open **View → Output → pybind11 Navigate** for
indexing and Python parser messages.

## Credit

Special thanks to [LINUX DO](https://linux.do/).
