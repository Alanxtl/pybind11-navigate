import _navigation_example as native
from _navigation_example import Reader as Input
from _navigation_example import Writer, twice as double

assert native.twice(3) == 6
assert double(4) == 8

reader = Input()
assert reader.setup() == 1
assert reader.setup(10) == 10
assert Writer().setup() == 2


def configure(writer: native.Writer):
    return writer.setup()


assert configure(Writer()) == 2


def unresolved(value):
    return value.setup()


def make_writer() -> native.Writer:
    return native.Writer()


generated = make_writer()
assert generated.setup() == 2
