# On Edit Block

`on-edit-block` is a Claude Code PreToolUse hook and a native Pi extension. It denies Write, Edit, or MultiEdit on a matching path until the agent has read the required guidance in the current session.

Install with `harness install on-edit-block --platform claude`, restart Claude Code, and configure `.harness/guards/on-edit-block.toml` or `~/.harness/guards/on-edit-block.toml` at user scope. The starter contains commented examples only:

```toml
version = 1

[[rules]]
patterns = ["server/**/models/**", "**/*.sql"]
require = ["docs/CONVENTIONS.md"]

[[rules]]
patterns = ["vendor/**"]
exclude = true
```

Patterns use gitignore-style `*`, `?`, and `**`. Rules run in order; exclusions clear prior requirements. User rules load before project rules. Harness preserves edited starter policies on upgrade. The guard checks session reads, so a read in an earlier session does not satisfy it. ChatGPT is not supported.

## When to use it

Choose this for paths where conventions must be read before a write, such as schema or model files. In the example, an attempt to edit `server/app/models/user.py` is denied until `docs/CONVENTIONS.md` has been read in that session. The later `vendor/**` rule excludes vendored paths.

## Limits

The hook verifies that a required file was read, not that the agent understood or followed it. Configure real, readable guidance paths. This guard covers the named Claude editing tools; other file mutation routes need their own controls.

For Pi, install with `harness install on-edit-block --platform pi` and run `/reload` or restart Pi.
Approve the project's resources when Pi requests trust. Project rules use the same
`.harness/guards/on-edit-block.toml`. User installations keep an editable starter in
`<Pi agent directory>/hooks/on-edit-block.toml`; shared `~/.harness/guards/` rules and
project rules load afterward. Pi requires uv or Python 3.11+ on `PATH`.

Pi blocks native `write`/`edit` until complete guidance was successfully read or fully included in a denial on the active branch. Large guidance stays blocked until read; partial or failed reads cannot authorize edits. Native read ranges accumulate only for the same file contents. Simple complete shell reads can also satisfy guidance when their successful output contains the complete file. Reload and resume recover branch receipts; abandoned branches grant no access. Shell writes and unrelated custom tools need their own controls; nested native calls are covered.
