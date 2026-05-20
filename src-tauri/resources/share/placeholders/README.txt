Shared runtime resources are staged under resources/share by release scripts.

This placeholder is tracked so Tauri resource globs resolve on fresh checkouts
and CI jobs that run cargo check without bundling the runtime first.
