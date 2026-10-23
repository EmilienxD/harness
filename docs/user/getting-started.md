# Get started

The Harness source repository is currently private, so these Git-based commands require repository access. Install [uv](https://docs.astral.sh/uv/getting-started/installation/) and launch the catalogue from the directory where you want project-level tools:

```bash
uvx --from "git+https://github.com/EmilienxD/harness" harness
```

Choose Claude Code, ChatGPT, Pi, or a combination; choose project or user scope; then select the tools you want. Harness shows its plan before changing files. Rerun the catalogue to add or remove selections. Restart a provider after installing hooks so it loads their registration. For Pi extensions, restart or run `/reload` and approve the project resources when Pi asks for trust. Pi itself is an external prerequisite.

For scripts, the installer has separate commands:

```bash
harness list
harness info subagents
harness install subagents --dry-run
harness install subagents
harness upgrade
harness uninstall subagents
```

If you run Harness through `uvx` without installing its CLI, prefix each command with `uvx --from "git+https://github.com/EmilienxD/harness"`. Installer commands default to the current project, Claude Code and ChatGPT. Pi is opt-in: use `--platform pi`. Use `--platform claude` or `--platform chatgpt` for another single target, `--scope user` for user installation, and `--root <path>` to choose a project. `--dry-run` previews a change. `--json` gives installer commands machine-readable output. A tool's guide lists its actual supported platforms; selecting a provider does not make every package available for it.

The installed tools expose their own names. Invoke a skill as `/skill-name` in Claude Code, `$skill-name` in ChatGPT, or `/skill:name arguments` in Pi. Pi appends arguments to the request; Claude's argument substitutions, fork semantics and tool permissions are not implied. Explicit-only skills retain `disable-model-invocation: true`; Pi's `enableSkillCommands` setting controls interactive discovery rather than authorization. Deterministic commands such as `/commit` have native handlers on Pi; their tool guides specify accepted spellings and options. The persistent-session CLI commands `run`, `ask`, `reply`, `resume`, and `watch` serve the [subagents](tools/productivity/subagents.md) workflow; they are separate from catalogue installation.

Next, use [Configuration](configuration.md) to identify files you can edit, or browse the [tool guides](index.md) to choose a package.
