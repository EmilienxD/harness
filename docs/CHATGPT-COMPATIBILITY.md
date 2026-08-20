# ChatGPT compatibility assessment

Assessed against the official ChatGPT developer documentation on 2026-08-20.
The upstream documentation still uses `codex`, `CODEX_HOME`, and `.codex` for
some CLI implementation identifiers. This repository uses **ChatGPT** as the
product name and preserves those identifiers only where the CLI requires them.

## Conclusion

Harness can support ChatGPT, but the current Claude Code payloads cannot simply
be copied into a different directory. The public ChatGPT CLI supports the three
foundations the collection needs:

- repository and user skills using `SKILL.md`;
- lifecycle command hooks, including `UserPromptSubmit`, `PreToolUse`,
  `PostToolUse`, `Stop`, and subagent events;
- native subagents and project instructions through `AGENTS.md`.

The important incompatibilities are the install layout, hook configuration and
wire formats, tool names, transcript format, and a few Claude-only events or
services. The practical result is:

- 5 near-direct skill ports;
- 9 feasible ports that need platform-specific instructions or hook code;
- 1 tool better replaced by a built-in ChatGPT capability;
- 2 tools intentionally kept Claude Code-only.

ChatGPT's `/import` flow can import Claude Code instructions, settings, skills,
hooks, slash commands, and subagents. That is useful for migration testing, but
the official docs explicitly warn that imported hooks and command-style prompts
may behave differently. It should not replace native harness installation and
tests.

## Capability differences that affect the installer

| Concern | Claude Code | ChatGPT CLI |
| --- | --- | --- |
| Project skills | `.claude/skills/<name>/` | `.agents/skills/<name>/` |
| User skills | `~/.claude/skills/<name>/` | `~/.agents/skills/<name>/` |
| Project hooks | `.claude/settings*.json` | `.codex/hooks.json` or `.codex/config.toml` |
| User hooks | `~/.claude/settings.json` | `~/.codex/hooks.json` or `~/.codex/config.toml` |
| Hook command | `command` plus an `args` array | one command string, with optional `commandWindows` |
| Project-root placeholder | `${CLAUDE_PROJECT_DIR}` | none documented; resolve the Git root or install an absolute command |
| Skill invocation metadata | Claude frontmatter such as `disable-model-invocation` | `agents/openai.yaml`, including `policy.allow_implicit_invocation` |
| Edit tool | `Write`, `Edit`, `MultiEdit` | `apply_patch`; `Edit` and `Write` are matcher aliases only |
| Failed shell event | `PostToolUseFailure` | ordinary `PostToolUse` also covers non-zero shell exits |
| Per-model-round event | `PostToolBatch` | no documented equivalent |
| Hook trust | project trust | project trust plus review of each command-hook definition |

The ChatGPT hook input retains useful common fields such as `session_id`,
`transcript_path`, `cwd`, and `hook_event_name`, but the transcript is explicitly
not a stable hook interface. Existing scripts that parse Claude transcripts
need a ChatGPT-specific implementation or a redesign that records state from
hooks as events happen.

## Tool-by-tool assessment

