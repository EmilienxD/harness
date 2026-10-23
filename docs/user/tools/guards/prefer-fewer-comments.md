# Prefer Fewer Comments

Platforms: **Claude Code, ChatGPT, Pi**. Install with `harness install prefer-fewer-comments`; see [installation and scope](../../getting-started.md).

`prefer-fewer-comments` checks newly added comments and docstrings after a write in Claude Code, ChatGPT, or Pi. When a comment, docstring, or the overall change exceeds a budget, it asks the agent to use less commentary going forward. Writes remain successful; existing comments stay in place. Functional comments and docstrings can exceed the budget.

Install with `harness install prefer-fewer-comments` and restart the provider. Edit `.harness/guards/prefer-fewer-comments.toml` or `~/.harness/guards/prefer-fewer-comments.toml` at user scope. The commented starter uses built-in defaults until you set values:

```toml
version = 1

[limits]
max_comment_lines = 2
max_comment_chars = 240
max_doc_lines = 5
max_doc_chars = 600
max_comment_ratio = 0.30
min_lines_for_ratio = 20

[[rules]]
patterns = ["docs/**", "**/*.md"]
exempt = true
```

Each limit is optional. Ordered path rules can set `exempt = true` and a later, narrower `exempt = false` to include a path again. User rules precede project rules; edited starter files survive upgrades.

## Pi

Install with `harness install prefer-fewer-comments --platform pi`, then run `/reload` and approve the project resources. The shipped defaults are active immediately. Project policy uses `.harness/guards/prefer-fewer-comments.toml`. A user installation puts its starter in the effective Pi agent directory at `harness/prefer-fewer-comments.toml`; shared `~/.harness/guards/prefer-fewer-comments.toml` and project overrides take precedence. Pi requires uv or Python 3.11+.

The extension wraps local native `write` and `edit`, including nested calls. It captures the old contents and the exact written contents inside Pi's file mutation queue, then checks additions after successful execution. Unchanged comment bodies are excluded even when neighboring code changes. Existing line comments are excluded before new adjacent lines are grouped; a changed block comment or docstring is checked as a complete comment. The ratio counts added lines only. Native paths, edit matching, multi-edit input, BOM/line endings, diffs, renderers, and other extensions' tool guards remain intact.

Each file gets at most one reminder every 180 seconds. Cooldown receipts persist in Pi's native session ancestry, survive reload/resume, and follow the selected branch. They contain paths, times, call IDs and interpreter launch arguments. Full snapshots stay in memory; Pi persists ordinary tool results, including reminder excerpts. Failed or cancelled calls consume no reminder. Analysis failure or snapshots over 512 KiB append a diagnostic while preserving successful writes.

This extension owns the `write` and `edit` definitions. Use it with Pi's local filesystem tools; another extension replacing those names, such as a remote filesystem adapter, requires explicit integration. Shell commands, MCP mutators, and direct filesystem writes by other extensions are outside Pi coverage. This is advisory feedback, not a mutation restriction. Acceptance uses headless Pi 1.2.0 on Windows; other Pi versions, POSIX and TUI behavior need their own runtime verification.

## When to use it

Use this when generated comments and docstrings tend to crowd out code. The built-in limits apply with the shipped commented starter, so installation has an effect before customization. For example, exempting `docs/**` lets documentation files exceed code-oriented comment budgets while retaining checks on source files.

## Limits

The hook inspects what the write added and returns feedback after the write. It does not delete comments automatically. Ratio checks apply only when the change reaches `min_lines_for_ratio`; the line and character budgets can still flag smaller additions.

## Implementation and verification

