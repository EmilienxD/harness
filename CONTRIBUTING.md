# Contributing to Harness

Thank you for helping improve Harness. The repository contains two release boundaries: the Python
catalogue installer at the root and the independently built Aboard VS Code extension under
`apps/aboard/`.

Security vulnerabilities should be reported privately as described in `SECURITY.md`, not opened as
public issues.

## Development setup

The root project requires Python 3.11 or newer and `uv`.

```powershell
uv sync
uv run harness --help
uv run pytest
```

The shared real-CLI E2E suite additionally requires Node.js 22, npm, Git, and installed Claude Code
and Codex CLIs, plus Pi 1.2.x for its new journeys:

```powershell
cd tests/e2e
npm ci
npm run check
npm test
```

Pi-only preparation needs Node.js >=22.19.0 and the Pi CLI. Run `npm run e2e:pi` and
`npm run test:pi` from `tests/e2e/`; [the E2E guide](tests/e2e/README.md) explains the isolated
agent configuration and how to stage a tool's real payload. Acceptance should exercise the CLI
and observable effects; unit tests that mirror an implementation are insufficient evidence.

Aboard has its own npm boundary:

```powershell
cd apps/aboard
npm ci
npm run check
npm test
npm run test:vscode
npm run package
```

Do not run Aboard's bootstrap command against the shared E2E repository during routine development.
It deletes and recreates that repository and requires explicit authorization and the safety checks
documented in the `harness-e2e` skill.

## Making changes

- Keep installer commands (`install`, `uninstall`, `upgrade`, `list`, and `info`) separate from the
  persistent session runtime (`run`, `ask`, `reply`, and `resume`).
- Keep platform-specific path mapping inside the Claude, ChatGPT, and Pi adapters.
- Preserve receipt-first removal and never overwrite a user-edited starter file.
- Keep Aboard's source, npm build, VSIX, version history, and release tags independent from the
  Python package.
- Do not fill the user-owned prompt placeholders shipped by `address-this`, `review-this`, prototype,
  websearch, work-with-agent, or reply-to-agent workflows.
- Consult the checked-in official product references before changing hooks, settings, CLI flags,
  sessions, sandboxing, or gateway behavior.

Every installable catalogue package needs a `harness.toml`. Increment its version whenever a payload,
fragment, dependency, or action changes. Use explicit version constraints for package dependencies;
reserve `requires` for executables expected on `PATH`.

## Tests and pull requests

Prefer a focused behavioral test at the public boundary of the change, then run the relevant full
suite. Catalogue or installer changes require `uv run pytest`. Shared E2E changes require the TypeScript
check, focused journey, and `npm test`. Aboard changes require its check, unit tests, package build, and
the relevant extension-host or E2E journey.

Before opening a pull request:

1. Keep the change focused and remove generated files, credentials, transcripts, and local runtime
   state.
2. Update package versions required by the catalogue rules.
3. Run the applicable commands above and include the results in the pull request.
4. Explain user-visible behavior, compatibility implications, and any checks that could not be run.

By contributing, you agree that your contribution is licensed under the repository's MIT License.
