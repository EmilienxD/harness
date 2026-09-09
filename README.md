# Harness

Harness is the canonical catalogue and installer for independently selectable agent skills,
hooks, command-line tools, and optional apps. It also owns visible standalone Claude sessions and
their parent/child reply state.

Run the pinned, ephemeral installer:

```bash
uvx --from git+https://github.com/EmilienxD/harness@v0.2.3 harness
```

That opens the one installation menu. The menu reconciles its selection: newly selected packages
are installed, deselected packages are removed, and mandatory dependencies remain transitive
selections. There are no separate install, uninstall, list, info, or upgrade commands. Rerun the
same pinned entry point to change or upgrade the installation. If a reconciliation step fails,
Harness restores the prior files, configuration, receipts, and completed host actions.

The wizard asks for tools first, followed by scope and platform. Use the arrow keys to move, Enter
to toggle or select, and Escape to return to the previous question. Claude Code and ChatGPT are
selected together by default. If a tool supports only one selected platform, Harness installs it
only there and discloses the skipped target in the review before making changes.

Use the arrow keys to move, Enter to toggle or select, and Escape to return to the previous
question. Tool selection comes first, followed by scope and platform. The default platform choice
installs for both Claude Code and ChatGPT. A tool that supports only one of them is installed only
there, and the review explains every skipped target before applying changes.

The catalogue can independently select the persistent Harness CLI, Aboard, skills, and hooks.
Aboard is a verified release artifact, not part of the Python wheel. Its manifest pins the URL,
byte size, and SHA-256 digest; Harness verifies all three before asking VS Code to install it.

The Aboard extension source and its complete Git history live under [`apps/aboard`](apps/aboard/).
It remains an independent npm build with `aboard-v<version>` release tags; Harness Python releases
continue to use `v<version>` tags.

## Visible sessions

When the persistent CLI is selected:

```bash
harness run [initial prompt]
harness ask <fresh-context prompt>
harness reply <answer>
harness resume <session-id>
```

`run` and `ask` open independent visible terminals and return immediately. `ask` binds the child
to the current Harness parent without accepting a caller-supplied parent ID. Each request can be
answered once, while the child remains open. SQLite stores session and request state under
`~/.harness/`; Claude hooks deliver replies with stable delivery IDs.

Configure a terminal explicitly in `~/.harness/config.json` when desired:

```json
{
  "claudeCommand": ["claude"],
  "terminalCommand": ["wt.exe", "new-tab", "--"]
}
```

Without `terminalCommand`, Harness detects Windows Terminal or a native console on Windows,
Terminal.app on macOS, and common terminal emulators on Linux. If none is available, it reports the
complete list it tried. Aboard integration for these commands is intentionally disabled; standalone
terminal launching is the only current path.

## Catalogue model

Each package lives under `harness/<name>/` and has a `harness.toml`. Manifests may declare platform
payloads, executable requirements, package dependencies with semantic version constraints, host
actions, and starter files.

Harness validates the complete dependency graph and all file claims before writing. Cycles,
incompatible catalogue versions, unsupported targets, missing executables, and cross-package file
collisions fail the operation. Receipts record versions, explicit/transitive ownership, installed
file digests, settings fragments, and host actions. Removal is dependent-aware and never deletes a
file changed since installation.

The Aboard package depends unconditionally on `auto`, `address-issue`, and `issue-review`.
Both worker skill bodies are intentionally empty placeholders until their prompts are designed.
The Harness-owned `/auto` hook fails closed outside an authenticated Aboard terminal.

## Repository layout

```text
harness/                 catalogue package payloads and manifests
src/harness_cli/         installer, receipts, host actions, and session CLI
tests/                   behavioural and install round-trip coverage
apps/aboard/             intended monorepo location for the Aboard extension
```

The recommended repository merge is a history-preserving subtree merge of Aboard into
`apps/aboard/`, without squashing. Keep Python packaging at the root and Aboard's npm package inside
that boundary; release automation can then publish the VSIX and update its pinned catalogue metadata
without coupling the two build systems.

## Development

```bash
uv run pytest
uv run harness --help
```
