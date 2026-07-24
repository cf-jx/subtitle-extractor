# Local model

Run the pinned runtime preparation script before a Tauri build:

```text
pnpm runtime:fetch --target <target-triple>
```

The build bundles `ggml-small-q5_1.bin`. Generated model files are intentionally
excluded from Git.
