# No New Documents

Platforms: **Claude Code, ChatGPT, Pi**. Install with `harness install no-new-documents`; see [installation and scope](../../getting-started.md).

`no-new-documents` protects new files in chosen documentation paths on Claude Code, ChatGPT, and Pi. Existing files remain editable. A blocked new file is written as a draft under `.harness/doc-drafts/` with the same relative path, for example `docs/arch/plan.md` becomes `.harness/doc-drafts/docs/arch/plan.md`. The draft directory is git-ignored.

Install with `harness install no-new-documents` and restart the provider. Set protected paths in `.harness/guards/no-new-documents.toml`, or `~/.harness/guards/no-new-documents.toml` for user scope:

```toml
version = 1
protected = ["docs/**", "project-notes/**"]
unprotected = ["docs/generated/**"]
```

The starter protects only the root `docs/**`, not source directories named `docs` deeper in the tree. Use `**/docs/**` explicitly to protect docs directories at every depth. Patterns use gitignore-style `*`, `?`, and `**`; exclusions use the same syntax, not `!` prefixes.

Protected paths from all scopes combine. Optional `unprotected` paths also combine and override protection from **every scope**, so a project exclusion can narrow a user-level rule. For example, `protected = ["**/docs/**"]` with `unprotected = ["website/src/lib/docs/**"]` permits source files such as `catalog.test.ts` there. This only bypasses draft routing, not provider permissions. Existing customized starters are preserved on upgrade, including older recursive defaults.

Invalid pattern entries are skipped individually; other valid entries still apply. Missing or incorrectly typed lists are ignored, and malformed/unreadable TOML or unsupported versions cause that policy source to be skipped. Valid policies from other scopes remain active. With no valid protection patterns, the guard permits creation. This is a configurable workflow guardrail, not a security boundary.

For Pi, add `--platform pi`. Its user-scope starter lives at `<PI_CODING_AGENT_DIR>/harness/no-new-documents.toml`, defaulting to `~/.pi/agent/harness/no-new-documents.toml`. Home and project policies also apply. The extension guards native writes and recognized literal shell creations, including nested tool calls; arbitrary scripts and other extensions' direct filesystem access remain outside this guardrail.

Native writes follow Pi's `@`, tilde, file URL, Unicode-space and Windows shell-path expansion. Logical and resolved paths both retain protection, and draft writes reject linked ancestors. Invalid policy input is skipped; an unavailable Python helper still blocks covered calls. Existing documents remain editable.

Review the draft, then run `/approve-doc-draft docs/arch/plan.md` or `/reject-doc-draft docs/arch/plan.md` in Claude Code or Pi; use `$approve-doc-draft` or `$reject-doc-draft` in ChatGPT. With no path, these commands list drafts; a directory handles its pending drafts together. Quote paths containing spaces. Approval never overwrites an existing target. To request changes, tell the agent what to revise in the draft.

## When to use it

Use this when creating documents should involve a human review, while routine edits to existing documents can proceed. The protected paths control where the draft flow applies; paths outside them follow normal provider behavior.

## Review example and limits

For a new `docs/arch/plan.md`, inspect `.harness/doc-drafts/docs/arch/plan.md` and ask for revisions there. Approval moves the draft to its target; rejection deletes the draft. Neither command calls a model. A draft is local to the project, and approval refuses a target that has appeared since the draft was created.

## Implementation and verification

`no-new-documents` 3.3.0 uses the same bridge with package-local native tool and command translation.
It denies native writes and recognized literal shell creations in protected paths, including nested
calls, while allowing draft mirrors and existing-document edits. Invalid policy input is skipped; transport failure
blocks covered calls. Native `/approve-doc-draft` and `/reject-doc-draft` commands make zero inference requests.
Their skill shims are installed only for Claude Code and ChatGPT.
Publication uses exclusive hard-link creation followed by draft removal, so an existing destination
cannot be overwritten by a concurrent approval. Unsupported hard links leave the draft for correction.
Native custom messages persist outcomes on the active branch; current pending drafts are refreshed
from disk before model turns. Pi user policy starters live outside npm packages in `<agent-dir>/harness/`; shared home and
project policies also apply. Arbitrary scripts, third-party mutators, trusted extension command dispatch
and direct extension I/O remain outside the protection boundary.

