# Configuration

Harness uses different files for different jobs. Begin by identifying the exact tool and scope before editing. A project installation usually writes under your project root; a user installation writes under your home directory. `HARNESS_STATE_DIR` changes the default `~/.harness` state location for the installer and persistent runtime.

| Path | Purpose | Edit or commit? |
| --- | --- | --- |
| `<project>/.harness/config.json` | Project settings for persistent launches and optional hosted Grill board | Edit; commit only shared, nonsecret values |
| `~/.harness/config.json` | Personal settings and fallback launch configuration | Edit; keep private |
| `<project>/.harness/config.local.json` | Private project Grill settings | Edit; keep untracked (the Grill package adds an ignore entry) |
| `<project>/.harness/guards/*.toml` | Project guard policies | Edit; normally commit |
| `~/.harness/guards/*.toml` | Personal guard policies | Edit; keep private |
| `<project>/.harness/agent-launcher/` | Project launcher scripts and native provider settings | Edit; review `config.py` before running |
| `~/.harness/receipts.json` | Installer ownership records | Let Harness manage it |
| `~/.harness/runtime/` | Persistent requests, sessions, and logs | Let Harness manage it |

`~/.harness` means the current user's home directory, not a folder in the project. On Windows, this is usually `C:\Users\<you>\.harness`. A project path starts at the directory where you installed or launched the tool.

## Launch settings: `config.json`

Create a JSON object with `"version": 1`; `{ "version": 1 }` is valid. For persistent launch settings, Harness reads the **first file that exists**: project `.harness/config.json`, then user `~/.harness/config.json`, then built-in defaults. It does not merge those files field by field. If the project file exists, put every desired launch override in that file; omitted settings use built-in defaults.

```json
{
  "version": 1,
  "autoRun": { "provider": "chatgpt" },
  "providers": {
    "chatgpt": {
      "command": ["codex"],
      "delegations": {
        "explore": { "model": "gpt-5.6-luna", "effort": "low" }
      }
    }
  },
  "session": { "stopWaitHours": 1 }
}
```

`autoRun.provider` chooses the automatic provider and defaults to `claude`. You can explicitly launch with `harness run --provider claude|chatgpt|pi`. `providers.<provider>.command` is the executable and optional arguments as a string or array; arrays preserve spaces inside arguments. `delegations` can configure `explore`, `prototype`, `websearch`, `brainstorm`, `address`, `review`, and `general` independently. Each accepts `model` and `effort`; `"inherit"` asks the native provider to choose. Explore defaults to Haiku/low for Claude, GPT-5.6 Luna/low for ChatGPT, and Pi's native model with low thinking. Other profiles inherit native provider settings. Harness's `pi` provider names the agent host; a qualified Pi model such as `service/model-id` selects its model service. See [subagents](tools/productivity/subagents.md) for model resolution and session behavior. `session.stopWaitHours` is a nonnegative number of hours to wait for an outstanding reply.

Edit JSON as JSON: no comments or trailing commas. Keep tokens, access codes, and other secrets out of project files that may be committed.

## Hosted Grill board

The `grill-me-in-cloud` tool uses a `grill` object in Harness configuration. Its `url` and four-digit `code` resolve independently, in this order: `.harness/config.local.json`, `.harness/config.json` (`url` only), user `~/.harness/config.json`, then `HARNESS_GRILL_URL` and `HARNESS_GRILL_CODE` environment variables. This field-level resolution differs from the whole-file launch configuration above.

Commit a shared board URL in the project file:

```json
{ "version": 1, "grill": { "url": "https://your-board.example" } }
```

Put the code in `.harness/config.local.json` or the user file, both outside version control:

```json
{ "version": 1, "grill": { "code": "1234" } }
```

The hosted application's server credentials are separate from these client settings; see the repository README for its deployment environment variables.

## Guard policies and other tool files

Guard policies use TOML rather than JSON. Each policy starts with `version = 1`. User rules load before project rules, so a project can append more specific rules. Installing a guard places a starter file at `.harness/guards/<tool>.toml` or `~/.harness/guards/<tool>.toml`; edit that starter instead of provider hook registration in `.claude/` or `.codex/`. The [guards guide](tools/guards-and-extensions.md) gives examples and explains the order of rules.

Installed Python hooks run with a persistent Python 3.11+ interpreter. Harness probes `python` then `py -3` on Windows, and `python3` then `python` on macOS/Linux. It records the probed interpreter's absolute path in Claude Code or ChatGPT hook configuration; a project or installer virtual environment is not selected. Set `HARNESS_PYTHON` to an executable path before installing or upgrading to choose a specific interpreter. An invalid override or an unavailable suitable interpreter stops installation with an error. The variable is read during installation; hooks do not need it afterward.

On Windows, Codex hook commands use the interpreter's absolute path with forward slashes and no surrounding quotes. Codex does not start the hook when that executable path is quoted. Because the path must be unquoted, installation fails if the selected Python path contains spaces. Claude Code stores the interpreter separately from its argument list and accepts the native absolute path.

Some tools keep separate settings. `agent-launcher` uses `.harness/agent-launcher/config.py` and related files. `report-gotchas` stores its private webhook at `~/.harness/report-gotchas/config.json`. Aboard uses `.abd/settings.json` and `aboard.*` VS Code settings. Open the relevant tool guide before changing one of these files.

