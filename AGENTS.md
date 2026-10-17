# AGENTS.md

## Project Shape

Harness is the canonical catalogue and installer for independently selectable agent skills, hooks,
command-line tools, and optional apps for Claude Code, ChatGPT, and Pi. Pi catalogue support includes
25 shared skill packages, the `web-toolkit` CLI and skill, three path-guard extensions, the command guard, comment budgets, document draft approval, Git cleanup inventory,
two issue workflow extensions, session commits, desktop notifications, gotcha reports, a background shell,
a native cloud interview relay, and persistent subagents; other extensions remain proposed. Its deterministic real-CLI E2E environment is
available. Harness also owns persistent visible-session
commands and ask/reply state.

`uvx --from <pinned source> harness` opens the interactive catalogue menu by default and also exposes the
non-interactive installer commands `install`, `uninstall`, `upgrade`, `list`, and `info`. Keep installer
operations distinct from the persistent-session commands `run`, `ask`, `reply`, and `resume`.

## Repository Layout

- `src/harness_cli/`: Ephemeral Python installer, catalogue, platform adapters, receipts, settings
  merging, and TUI.
- `harness/productivity/subagents/`: Complete ask/reply bundle with internal provider hooks and an independently
  packaged persistent Python runtime.
- `harness/<category>/<tool>/`: installable packages. User-facing documentation is centralized in the root
  `README.md`; inspect a platform `SKILL.md` only when implementation details are needed.
- `harness/vscode/`: Aboard's VS Code installer package and its coupled Auto Run integration.
- `harness/internal/`: non-selectable shared dependencies. Pi transport, path guards, and issue
  workflows are separate packages; tool-specific entry points and policy cores stay with their tools.
- `apps/aboard/`: the sole documentation exception, with its own user-facing `README.md` and local `AGENTS.md`
  navigation map.
- `tests/unit/`: installer, catalogue, platform, settings, receipt, and session tests.
- `tests/e2e/`: deterministic real-CLI E2E infrastructure shared with Aboard.
- `docs/CLAUDE-REFERENCES/`: mirrored official Claude Code documentation.
- `docs/CHATGPT-REFERENCES/`: mirrored official ChatGPT documentation.
- `docs/PI-REFERENCES/`: mirrored official Pi documentation, API declarations, and selected extension examples.
- `docs/PI-COMPATIBILITY.md`: catalogue-wide Pi feasibility and API evidence.
- `docs/PI-ARCHITECTURE.md`: proposed Pi provider boundaries, requested 35-package backlog, and implementation gates.
- `docs/CHATGPT-COMPATIBILITY.md`: native ChatGPT target feasibility and implementation map.
- `scripts/update_references.py`: refreshes the mirrored upstream documentation.

## Catalogue Package Shape

Each installable tool lives below a category directory and has a `harness.toml` with `name`, `version`,
`description`, and at least one
`[[files]]` or `[[actions]]` entry. Bump `version` whenever its payload, fragment, dependency, or action
changes; a tool without a manifest is invisible to the installer.
Packages below `harness/archived/` and `harness/deprecated/` are retained for reference and excluded from catalogue discovery.

Shared payloads live at the package root; shallow product folders are overlays:

```text
harness/<category>/<tool>/
├── harness.toml
├── SKILL.md          # one shared skill, with support files beside it
├── <skill>/         # each shared skill when a package contains several
├── <tool_name>_hook.py  # shared Python policy/core and current hook entry points
├── <support>.py     # modules the hook imports, installed beside it
├── claude/           # shallow Claude-only files and settings.fragment.json
├── chatgpt/          # shallow ChatGPT-only files and hooks.fragment.json
└── pi/               # proposed Pi-only extension entry points, when implemented
```

Omit empty overlays. Keep manifests and product-neutral documentation at the tool root. Each skill
stores its ChatGPT metadata in `chatgpt/openai.yaml`, with `chatgpt/` beside its associated `SKILL.md`.
For multi-skill packages, this is `<skill>/chatgpt/openai.yaml`. Manifests map shared skill files and
metadata explicitly to installed `skills/` destinations, keeping source overlays out of installed
skill directories. Claude/ChatGPT hook payloads map to `hooks`; Pi helpers map to `support`.
Preserve real internal project trees such as `runtime/src/`; never mirror installation roots inside overlays or restore a `targets/` override directory.

## Pi Provider Work

For Pi installer, package, extension, or session work, read `docs/PI-ARCHITECTURE.md` first; it owns
the initial rollout scope and architecture proposal. Use `docs/PI-COMPATIBILITY.md` for feasibility
outside that scope and `docs/PI-REFERENCES/README.md` to reach the relevant official API evidence.

- Keep proposed support distinct from shipped support in documentation and catalogue declarations.
  Add Pi mappings and bump package versions when the corresponding payload/support ships.
- Reuse shared skills and Python cores. Put native Pi translation in shallow `pi/` overlays and
  map executable entry points to `extensions` and Python/TypeScript helpers to `support`
  (`.pi/harness/` for projects, `<PI_CODING_AGENT_DIR>/harness/` for users).
- Handle providers explicitly; replace binary Claude/ChatGPT fallbacks when extending a boundary.
- Reconstruct Pi state from active session ancestry and observed tool outcomes, including nested
  calls. Required guard loading and tool coverage need evidence before a restricted launch.
- Verify deterministic commands through effects and inference-request counts, and guards through
  denied mutations.

## Commands

From the repository root:

```powershell
uv sync
uv run harness
uv run harness --help
uv run pytest
uv run python scripts/update_references.py docs/CLAUDE-REFERENCES docs/CHATGPT-REFERENCES docs/PI-REFERENCES
```

For Aboard commands, work from `apps/aboard/` and follow its local `AGENTS.md`.

## Tests

- Run `uv run pytest` after catalogue or installer changes; the suite covers reconciliation and
  receipt-driven removal.
- Use the `harness-e2e` skill for work under `tests/e2e/` or `apps/aboard/test/e2e/`.
- For Pi tool acceptance, use the real JSON/RPC fixture in `tests/e2e/README.md`; assert effects,
  session outcomes, and request counts. Mocked hook tests alone do not establish Pi support.
- Consult the mirrored official references for product behavior instead of relying on memory.
- Never assert exact or partial equality against agent prompt strings, because prompt text is not a meaningful contract and checks like the presence of "review" are useless.

## References

- Use the `writing-for-agents` skill when writing or updating skills, agent rules, or agent-facing references.
- For provider skills, hooks/extensions, configuration, sessions, or permissions, consult `docs/CHATGPT-REFERENCES/`, `docs/CLAUDE-REFERENCES/`, or `docs/PI-REFERENCES/` before relying on memory. Complete your search with web searches if you cannot find what you need there.
