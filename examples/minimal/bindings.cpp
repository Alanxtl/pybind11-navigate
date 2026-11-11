#include <pybind11/pybind11.h>

namespace binding = pybind11;

int twice(int value) { return value * 2; }

struct Reader {
    int setup(int capacity) { return capacity; }
    int setup() { return 1; }
};

struct Writer {
    int setup() { return 2; }
};

PYBIND11_MODULE(_navigation_example, module) {
    module.def("twice", &twice,
               "Double the integer passed in from the Python call site.");

    binding::class_<Reader>(module, "Reader")
        .def(binding::init<>())
        .def("setup", static_cast<int (Reader::*)()>(&Reader::setup))
        .def("setup", [](Reader &reader, int capacity) {
            return reader.setup(capacity);
        });

    binding::class_<Writer>(module, "Writer")
        .def(binding::init<>())
        .def("setup", &Writer::setup);
}
