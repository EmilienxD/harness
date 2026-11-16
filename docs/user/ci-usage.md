# Install tools in scripts

Use the command-line installer when you want a repeatable setup without the interactive catalogue. Run it from the target project or supply `--root <path>`. The private source repository requires authenticated repository access.

## Preview and install

```bash
uvx --from "git+https://github.com/EmilienxD/harness" harness install command-guard --platform pi --dry-run
uvx --from "git+https://github.com/EmilienxD/harness" harness install command-guard --platform pi
```

Replace the tool and provider with your selections. Use `--scope user` only when you intend to affect all projects for that user. Add `--json` for machine-readable installer output. Installation does not sign in to an agent or provide model credentials. Project trust approval can still be required by your agent.

See [Get started](getting-started.md) for interactive installation and [Configuration](configuration.md) for scope and updates.
