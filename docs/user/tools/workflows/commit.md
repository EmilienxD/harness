# Commit

Platforms: **Claude Code, ChatGPT, Pi**. Install with `harness install commit`; see [installation and scope](../../getting-started.md).

## When to use

Use `commit` after reviewing completed work from the current session. A dry run lets you inspect the file set before creating a Git commit.

## Invocation

Use `/commit <message>`, `/commit --dry`, or `/commit --ai [guidance]`. Hooks on Claude Code/ChatGPT and a native Pi command handle the request before an agent model call. Pi also accepts `/skill:commit` with the same options.

## What happens

The hook identifies files written during the session, stages eligible changes, and commits them. `--dry` previews the operation. `--ai` makes a direct Gemini request to generate the message using the diff and bounded session context; the other forms work locally without an API key.

## Files and prerequisites

`git` is required. For `--ai`, set `GEMINI_API_KEY` or `GOOGLE_API_KEY`, or store `{"version": 1, "commit": {"geminiApiKey": "your-key"}}` in gitignored `.harness/config.local.json`. The same section in user `~/.harness/config.json` (or `$HARNESS_STATE_DIR/config.json`) applies across repositories. Keep the key out of committed `.harness/config.json`. If the command reaches the agent as skill text, check that its hook or extension is loaded and trusted.

## Example

Run `/commit --dry` to inspect the proposed commit, then `/commit Fix empty-cart validation`.

## Implementation and verification

Version 1.7.6 reads ChatGPT hook input as UTF-8 and stores context using escaped JSON, including
provider input containing lone surrogates. Ordinary prompts are recorded as optional
context for a later `--ai` invocation; recording failures let the prompt continue.
Explicit commit failures and tool-attribution failures retain their error handling.
The real-CLI commit journey checks Windows Codex 0.162.1 with cp1252 stdin defaults:
Unicode prompts reach inference, storage and Git-lookup failures allow ordinary prompts,
and a resumed explicit commit adds no inference request. Separate failure journeys
check explicit commit errors and pre/post-tool failures. Inference uses the authenticated
loopback fixture; lone-surrogate serialization is covered by Python regression tests.

`commit` 1.7.1 registers `/commit` and intercepts `/skill:commit` before skill expansion.
Both reuse the existing Python flag parsing, staging, Git commit, dry-run and explicitly
requested Gemini message generation. Pi passes native active-branch user/assistant context
to the shared message builder directly; it does not fabricate a Claude transcript. Ordinary
commands, usage errors and dry runs create zero Pi inference requests. `--ai` still uses its
one explicitly requested direct Gemini request; it does not start a Pi agent turn.

Research covered the mirrored [extension events](https://github.com/EmilienxD/harness/blob/main/docs/PI-REFERENCES/src/core/extensions/types.ts),
[native session tree](https://github.com/EmilienxD/harness/blob/main/docs/PI-REFERENCES/docs/session-format.md), the installed Pi 1.2.0 tool pipeline
and native path normalization, and the pinned upstream
[file mutation queue](https://github.com/earendil-works/pi/blob/47fc5f38ec18d56fe64abd41a2dcf9e5170a3dcf/packages/coding-agent/src/core/tools/file-mutation-queue.ts).
Pi's queue protects native mutations, but `tool_call` and `tool_result` snapshots happen
outside it. This integration deliberately uses events and refuses overlapping same-file
observations rather than replacing native tool definitions: it composes with installed
comment budgets and other native overrides. Nested calls pass through the same events.

The Python adapter hashes bounded regular files before/after native `write`/`edit`, inventories
shell Git effects, and limits shell ownership to recognizable literal write targets from the
shared parser (plus literal PowerShell deletion). Successful native `write` observations must
also match the hash of the tool's requested UTF-8 content. Preexisting dirty bytes, failed calls with partial effects, unresolved or extra
shell effects, overlapping shell/native observations and incomplete helper evidence produce
uncertainty receipts. An unchanged failed or denied call creates no successful-write ownership.
Denied calls skip `tool_result`, so execution-end also clears pending observations.

Non-context custom receipts hold paths, fingerprints and Git baseline evidence, bound to the
native session ID. Ownership is reconstructed from `getBranch()`, so abandoned tree branches
cannot authorize staging. Reload/exact resume retain it; fork/new identities exclude inherited
receipts. Observed Git baseline changes and successful commands clear prior ownership. Current
HEAD and file fingerprints must still match at invocation; a conflicting existing index entry
on an owned path stops the command. Unrelated staged files are preserved by path-scoped commits.
Merges require whole-index semantics and are refused. Empty or uncertain ownership never reaches
the legacy stage-all fallback.

After staging, record the exact owned index entries. Failed message generation or Git commit
preserves those entries and allows an explicit-message retry only while their fingerprints
still match. User changes to that index invalidate retry authority. Recheck HEAD, owned file
contents, worktree/index equality and the captured index entries immediately before Git commit,
including after the potentially slow AI request. Native narrative is bounded before transport
and is sent only for `--ai`, so long conversational history does not obstruct local commands.

The adapter supports bounded local regular files and observed native/shell operations. Symlink
targets, arbitrary custom mutators and extension I/O need explicit adapters. Event attribution
is evidence about observed operations, not OS isolation: independent processes can still mutate
the working tree. Keep Git hooks and external writers under the same operational control as an
ordinary Git commit. Files over the snapshot limit or unreadable evidence stop automatic
attribution instead of weakening it. `pi-transport` supplies bounded, cancellable interpreter
transport; no persistent worker or file-content receipt is introduced.

Acceptance runs all four project/user and JSON/RPC combinations on installed Windows Pi 1.2.0,
plus nested/lifecycle and direct-message-generation journeys. It checks real Git/index effects,
literal filenames, denied/failed calls, shell deletion, active ancestry, fork identity, partial
staging, helper outages, observed Git baseline changes, and working-tree/index changes arriving
during AI generation. Gemini inference is replaced by a separate authenticated loopback fixture;
Pi uses the shared fake Responses endpoint. See [the E2E guide](https://github.com/EmilienxD/harness/blob/main/tests/e2e/README.md#pi-commits-and-desktop-notifications).
