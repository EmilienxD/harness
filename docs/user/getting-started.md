# Get started

The Harness source repository is currently private, so these Git-based commands require repository access. Install [uv](https://docs.astral.sh/uv/getting-started/installation/) and launch the catalogue from the directory where you want project-level tools:

```bash
uvx --from "git+https://github.com/EmilienxD/harness" harness
```

Choose Claude Code, ChatGPT, or both; choose project or user scope; then select the tools you want. Harness shows its plan before changing files. Rerun the catalogue to add or remove selections. Restart a provider after installing hooks so it loads their registration.

For scripts, the installer has separate commands:

```bash
harness list
harness info subagents
harness install subagents --dry-run
harness install subagents
harness upgrade
harness uninstall subagents
```

If you run Harness through `uvx` without installing its CLI, prefix each command with `uvx --from "git+https://github.com/EmilienxD/harness"`. Installer commands default to the current project and both providers. Use `--platform claude` or `--platform chatgpt`, `--scope user`, and `--root <path>` to narrow the destination. `--dry-run` previews a change. `--json` gives installer commands machine-readable output.

The installed tools expose their own names. Invoke a skill as `/skill-name` in Claude Code or `$skill-name` in ChatGPT. Hook-backed commands such as `/commit` run at provider lifecycle boundaries. The persistent-session CLI commands `run`, `ask`, `reply`, `resume`, and `watch` serve the `subagents` workflow; they are separate from catalogue installation.

Next, use [Configuration](configuration.md) to identify files you can edit, or browse the [tool guides](index.md) to choose a package.
