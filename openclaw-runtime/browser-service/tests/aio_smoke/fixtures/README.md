The AIO smoke tests generate seed `.xlsx`, `.docx`, and `.pptx` files in
`tmp_path` at runtime instead of committing binary Office fixtures.

This keeps the fixtures auditable while still exercising the public
`inspect_aio(path)` -> edit `object` -> `apply_aio(path, payload)` workflow.
