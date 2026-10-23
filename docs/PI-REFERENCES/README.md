# Pi references

Official documentation and selected integration examples for the open-source Pi coding agent.
The canonical upstream is [earendil-works/pi](https://github.com/earendil-works/pi);
`badlogic/pi-mono` redirects there. The mirrored package metadata identifies the current namespace
and version; older guides using `@mariozechner/pi-coding-agent` may describe different APIs.

## Start here

- Skills and invocation: [skills](docs/skills.md), [slash commands](docs/slash-commands.md).
- Install layout and trust: [configuration](docs/configuration.md), [settings](docs/settings.md),
  [security](docs/security.md).
- Hook replacements: [extensions](docs/extensions.md), [API declarations](src/core/extensions/types.ts).
- Persistent sessions and orchestration: [CLI](docs/cli.md), [sessions](docs/sessions.md),
  [session format](docs/session-format.md), [JSON events](docs/json.md), [RPC](docs/rpc.md), [SDK](docs/sdk.md).
- Harness behavior, support and acceptance evidence: [tool guides](../user/index.md).
- Installation roots, ownership and packaging: [configuration](../user/configuration.md#installation-roots-and-ownership).

## Maintenance

The source index below is consumed by `scripts/update_references.py`. Refresh from the repository root:

```bash
uv run python scripts/update_references.py docs/CLAUDE-REFERENCES docs/CHATGPT-REFERENCES docs/PI-REFERENCES
```

The daily/manual `update-references` GitHub Actions workflow refreshes all three sets and commits
changed mirrors. Source URLs track upstream `main`; they are not a supported-runtime version pin.
Each tool guide records its relevant implementation evidence and acceptance limits independently.

Payloads are unmodified upstream text, covered by the mirrored MIT [license](LICENSE).
Upstream-relative directories are retained where practical. This is a curated mirror, not a runnable
Pi checkout: links to unmirrored examples, docs, and assets should be followed in upstream.
Example code and API declarations are references, not Harness-installed extensions.

## Source index

- [Pi coding agent](./upstream-README.md)
  - Source: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/README.md

- [Package metadata](./package.json)
  - Source: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/package.json

- [License](./LICENSE)
  - Source: https://raw.githubusercontent.com/earendil-works/pi/main/LICENSE

- [index.md](./docs/index.md)
  - Source: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/index.md

- [quickstart.md](./docs/quickstart.md)
  - Source: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/quickstart.md

- [cli.md](./docs/cli.md)
  - Source: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/cli.md

- [usage.md](./docs/usage.md)
  - Source: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/usage.md

- [configuration.md](./docs/configuration.md)
  - Source: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/configuration.md

- [settings.md](./docs/settings.md)
  - Source: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/settings.md

- [skills.md](./docs/skills.md)
  - Source: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/skills.md

- [extensions.md](./docs/extensions.md)
  - Source: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/extensions.md

- [packages.md](./docs/packages.md)
  - Source: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/packages.md

- [prompt-templates.md](./docs/prompt-templates.md)
  - Source: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/prompt-templates.md

- [slash-commands.md](./docs/slash-commands.md)
  - Source: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/slash-commands.md

- [sessions.md](./docs/sessions.md)
  - Source: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/sessions.md

- [session-format.md](./docs/session-format.md)
  - Source: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/session-format.md

- [compaction.md](./docs/compaction.md)
  - Source: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/compaction.md

- [message-types.md](./docs/message-types.md)
  - Source: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/message-types.md

- [json.md](./docs/json.md)
  - Source: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/json.md

- [rpc.md](./docs/rpc.md)
  - Source: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/rpc.md

- [rpc-commands.md](./docs/rpc-commands.md)
  - Source: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/rpc-commands.md

- [rpc-extension-ui.md](./docs/rpc-extension-ui.md)
  - Source: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/rpc-extension-ui.md

- [sdk.md](./docs/sdk.md)
  - Source: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/sdk.md

- [cli-integration.md](./docs/cli-integration.md)
  - Source: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/cli-integration.md

- [providers.md](./docs/providers.md)
  - Source: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/providers.md

- [models.md](./docs/models.md)
  - Source: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/models.md

- [custom-provider.md](./docs/custom-provider.md)
  - Source: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/custom-provider.md

- [virtual-models.md](./docs/virtual-models.md)
  - Source: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/virtual-models.md

- [environment-variables.md](./docs/environment-variables.md)
  - Source: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/environment-variables.md

- [security.md](./docs/security.md)
  - Source: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/security.md

- [containerization.md](./docs/containerization.md)
  - Source: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/containerization.md

- [mcp.md](./docs/mcp.md)
  - Source: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/mcp.md

- [codemode.md](./docs/codemode.md)
  - Source: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/codemode.md

- [how-pi-works.md](./docs/how-pi-works.md)
  - Source: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/how-pi-works.md

- [windows.md](./docs/windows.md)
  - Source: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/windows.md

- [terminal-setup.md](./docs/terminal-setup.md)
  - Source: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/terminal-setup.md

- [tui.md](./docs/tui.md)
  - Source: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/tui.md

- [examples/README.md](./examples/extensions/README.md)
  - Source: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/examples/extensions/README.md

- [examples/confirm-destructive.ts](./examples/extensions/confirm-destructive.ts)
  - Source: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/examples/extensions/confirm-destructive.ts

- [examples/protected-paths.ts](./examples/extensions/protected-paths.ts)
  - Source: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/examples/extensions/protected-paths.ts

- [examples/permission-gate.ts](./examples/extensions/permission-gate.ts)
  - Source: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/examples/extensions/permission-gate.ts

- [examples/tool-override.ts](./examples/extensions/tool-override.ts)
  - Source: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/examples/extensions/tool-override.ts

- [examples/input-transform.ts](./examples/extensions/input-transform.ts)
  - Source: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/examples/extensions/input-transform.ts

- [examples/notify.ts](./examples/extensions/notify.ts)
  - Source: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/examples/extensions/notify.ts

- [examples/handoff.ts](./examples/extensions/handoff.ts)
  - Source: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/examples/extensions/handoff.ts

- [examples/session-name.ts](./examples/extensions/session-name.ts)
  - Source: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/examples/extensions/session-name.ts

- [examples/subagent/README.md](./examples/extensions/subagent/README.md)
  - Source: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/examples/extensions/subagent/README.md

- [examples/subagent/index.ts](./examples/extensions/subagent/index.ts)
  - Source: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/examples/extensions/subagent/index.ts

- [examples/subagent/agents.ts](./examples/extensions/subagent/agents.ts)
  - Source: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/examples/extensions/subagent/agents.ts

- [Extension API types](./src/core/extensions/types.ts)
  - Source: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/core/extensions/types.ts