`prefer-fewer-comments` 2.3.1 uses **native tool definitions with injected filesystem
operations**, rather than `tool_call`/`tool_result` disk snapshots. Research covered the
mirrored [extension contract](https://github.com/EmilienxD/harness/blob/main/docs/PI-REFERENCES/docs/extensions.md#custom-tools),
[override example](https://github.com/EmilienxD/harness/blob/main/docs/PI-REFERENCES/examples/extensions/tool-override.ts),
[event types](https://github.com/EmilienxD/harness/blob/main/docs/PI-REFERENCES/src/core/extensions/types.ts), and the installed Pi 1.2.0
public exports, write/edit implementations, argument preparation, and mutation queue.
The pinned source evidence is upstream's
[write definition](https://github.com/earendil-works/pi/blob/47fc5f38ec18d56fe64abd41a2dcf9e5170a3dcf/packages/coding-agent/src/core/tools/write.ts),
[edit definition](https://github.com/earendil-works/pi/blob/47fc5f38ec18d56fe64abd41a2dcf9e5170a3dcf/packages/coding-agent/src/core/tools/edit.ts), and
[file queue](https://github.com/earendil-works/pi/blob/47fc5f38ec18d56fe64abd41a2dcf9e5170a3dcf/packages/coding-agent/src/core/tools/file-mutation-queue.ts).
Those sources were cross-checked against the installed 1.2.0 runtime before implementation.

The decision preserves the package's forward-looking preference. Pre-execution blocking
would reject useful comments before the existing functional-benefit exception could be
applied. Automatic removal or corrective continuation would alter existing code and spend
additional inference without user intent. Advisory guidance belongs on the successful tool
result; it neither rewrites comments nor triggers an extra model turn.

Event snapshots lose mutation attribution: sibling calls can capture the same stale before
state outside Pi's queue, and a result callback can read a later sibling's write. Git diffs
also include pre-session/user changes, miss untracked files without extra machinery, and
require a repository. Native operation injection captures each queued mutation directly,
including non-Git projects, without copying Pi's private path/edit algorithms or replacing
the existing lexer in TypeScript.

The extension spreads `createWriteToolDefinition` / `createEditToolDefinition` and replaces
only execution. Every execution creates fresh operations closures. Native edit supplies
the old buffer and the final string after matching, BOM and line-ending handling; native write
reads its old contents immediately before its queued write. Missing files have an empty
before snapshot; unreadable/unbounded snapshots do not obstruct a native write. Guidance
uses captured strings after native success, never a result-time reread. The full native
operation retains Pi's own queue; acquiring the same queue around delegation would deadlock.
Native schema preparation, multi-edit/fuzzy matching, path normalization, prompt guidelines,
renderers, diffs and other tool guards remain native. Nested `ctx.executeTool` dispatch still
passes through their regular events.

The Python adapter reuses policy precedence, language scanning, budgets, exemptions and
message construction. With the old snapshot supplied, scanning excludes unchanged comment
bodies by multiplicity before grouping new adjacent line comments. This avoids flagging a
large old inline comment when only neighboring code changed, or charging an old line-comment
block to one short addition. Changed block comments/docstrings retain whole-comment budgets;
density charges only added lines. Multiline backticks remain string context; inline comments
retain the code line that ends the file-header region. The lexer is
heuristic rather than a language parser; unsupported file families are skipped.

Feedback is serialized separately from mutations, so parallel successes cannot both spend
the same cooldown or first-reminder slot. Durable `harness-prefer-fewer-comments-v1` entries
contain call ID, interpreter argv and canonical file path/time receipts only. Absolute file
identity separates same-named files outside the project and shares cooldown through path aliases.
They are reconstructed from
`getBranch()`, including nested calls, instead of external process-global markers. Reload
and exact resume retain cooldown; navigating before delivery discards that branch's authority.
Session/tree/shutdown events cancel stale helper work. Failed/cancelled native calls consume
no reminder, and analysis failures retain success with an additive diagnostic. Snapshots are
bounded at 512 KiB each; the shared versioned subprocess transport adds timeout, cancellation
and request/output bounds. There are no persistent workers, filesystem snapshot files or
paid model calls.

This selection owns local-native `write`/`edit`. Another extension replacing those names,
especially remote filesystem tools, requires explicit composition; whichever definition wins
cannot automatically inspect the other's mutations. Shell scripts, MCP/custom mutators and
arbitrary extension I/O remain uncovered. Advisory installation does not certify mandatory
restrictions or OS isolation. This narrower boundary is explicit in the catalogue-facing docs.

Acceptance uses `npm run test:pi-prefer-fewer-comments`: four project/user JSON/RPC journeys,
a concurrent nested/lifecycle journey and a helper outage/recovery journey through the actual installer and real Pi 1.2.0 on
Windows, with the authenticated fake Responses endpoint shared with Codex. They assert exact
bytes, native error/status and diff contracts, additive feedback structure, rule precedence,
comment/doc/header/density and zero budgets, strings/directives, unchanged comments, bounds, cooldown,
reload/resume/tree/new-session receipts, helper failure/recovery, denied mutations alongside the path guards, inference counts,
starter preservation and coupled dependency removal. These are integration acceptance checks;
POSIX, Pi TUI, other runtime versions and unscripted model obedience remain outside this gate.