| Tool | Status | What a ChatGPT version needs |
| --- | --- | --- |
| `audit` | Adapt | Keep the workflow, but replace Claude tool vocabulary, `$ARGUMENTS`, and Claude-specific subagent waiting instructions. |
| `caveman` | Near-direct | Reuse the instructions and express explicit-only invocation in `agents/openai.yaml`. |
| `commit` | Adapt | Reuse `UserPromptSubmit` blocking, but add ChatGPT hook config and replace the unstable Claude-transcript write detector. |
| `create-skill` | Replace | Use ChatGPT's built-in skill creator; retain a harness version only if it adds repository-specific policy beyond the built-in. |
| `grill-me` | Near-direct | Reuse the instructions and map explicit-only invocation metadata. |
| `handoff` | Near-direct | Reuse the instructions and map its argument hint/explicit invocation behavior. |
| `improve-codebase-architecture` | Adapt | Core content is portable; rewrite the companion subagent exercise and Claude tool references. |
| `issues` | Adapt | Port the skills and `UserPromptSubmit` publisher, replace `${CLAUDE_SESSION_ID}` and shell interpolation, and test the ChatGPT transcript/context flow. |
| `on-edit-block` | Adapt | Match `apply_patch`, parse patch commands rather than `file_path`, and redesign read tracking around ChatGPT hook events. |
| `on-edit-reminder` | Adapt | Same edit/read changes as `on-edit-block`, with ChatGPT `PostToolUse` context output. |
| `on-read-reminder` | Adapt | Observe shell and local/MCP read calls that are visible to hooks; do not assume Claude's `Read` payload. |
| `prefer-edit-tool` | Claude Code-only | Do not port it. The Write/Edit-versus-shell behavior it corrects is a Claude Code-specific problem; ChatGPT already uses `apply_patch` as its native edit path. |
| `prefer-read-tool` | Claude Code-only | Do not port it. ChatGPT's documented CLI workflow uses shell and local tools for reads, so the Claude-specific Read-tool preference does not apply. |
| `redirect-subagents` | Adapt | ChatGPT hooks expose `spawn_agent` through the `Agent` matcher alias, but its input schema, custom-agent profiles, and delivery flow need a native implementation. |
| `senior-advisor` | Near-direct | Reuse the instructions and map explicit-only invocation metadata. |
| `usage-limit-wait` | Adapt | Keep the tool. ChatGPT subscription usage is governed by a weekly window rather than Claude Code's five-hour window, so the port needs a ChatGPT usage source, weekly reset handling, and a replacement for `PostToolBatch`. This is more work, not a capability blocker. |
| `zoom-out` | Near-direct | Reuse the instructions and map explicit-only invocation metadata. |

Claude Code-only tools should be visible in `list` and `info` for the Claude
target and reported as intentionally unsupported for the ChatGPT target. They
must not be installed as degraded or misleading variants. Their manifests now
record that status explicitly; `create-skill` likewise records its ChatGPT
replacement.

## Architecture foundation

The prerequisite installer refactor is now implemented. Platform selection is
explicit (`--platform claude|chatgpt`, defaulting to `claude`) and one adapter
owns each target's physical roots, config path, placeholders, legacy handling,
and restart guidance:

1. A `Platform` value (`claude` or `chatgpt`) is selected by the CLI, with
   `claude` retained as the backward-compatible default.
2. Layout and configuration behavior sit behind one platform adapter. It owns
   skill roots, hook roots, config paths, placeholder substitution, config
   merging, and platform-specific post-install guidance.
3. Manifest support can be explicit. Each tool declares `supported`,
   `replacement`, or `unsupported` for each platform rather than inheriting
   Claude support accidentally.
4. Installed files use logical `platform`, `skills`, or `hooks` roots instead
   of assuming `.claude`. The adapter maps a shared skill to `.claude/skills`
   or `.agents/skills` and hooks to the correct platform root.
5. Keep common payloads shared. Add `targets/chatgpt/` inside an individual
   tool only when its instructions, hook script, metadata, or fragment truly
   diverge. Do not create parallel top-level Claude and ChatGPT collections.
6. Native fragments are stored per platform. ChatGPT `hooks.json` is not
   synthesized from Claude `settings.fragment.json` because their command and
   field schemas differ.
7. Foundation tests cover adapter roots, shared and platform-specific payloads,
   native fragments, install/uninstall round trips, and CLI status. Each future
   hook port must add fixtures for ChatGPT's event wire format.

This creates one branch at the platform boundary. The existing install plan,
copy safety, gitignore handling, idempotence, and uninstall machinery can then
remain platform-agnostic.

## Suggested delivery order

1. Port and verify the near-direct skills.
2. Add small native hook ports: `on-read-reminder`, then the edit guard/reminder pair.
3. Port stateful workflows: `issues`, `commit`, `redirect-subagents`, and the
   weekly-window version of `usage-limit-wait`.

## Sources

The mirrored official references most relevant to this assessment are
[skills](./CHATGPT-REFERENCES/build-skills.md),
[hooks](./CHATGPT-REFERENCES/hooks.md),
[settings](./CHATGPT-REFERENCES/developer-settings.md),
[commands](./CHATGPT-REFERENCES/developer-commands.md),
[AGENTS.md](./CHATGPT-REFERENCES/agents-md.md),
[subagents](./CHATGPT-REFERENCES/subagents.md), and
[import](./CHATGPT-REFERENCES/import.md).
