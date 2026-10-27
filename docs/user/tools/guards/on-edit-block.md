# On Edit Block

Platforms: **Claude Code, ChatGPT (local Work/Codex), Pi**. Install with `harness install on-edit-block`; see [installation and scope](../../getting-started.md).

`on-edit-block` uses Claude Code/ChatGPT PreToolUse hooks and a native Pi extension. It denies supported native edits and recognized shell writes on a matching path until the required guidance has been completely read or included in a denial in the current session.

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

Patterns use gitignore-style `*`, `?`, and `**`. Rules run in order; exclusions clear prior requirements. User rules load before project rules. Harness preserves edited starter policies on upgrade. The guard checks session reads, so a read in an earlier session does not satisfy it. ChatGPT support uses local hooks; cloud-orchestrated Work does not load these command hooks.

## When to use it

Choose this for paths where conventions must be read before a write, such as schema or model files. In the example, an attempt to edit `server/app/models/user.py` is denied until `docs/CONVENTIONS.md` has been read in that session. The later `vendor/**` rule excludes vendored paths.

## Limits

The hook verifies that a required file was read, not that the agent understood or followed it. Configure real, readable guidance paths. Native editing tools retain their existing behavior. Shared shell parsing adds coverage for common writes; arbitrary scripts and custom mutators need their own controls.

For Pi, install with `harness install on-edit-block --platform pi` and run `/reload` or restart Pi.
Approve the project's resources when Pi requests trust. Project rules use the same
`.harness/guards/on-edit-block.toml`. User installations keep an editable starter in
`<Pi agent directory>/harness/on-edit-block.toml`; shared `~/.harness/guards/` rules and
project rules load afterward. Pi requires uv or Python 3.11+ on `PATH`.

Pi blocks native `write`/`edit` until complete guidance was successfully read or fully included in a denial on the active branch. Large guidance stays blocked until read; partial or failed reads cannot authorize edits. Native read ranges accumulate only for the same file contents. Simple complete shell reads can also satisfy guidance when their successful output contains the complete file. Reload and resume recover branch receipts; abandoned branches grant no access. Recognized shell writes are also checked; arbitrary scripts and unrelated custom tools need their own controls; nested native calls are covered.

## ChatGPT and Claude read evidence

Install for local ChatGPT with `harness install on-edit-block --platform chatgpt`, then review/trust the installed hooks and restart the session. ChatGPT checks every added, updated, deleted or renamed path in `apply_patch`; a matching path denies the entire patch. Claude retains `Write`/`Edit`/`MultiEdit` coverage. Both also check recognized shell writes before execution.

Successful read results must cover the guidance's complete current contents. Claude native read ranges accumulate; complete simple shell reads can satisfy guidance on both providers. Failed, truncated or partial shell reads do not unlock edits, and transcript read attempts alone do not count. A denial only authorizes a retry for guidance actually included in full; oversized guidance must be read separately. Evidence is scoped to provider, project and session, and is recorded while the hooks are active.

ChatGPT shell coverage uses the session directory and explicit `cd` commands. The tested Codex CLI does not expose per-call `exec_command.workdir` overrides to hooks; relative paths under such overrides cannot be resolved reliably. Use absolute paths or an explicit `cd` for those calls.

## Implementation and verification

The [read/edit guard implementation](../guards-and-extensions.md#readedit-guard-implementation-and-verification) describes shared Python policy reuse, bounded transport, active-branch receipts and the Windows Pi 1.2.0 project/user JSON/RPC journeys. This tool retains the triggering and cooldown rules described above. Guard loading, unknown mutators and operating-system isolation follow the [admission limits](../guards-and-extensions.md#guard-admission-and-evidence).