The enforcement choice is a `tool_call` handler rather than replacing native tools. The
[extension contract](https://github.com/EmilienxD/harness/blob/main/docs/PI-REFERENCES/docs/extensions.md#work-with-events) makes denial apply before
execution, including nested `ctx.executeTool()` calls. This composes with the read/edit guards
and leaves Pi's native tool schemas, mutation queues, rendering and other tool adapters intact.
An override would own the same tool name as remote-filesystem or other tool extensions without
providing OS isolation. Post-execution rollback cannot guarantee zero mutation, and filesystem
watchers observe creations too late. Strong script restrictions require an OS/container boundary;
the [security reference](https://github.com/EmilienxD/harness/blob/main/docs/PI-REFERENCES/docs/security.md) explicitly gives extensions the Pi
process's permissions. Trusted extensions can also change input after a guard has checked it.

Native policy input must resolve to the same target as Pi's write. The installed 1.2.0
`dist/core/tools/path-utils.js` and `dist/utils/paths.js` were checked against upstream
[`resolveToCwd`](https://github.com/earendil-works/pi/blob/47fc5f38ec18d56fe64abd41a2dcf9e5170a3dcf/packages/coding-agent/src/core/tools/path-utils.ts)
and [`normalizePath`](https://github.com/earendil-works/pi/blob/47fc5f38ec18d56fe64abd41a2dcf9e5170a3dcf/packages/coding-agent/src/utils/paths.ts).
The extension handles one leading `@`, Unicode spaces, tilde, file URLs, and Windows
MSYS/WSL/Cygwin drive paths before sending an absolute policy path. These helpers are private
Pi APIs, so the small translation stays local with real-CLI coverage instead of importing
private package files. Only the policy copy is normalized; rewriting tool input would apply
normalization twice and change literal filenames such as `@@literal.txt`. Recheck this boundary
when widening the tested Pi version range.

The shared Python core accepts parsed policy and returns creation targets and draft guidance
directly; Pi does not fabricate a Claude hook event or decode hook stdout. One policy snapshot
serves the entire decision, so matching and exclusions use a consistent view of all valid entries.
Pi matches both logical and resolved paths, with case-insensitive patterns on Windows. A link
into protected docs and a protected docs directory linked outside the project both retain
protection. Linked draft ancestors are denied. Existing documents remain editable; concurrent
external deletion or replacement between a check and tool execution is outside this guardrail.
Approval still checks source/destination containment and uses exclusive publication.

The headless acceptance gate runs actual catalogue project/user installations through Pi 1.2.0
JSON/RPC and the fake Codex Responses API. Eight journeys cover native path aliases (twelve
denials per scope on Windows), nested aliased writes, existing native write/edit, ordinary files,
safe drafts, linked draft paths, deterministic commands, collision/racing publication, skipped malformed
policy, cross-scope exclusions, invalid pattern entries, missing helper, reload/resume/tree ancestry, starter preservation and coupled removal.
They assert denied filesystem effects and exact inference counts; command execution adds zero
requests. POSIX branches are present but this acceptance run was on Windows.

The three `test:pi-*` journeys documented in [the E2E guide](https://github.com/EmilienxD/harness/blob/main/tests/e2e/README.md#pi-document-drafts-git-cleanup-and-test-workflows)
install real catalogue payloads at project/user scope and exercise Pi 1.2.0 JSON/RPC on Windows against
the authenticated fake Responses endpoint. They verify filesystem/Git/manifest effects, request counts,
command failures, lifecycle behavior and receipt-driven removal. They certify native integration with
scripted inference; they do not certify unscripted model judgments or POSIX/TUI runtime behavior.

The 3.3.0 Windows headless regression also verifies the root-only starter, project exclusions
overriding recursive user protection in both JSON and RPC, skipped invalid pattern entries,
and malformed TOML leaving other valid policies active. Claude Code and Codex headless draft-denial
journeys remain part of the regression checks.
