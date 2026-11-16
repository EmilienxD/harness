# Get started

Harness lets you choose the tools you want for Claude Code, ChatGPT, and Pi. Install them for one project or make them available across all your projects.

## Before you start

Install [uv](https://docs.astral.sh/uv/getting-started/installation/), then install and sign in to the agent you want to use. The source repository is currently private, so you also need repository access.

## Choose your tools

Open a terminal in the project where you want to use Harness and launch the interactive catalogue:

```bash
uvx --from "git+https://github.com/EmilienxD/harness" harness
```

1. Choose your agent or agents.
2. Choose project scope for this repository or user scope for all your projects.
3. Select the tools you want and review the installation plan before applying it.
4. Restart your agent. In Pi, restart or run `/reload` and approve project resources when asked.

Each tool is independently selectable. You can reopen the catalogue whenever you want to change your selection.

## Install from the command line

The guides use `harness` as shorthand. If the command is not installed, prefix it with `uvx --from "git+https://github.com/EmilienxD/harness"`. For example:

```bash
uvx --from "git+https://github.com/EmilienxD/harness" harness install grill-me-in-cloud --platform pi
```

Use these options to control the installation:

| Option | Purpose |
| --- | --- |
| `--platform claude`, `--platform chatgpt`, or `--platform pi` | Choose one agent |
| `--scope user` | Install across your projects |
| `--root <path>` | Choose another project |
| `--dry-run` | Preview changes without applying them |

Without a platform option, installer commands select Claude Code and ChatGPT. Check the tool guide for supported agents and any extra prerequisites.

## Use a tool

Skill commands depend on your agent:

| Agent | Invocation |
| --- | --- |
| Claude Code | `/tool-name` |
| ChatGPT | `$tool-name` |
| Pi | `/skill:tool-name` |

Some tools provide shorter commands or work automatically. Follow their individual guides.

## What to try first

- [Grill me in cloud](tools/workflows/grill-me-in-cloud.md) for visual design interviews on your private board.
- [Grill me](tools/workflows/grill-me.md) for a design interview entirely in the conversation.
- [Subagents](tools/productivity/subagents.md) for delegating work to persistent agent conversations.
- [Aboard](tools/extensions/aboard.md) for managing agent sessions in VS Code.

## Manage your selection

```bash
harness list
harness info grill-me-in-cloud
harness upgrade
harness uninstall grill-me-in-cloud
```

Use the same platform and scope when updating or removing an installation. See [Configuration](configuration.md) for connection settings and guard policies.
