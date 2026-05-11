This directory contains small seed `.xlsx`, `.docx`, and `.pptx` files used
by the AIO smoke tests for read-only inspection assertions.

The roundtrip tests still generate editable files in `tmp_path` so they can
exercise `inspect_aio(path)` -> edit `object` -> `apply_aio(path, payload)`
without mutating these fixtures.
