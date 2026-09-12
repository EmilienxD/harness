# Harness

Harness is the canonical catalogue and ephemeral installer for independently selectable agent
skills, hooks, command-line tools, and optional apps. The `subagents` catalogue package owns
visible Claude Code and ChatGPT sessions and their durable delegation state.

Run the pinned, ephemeral installer:

```bash
uvx --from git+https://github.com/EmilienxD/harness@v0.4.0 harness
```

That opens the one installation menu. The menu reconciles its selection: newly selected packages
are installed, deselected packages are removed, and mandatory dependencies remain transitive
selections. There are no separate install, uninstall, list, info, or upgrade commands. Rerun the
same pinned entry point to change or upgrade the installation. If a reconciliation step fails,
Harness restores the prior files, configuration, receipts, and completed host actions.

The installer uses a compact guided flow: choose Claude Code and/or ChatGPT, choose project or user
scope, then select catalogue packages. Packages are grouped by category and start selected exactly
as they are installed for that scope and those providers. Compatibility is called out only when a
selected provider is unsupported. Type to filter the list; Arrow keys, Page Up/Down, Home, and End
move; Space toggles an item or category; Left and Right collapse or expand categories; and the
Select All row selects the complete catalogue or clears only newly selected packages, preserving
packages that were already installed. Enter confirms a step and Escape or Ctrl+C cancels without
changing the installation. A summary lists every install, upgrade, removal, and skipped target
before the final confirmation. A package that supports only one chosen provider is installed only
there.

The catalogue exposes `subagents` as one complete workflow alongside Aboard and standalone skills.
Its hooks and persistent runtime are internal dependencies, not separate catalogue choices. Aboard
is a verified release artifact, not part of the Python wheel. Its manifest pins the URL, byte size,
and SHA-256 digest; Harness verifies all three before asking VS Code to install it.

The planning catalogue also includes `lavish`, which turns plans, comparisons, diagrams, reports,
and other visual responses into browser-based HTML artifacts that users can annotate and return for
feedback.
New standalone skills include Productivity's `stop-overthinking`, Planning's `read-all-adrs`, and
Shipping's `setup-help`, all for Claude Code and ChatGPT.
Engineering's `resolving-merge-conflicts` helps resolve in-progress Git merge and rebase conflicts.

The Aboard extension source and its complete Git history live under [`apps/aboard`](apps/aboard/).
It remains an independent npm build with `aboard-v<version>` release tags; Harness Python releases
continue to use `v<version>` tags.

## Visible sessions

When `subagents` is selected, its persistent runtime is installed automatically:

```bash
harness run [--provider claude|chatgpt] [initial prompt]
harness ask <grant-id>
harness reply
harness resume <session-id>
```

`run` opens an independent visible terminal. Delegation is available only after the user directly
invokes `ask-agent`, `ask-agent-to-explore`, `ask-agent-to-prototype`,
`ask-agent-to-websearch`, or `ask-agent-to-brainstorm`. The invocation opens an unpredictable inbox
under `<original-cwd>/.harness/runtime/`; the parent writes one Markdown request per child and a
structured file-write hook launches each valid request. Direct `harness ask` calls without that live
grant are rejected.

Auto children report their next successful Stop automatically. Interactive children report only
after the user invokes `reply-to-agent`, which arms one successful Stop; an API failure clears the
authorization and leaves the request pending. SQLite under `~/.harness/` stores grants, requests,
stable agent numbers, and at-least-once delivery claims.

Each request is a direct, non-symlink `*.md` child of the granted inbox:

```markdown
---
task: prototype
provider: chatgpt
mode: interactive
---

A complete, fresh-context description of the work.
```

`task` and `mode` are required; `provider` defaults to the parent provider. Explore supports only
`auto`; prototype and websearch support `interactive` or `auto`; brainstorm supports only
`interactive`; and general delegation supports either mode. Explore is technically read-only.

Provider launch settings resolve from `<project>/.harness/launch.json`, then
`~/.harness/launch.json`, then built-in defaults. A minimal file is:

```json
{
  "version": 2,
  "platform": "claude",
  "command": ["claude"],
  "stopWaitHours": 24
}
```

Configure the native terminal launcher separately in `~/.harness/config.json`, for example
`{"terminalCommand":["wt.exe","new-tab","--"]}`.

Without `terminalCommand`, Harness uses a matching initialized Aboard window when available, then
detects Windows Terminal or a native console on Windows,
Terminal.app on macOS, and common terminal emulators on Linux. If none is available, it reports the
complete list it tried.

## Catalogue model

Each package lives under a functional category in `harness/` and has a `harness.toml`. The catalogue
discovers manifests recursively outside `harness/archive/`, which also lets a package keep private
workflow dependencies such as `extension/auto` and the ask/reply components under
`productivity/subagents`. Manifests may declare platform payloads, executable requirements, package
dependencies with semantic version constraints, host actions, and starter files.
Dependency-only manifests set `selectable = false`; they remain available to dependency resolution
but do not appear as direct choices in the installer.

Harness validates the complete dependency graph and all file claims before writing. Cycles,
incompatible catalogue versions, unsupported targets, missing executables, and cross-package file
collisions fail the operation. Receipts record versions, explicit/transitive ownership, installed
file digests, settings fragments, and host actions. Removal is dependent-aware and never deletes a
file changed since installation.

The Aboard package depends unconditionally on the hidden `auto` package and on `issue-readers`. The
reader bundle includes
the intentionally empty `address-this` and `review-this` worker skill placeholders, so initializing
Aboard installs the implementation and review workflows without also installing issue drafting and
publishing.
The Harness-owned `/auto` hook fails closed outside an authenticated Aboard terminal.

## Repository layout

```text
harness/planning/        planning and discovery workflows
harness/building/        issue implementation and test-driven development
harness/shipping/        delivery workflows
harness/productivity/    delegation and general productivity skills
harness/guards/          command and tool-use guardrails
harness/extension/       extension catalogue entries and their internal dependencies
harness/archive/         archived packages excluded from catalogue discovery
src/harness_cli/         ephemeral installer, receipts, host actions, and catalogue TUI
harness/productivity/subagents/ complete ask/reply skills, hooks, and persistent runtime
harness/engineering/setup-git-worktree-maker/ project-native Git worktree command skill
harness/planning/lavish/ browser-based HTML artifact and annotation workflow
tests/unit/              behavioural and install round-trip coverage
tests/e2e/               reusable real-CLI and loopback-endpoint E2E core
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

Reusable end-to-end infrastructure and tool journeys are documented in [`tests/e2e/README.md`](tests/e2e/README.md). Aboard keeps only its repository, extension-host, lifecycle, and scenario adapters under `apps/aboard/test/e2e/`.
