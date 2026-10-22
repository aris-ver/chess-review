"""DuckDB, loaded after the rest: the worker answers before it is in.

Loading it in Pyodide takes over a second at every visit, cached or not (its WebAssembly is compiled again each
time), while the home screen, the puzzles and the settings never touch it. So the worker starts Python without
it, and stand_in() puts a placeholder module in its place before chess_review is imported: its `import duckdb`
succeeds, and nothing is looked up in it until a request uses it. Such a request raises NotLoaded; the worker
waits for the package, calls swap_in() and asks again.

Imports nothing from chess_review, as it has to run before it.
"""

import importlib
import sys
import types

MODULES = ("duckdb",)


class NotLoaded(BaseException):
    """A request reached DuckDB before it loaded. Not an Exception, so that serve.Handler's own
    `except Exception` replies let it through to the worker instead of answering 500."""


class PackNotLoaded(NotLoaded):
    """A request reached the puzzle pack (puzzles.json) before it downloaded: the worker waits for that alone."""


class _Later(types.ModuleType):
    def __init__(self, name: str):
        super().__init__(name)
        self.real = None

    def __getattr__(self, attr):
        if attr.startswith("__"):       # the import system's own probes (__path__, __spec__, ...)
            raise AttributeError(attr)
        if self.real is None:
            raise NotLoaded(self.__name__)
        return getattr(self.real, attr)


def stand_in() -> None:
    for name in MODULES:
        sys.modules[name] = _Later(name)


def swap_in() -> None:
    """Once the worker has loaded the packages: the real modules in sys.modules, and in every chess_review and
    chess_web module that imported a placeholder (a placeholder kept elsewhere passes everything on)."""
    later = {name: sys.modules.pop(name) for name in MODULES if isinstance(sys.modules.get(name), _Later)}
    for name, mod in later.items():
        mod.real = importlib.import_module(name)
    for name, mod in list(sys.modules.items()):
        if name.split(".")[0] in ("chess_review", "chess_web"):
            for k, v in list(vars(mod).items()):
                if isinstance(v, _Later) and v.real is not None:
                    setattr(mod, k, v.real)
