# Configuration

Install only the tools you need. Most skills work as soon as you install them. Choose project scope for one repository. Choose user scope for tools you want across projects. Use the relevant [tool guide](index.md) for tool-specific options. Keep access codes, API keys, and other secrets out of version control.

## Choose a provider and scope

```bash
harness install grill-me-in-cloud --platform pi
harness install command-guard --platform claude --scope user
harness install subagents --platform chatgpt --root <project-directory>
```

- Replace the tool name with the package you want.
- Use `--platform claude`, `--platform chatgpt`, or `--platform pi` to select your agent.
- Without a platform option, installer commands select Claude Code and ChatGPT.
- Use `--dry-run` to preview changes.
- Restart your agent after installation. In Pi, you can use `/reload` instead.

## Hosted Grill board

[Grill me in cloud](tools/workflows/grill-me-in-cloud.md) connects to your own private deployment. Set `HARNESS_GRILL_URL` to your deployment URL in the environment that launches the agent. Set `HARNESS_GRILL_CODE` to your deployment's four-digit access code. Use the same connection settings for Aboard if you want to send answers through it. Never use another user's private deployment address.

Private project settings take priority over shared project settings, personal settings, and environment variables. The address and code can come from different settings. If the connection is unexpected, check for older private overrides. Shared project settings can supply the address, but not the private code.

## Agent launches

[Subagents](tools/productivity/subagents.md) lets you choose the provider, model, effort, and working directory for delegated work. Ask for interactive mode when you want a visible child conversation. Ask for automatic mode when the work should run in the background and return a result. Launch settings use the first available configuration at project scope, then user scope, then built-in defaults. They are not merged.

[Aboard](tools/extensions/aboard.md) has separate VS Code settings for its panel and Auto Run.

## Guard policies

Install a guard, then customize its installed policy if your repository needs different rules. Read and edit reminders need rules that identify the affected paths and required guidance. Command Guard includes starter rules for common dangerous commands. Harness preserves your policy edits during upgrades. Start the agent in the project where you configured the policy.

Guards help prevent mistakes in supported tool calls. They are not security sandboxes.

See [Guards and extensions](tools/guards-and-extensions.md) to choose a guard.

## Update or remove tools

```bash
harness list
harness upgrade
harness uninstall command-guard
```

Use the same provider and scope options you used for installation. Harness manages its installed components and leaves unrelated agent settings alone. Review any preservation messages about files you customized. Your agent still manages its own sign-in and model access.