## Installation roots and ownership

Harness owns selected payloads, dependency reconciliation, starter preservation and receipts. Native providers own authentication and sessions. Installing a tool does not change model defaults or take ownership of unrelated extensions, `auth.json`, or `trust.json`. Existing unowned files and host products require the installer's explicit adoption flow. Removal follows recorded ownership; modified files and edited policy starters retain the installer's preservation rules.

Pi's agent directory defaults to `~/.pi/agent`; `PI_CODING_AGENT_DIR` selects another directory. It changes Pi resources, while `HARNESS_STATE_DIR` changes Harness state. The resolved agent directory is part of user receipt identity: changing it selects a separate installation rather than redirecting removal of the original. A user receipt remains separate from a project rooted in the same directory.

| Resource | Project scope | Pi user scope |
| --- | --- | --- |
| Plain shared skills | `.pi/skills/<skill>/` | `<agent-dir>/skills/<skill>/` |
| Native package resources | `.pi/npm/node_modules/harness-pi-<tool>/` | `<agent-dir>/npm/node_modules/harness-pi-<tool>/` |
| Editable policy starters | `.harness/guards/<tool>.toml` | `<agent-dir>/harness/<tool>.toml` |

Shared home and project policies still apply after the Pi user starter. Each guard guide describes precedence and coverage. Pi user-scope workspace payloads use the home directory, sharing tool data such as `~/.harness/websearch/INDEX.md` across providers; editable user starters live outside npm packages. Plain shared skills use native skill discovery, including Pi's overlapping `.agents/skills` search. A ChatGPT-installed skill may therefore be visible to Pi: use startup diagnostics to check the selected source, and preserve the user's shared discovery settings.

### Package lifecycle and shared helpers

Upstream skill bridges declare an `upstream-skill` action with a GitHub `source` (`owner/repository`) and `skill` name. They contain no local payloads or host actions. Harness runs the upstream `skills add` installer in a temporary project, copies its output unchanged to the selected provider's skill root, and records file ownership normally. Acquisition uses npm and Git with network access; catalogue discovery and receipt-driven removal do not fetch upstream. Explicit upgrades acquire current content and include its fingerprint in the receipt version. Bridge packages do not maintain forks or provider-specific metadata.

Harness builds a complete npm archive for each selected extension package, bundling its extension entry points, skills and required helpers. It invokes `pi install npm:harness-pi-<tool>@file:<absolute archive>` (project scope adds `--local --approve`) and uses `pi remove` for the receipt-owned source. The immutable content-addressed archive remains in the receipt store's `pi-packages/` cache after uninstall because copied worktrees can still reference it. There is no second archive in the Pi configuration directory.

Pi owns npm metadata. Harness preserves resource filters, user declarations, unrelated models/tools/settings, and restores local files/settings when a native command fails. A trusted project package takes precedence over the same user npm identity; unrelated packages stay loaded. Plain local directory packages have separate absolute-path identities. This layout assumes fresh native npm installations; it does not provide a migration from earlier copied-extension layouts.

Source packages keep shared skills and Python cores at the package root, with shallow `pi/` entry-point overlays. Installed extensions live under `extensions/`, bundled helpers under `harness/`, and packaged skills under `skills/`. Helpers stay outside extension discovery, and ChatGPT metadata stays outside Pi skills. Deterministic actions use native Pi commands; their hook-backed skill shims are installed only for Claude Code and ChatGPT. Skills that prepare context and then ask the agent to work remain Pi skills. Real project trees such as `runtime/src/` retain their structure.

Internal dependencies are versioned, Pi-filtered and coupled; they are removed when the last consumer is removed. `pi-transport` supplies bounded, cancellable interpreter calls with versioned JSON/protocol validation; `pi-path-guards` supplies read/edit event translation and branch receipts; `pi-issue-workflows` supplies issue preparation/publication routing. Tool-specific policy, Git/GitHub logic and executable behavior stay with each tool. Selected dependency files are bundled into each native package, so its installation does not depend on Aboard or a separate loose helper tree. The independently installed `pi-subagents-toolkit` skill is shared by native subagents and its Python runtime.

Interpreter requests use literal argv and UTF-8 stdin, bounded responses, timeouts and cancellation. Python parsing and regular-expression semantics stay in the existing cores. Tools normalize native events rather than fabricating another provider's transcripts. Blocking guards fail closed on required helper/policy errors; informational tools preserve successful results and report diagnostics. Tool guides own their detailed contracts and acceptance evidence.

The [official configuration](https://github.com/EmilienxD/harness/blob/main/docs/PI-REFERENCES/docs/configuration.md), [packages](https://github.com/EmilienxD/harness/blob/main/docs/PI-REFERENCES/docs/packages.md) and [skills](https://github.com/EmilienxD/harness/blob/main/docs/PI-REFERENCES/docs/skills.md) references explain native behavior. The implementation baseline examined was Pi 1.2.0 at upstream revision `47fc5f38ec18d56fe64abd41a2dcf9e5170a3dcf`; the rolling mirror does not automatically certify a newer runtime. Project/user package-precedence journeys verify reload, copied checkouts, local-only updates, direct install/remove, disabled/untrusted resources, user precedence recovery and receipt separation. See the [E2E guide](https://github.com/EmilienxD/harness/blob/main/tests/e2e/README.md) for commands and verified environments.
