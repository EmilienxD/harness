# Guards and extensions

Guards install provider hooks or native Pi extensions. Install one, then restart the selected provider so it reloads the registration. Run the Harness catalogue to choose packages, platforms, and project or user scope:

```bash
uvx --from "git+https://github.com/EmilienxD/harness" harness
```

For a scripted project install, use `harness install command-guard no-new-documents`; add `--platform claude` or `--platform chatgpt` when needed. For Pi document protection, use `harness install no-new-documents --platform pi`. `--scope user` installs at user scope, and `--root <path>` chooses another project. Use `harness list` to inspect selections and `harness info <name>` for package details. Installed starter policies are preserved when you upgrade.

| Package | Platforms | Purpose |
| --- | --- | --- |
| [`aboard`](extensions/aboard.md) | Claude Code, ChatGPT, Pi | Aboard VS Code integration for interactive and background agents and Auto Run |
| [`auto`](extensions/auto.md) | Claude Code, ChatGPT, Pi | Routes /auto and /auto --dry to an active Aboard session |
| [`command-guard`](guards/command-guard.md) | Claude Code, ChatGPT, Pi | Cross-platform PreToolUse guard that denies configured dangerous Bash and PowerShell commands |
| [`exclude-unwanted-tools`](guards/exclude-unwanted-tools.md) | Pi | Exclude powershell, codemode, find, grep, and ls from Pi's tool registry |
| [`no-new-documents`](guards/no-new-documents.md) | Claude Code, ChatGPT, Pi | Cross-platform guard that routes new files in configured documentation directories through user-approved drafts |
| [`on-edit-block`](guards/on-edit-block.md) | Claude Code, ChatGPT, Pi | PreToolUse hook that denies Write/Edit/MultiEdit on files matching gitignore-style patterns until the agent has read the required files |
| [`on-edit-reminder`](guards/on-edit-reminder.md) | Claude Code, ChatGPT, Pi | PostToolUse hook that lets edits to files matching gitignore-style patterns land, then makes the agent read the required files and fix what doesn't follow them |
| [`on-read-reminder`](guards/on-read-reminder.md) | Claude Code, ChatGPT, Pi | PostToolUse hook that reminds the agent to read key files when it reads paths matching gitignore-style patterns |
| [`prefer-edit-tool`](guards/prefer-edit-tool.md) | Claude Code | PostToolUse nudge to prefer the Write/Edit tools over heredocs, redirects, sed -i and inline python for file writes |
| [`prefer-fewer-comments`](guards/prefer-fewer-comments.md) | Claude Code, ChatGPT, Pi | Advisory comment and docstring budgets over newly written commentary, with native Pi mutation snapshots |
| [`prefer-read-tool`](guards/prefer-read-tool.md) | Claude Code | PostToolUse nudge to prefer the Read tool over shell file-read commands |
| [`redirect-subagents`](guards/redirect-subagents.md) | Claude Code | Redirect Claude Code's built-in Agent tool subagents to alternate providers, avoiding Claude subscription usage |
| [`slash-command-guard`](guards/slash-command-guard.md) | Pi | Reject unknown leading slash commands in Pi before they reach the model |
| [`usage-limit-wait`](guards/usage-limit-wait.md) | Claude Code, ChatGPT | Blocks the session until an exhausted Claude or ChatGPT subscription usage window resets, instead of failing the turn |

## Configure guard policies

Editable policies live at `.harness/guards/<package>.toml` for a project or `~/.harness/guards/<package>.toml` for user scope. All begin with `version = 1`. User rules load first and project rules follow; ordered exclusions or exemptions can override earlier matches. The `.claude/` and `.codex/` folders contain provider hook registration and executables, not these policies. The `prefer-read-tool`, `prefer-edit-tool`, `redirect-subagents`, and `usage-limit-wait` packages have no TOML starter policy.

The three read/edit guards share ordered rules with gitignore-style path patterns (`*`, `?`, `**`). Put this example in the corresponding `on-edit-block.toml`, `on-edit-reminder.toml`, or `on-read-reminder.toml` and choose the timing you need:

```toml
version = 1

[[rules]]
patterns = ["server/**/models/**", "**/*.sql"]
require = ["docs/CONVENTIONS.md"]

[[rules]]
patterns = ["vendor/**"]
exclude = true
```

The installed read/edit policies contain commented examples, so configure at least one rule to make them useful. A matching exclusion clears requirements from earlier rules.

Each tool guide owns its policy schema, invocation, examples and provider differences. Open [No New Documents](guards/no-new-documents.md) for draft approval, [comment budgets](guards/prefer-fewer-comments.md) for comment limits, [subagent redirection](guards/redirect-subagents.md) for Claude routing, or [Aboard](extensions/aboard.md) and [Auto](extensions/auto.md) for visible workers and queue control.

## Read/edit guard implementation and verification

