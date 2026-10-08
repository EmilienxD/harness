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

`autoRun.provider` chooses the automatic provider and defaults to `claude`. You can still explicitly launch either provider with `harness run --provider claude|chatgpt`. `providers.<provider>.command` is the executable and optional arguments as a string or array; arrays preserve spaces inside arguments. `delegations` can configure `explore`, `prototype`, `websearch`, `brainstorm`, `address`, `review`, and `general` independently. Each accepts `model` and `effort`; `"inherit"` asks the native provider to choose. Explore defaults to Haiku/low for Claude and GPT-5.6 Luna/low for ChatGPT. Other profiles inherit native provider settings. `session.stopWaitHours` is a nonnegative number of hours to wait for an outstanding reply.

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

Some tools keep separate settings. `agent-launcher` uses `.harness/agent-launcher/config.py` and related files. `report-gotchas` stores its private webhook at `~/.harness/report-gotchas/config.json`. Aboard uses `.abd/settings.json` and `aboard.*` VS Code settings. Open the relevant tool guide before changing one of these files.