The three guards at 2.3.0 share the internal `path-guard-common` 1.0.0 dependency across Claude, ChatGPT and Pi. It owns shell path extraction and complete shell-read verification. Native provider tool adapters remain separate. Claude/ChatGPT track successful guidance reads in provider/project/session-scoped receipts; Claude no longer treats transcript tool-call attempts as proof of reading.

Supplemental shell coverage includes output redirection, `tee`, `sed -i`, `perl -i`, `touch`, `truncate`, copy/move/remove commands, and PowerShell `Set-Content`, `Add-Content`, `Out-File` and related file operations. Quoted literal paths, basic directory changes and common shell wrappers are recognized. Shell reads include `cat`, `more`, `less`, `head`, `tail`, `type`, `Get-Content` and simple `sed` reads. Complete-read credit requires a simple `cat`/`type`/`Get-Content` command and matching successful output. Arbitrary scripts, computed paths and custom tools remain outside this extra safety layer. The tested Codex CLI omits `exec_command.workdir` from its canonical Bash hook payload: relative paths resolve against the session directory unless the command contains an explicit `cd`. Use explicit directory changes or absolute paths when relying on ChatGPT shell coverage. Per-call working directories are honored when the provider includes them in hook input.

Local ChatGPT Work/Codex uses native `PreToolUse`/`PostToolUse` command hooks and `apply_patch`; cloud-orchestrated Work needs a different, managed MCP deployment. Hook definitions must be reviewed/trusted before use.

`npm run test:path-guards` runs the real headless Claude Code, Codex and Pi RPC CLIs with isolated installed catalogue packages. Authenticated fake Anthropic/OpenAI APIs script inference only. Checks cover denied shell/native mutations, partial versus complete guidance reads, native reads, shell/native reminders, multi-path patch denial, exact filesystem effects, inference counts and coupled removal.

Pi additionally uses `pi-path-guards` 1.1.0 and its `pi-transport` dependency through Pi-only coupled dependencies. The guard helper imports
each package's existing Python parser and message builders. Transport selects the same uv/Python
preference as the installer and records
launch argv in session receipts. Subprocess requests and responses are versioned JSON, bounded
at 2 MiB and ten seconds, with cancellation on session replacement/shutdown. Guard transport
errors deny checked edits; reminder errors append diagnostics while preserving successful results.
Original tool content and structured output are preserved.

User policy starters live outside npm packages under `<PI_CODING_AGENT_DIR>/harness/`
(default `~/.pi/agent/harness/`). This avoids
adding user workspace ownership to this slice. Shared home and project policies still load later.
Branch receipts record observed ranges and content digests, complete denial deliveries, and
reminder times. State comes from active ancestry on every event, including nested calls, so
reload/resume and tree navigation do not import abandoned-branch permissions. A denial records
only guidance actually inlined within the existing message budget, after an observed
`tool_execution_end` error carries that denial. Pi skips `tool_result` for denied calls.

`npm run test:pi-path-guards` in `tests/e2e/` installs real catalogue payloads and tests Pi 1.2.0
against the authenticated fake OpenAI Responses API. JSON/RPC and project/user checks cover
reminders, cooldown, failed calls, denial/retry, partial-read coverage, shell reads, nested tools,
reload, tree navigation, exact file effects, request counts, and coupled removal. These checks
certify native read/write/edit integration and recognized shell commands on Windows; they do not certify arbitrary shell
mutations, third-party tools, restricted-launch admission, or a security sandbox. Each tool guide states its own supported boundary.

## Guard admission and evidence

Pi project trust controls resource loading. Installed files alone do not prove a guard loaded. A Harness launch requiring mandatory restrictions must verify trusted resource discovery, helper readiness, supported native schemas and required registrations before admitting the launch. Missing or unknown mutation coverage blocks such a restricted launch. Ordinary sessions report resource gaps. Trust remains an explicit user decision; authentication state is not copied.

Tool events cover direct and nested native calls, including `ctx.executeTool()`. They do not cover arbitrary filesystem/subprocess calls made by trusted extensions or direct tool-definition execution. MCP/custom mutators need explicit adapters. Extensions can also transform inputs after another handler checked them, so controlled resource loading and ordering matter. A list of read-only tool names does not provide operating-system isolation; use OS/container enforcement when that guarantee is required.

Branch-sensitive evidence comes from observed successful outcomes and native session ancestry. Partial reads prove only their delivered range, failed reads confer no permission, and abandoned branches confer no authority. Pi's bounded nested-call transcript summaries can omit arguments, so tools persist their own minimal call-linked receipts. Reminder guidance preserves original content, structured output and successful status; blocking policies fail closed when required policy/transport evidence is missing.

Acceptance checks use the real CLI with isolated agent/config/session directories and authenticated loopback fake inference. They assert file/index effects, denied mutations, receipt state, lifecycle/schema contracts and inference-request counts. Shared-skill discovery checks certify integration rather than model judgment. Each tool's guide states its verified runtime and environment; a Windows JSON/RPC journey does not certify POSIX, the TUI, arbitrary tools or a newer runtime.
