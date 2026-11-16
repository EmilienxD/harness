# Productivity tools

Install a package from the Harness catalogue, or run `harness install <package>` from the project directory. Claude Code invokes a skill as `/skill-name`. ChatGPT uses `$skill-name`. Pi uses `/skill:name`. The table lists every active productivity package across providers.

| Package | Platforms | Purpose |
| --- | --- | --- |
| [`agent-launcher`](productivity/agent-launcher.md) | Claude Code, ChatGPT | Project-configurable launcher for Claude Code and Codex |
| [`background-shell`](productivity/background-shell.md) | Pi | Pi background shell jobs with automatic completion, output browsing, and cancellation |
| [`calm`](productivity/calm.md) | Pi | Keep Pi quiet while showing each tool call in its own transient chat block |
| [`caveman`](productivity/caveman.md) | Claude Code, ChatGPT, Pi | Ultra-compressed communication mode (~75% fewer tokens) |
| [`chrome-devtools`](productivity/chrome-devtools.md) | Claude Code, ChatGPT, Pi | Upstream Chrome DevTools browser automation CLI and skill |
| [`cleanup-git`](productivity/cleanup-git.md) | Claude Code, ChatGPT, Pi | Explain every local branch and worktree before confirming cleanup |
| [`clear-alias`](productivity/clear-alias.md) | Pi | Alias Pi's /new command as /clear to start a fresh session |
| [`copy-all`](productivity/copy-all.md) | Pi | Copy the current Pi conversation's user and assistant messages to the clipboard |
| [`decisions`](productivity/decisions.md) | Claude Code, ChatGPT, Pi | Surfaces important decisions from the current work where confidence remains low |
| [`effort-alias`](productivity/effort-alias.md) | Pi | Set session thinking effort with /effort, or pick a model-supported level |
| [`enable-desktop-notification`](productivity/enable-desktop-notification.md) | Claude Code, ChatGPT, Pi | Enable desktop notifications for final responses in the current session without a model call |
| [`environment-context`](productivity/environment-context.md) | Pi | Add OS, fixed session-start time, and compact Git status with full file counts to Pi context |
| [`file-mentions`](productivity/file-mentions.md) | Pi | Automatically include @referenced text files and bounded folder listings in Pi prompts |
| [`handoff`](productivity/handoff.md) | Claude Code, ChatGPT, Pi | Compacts the conversation into a handoff doc for another agent |
| [`handoff-grilling`](productivity/handoff-grilling.md) | Claude Code, ChatGPT, Pi | Preserves a grill-me conversation in a detailed handoff doc |
| [`mid-prompt-skills`](productivity/mid-prompt-skills.md) | Claude Code, ChatGPT, Pi | Load skills invoked after other prompt text in Claude Code, ChatGPT, and Pi |
| [`next-decision`](productivity/next-decision.md) | Claude Code, ChatGPT, Pi | Resolves a plan's open decisions one at a time with focused choices and a recommendation |
| [`polished-code-blocks`](productivity/polished-code-blocks.md) | Pi | Render numbered Pi code blocks with rounded frames, syntax highlighting and exact-content copying |
| [`report-gotchas`](productivity/report-gotchas.md) | Claude Code, ChatGPT, Pi | Send noteworthy agent handoff gotchas to Discord |
| [`setup-command-aliases`](productivity/setup-command-aliases.md) | Claude Code, ChatGPT, Pi | Add or modify cross-platform shell command aliases (PowerShell, Bash, Zsh) |
| [`setup-text-replacements`](productivity/setup-text-replacements.md) | Claude Code, ChatGPT, Pi | Add or change always-on AutoHotkey text replacements (Windows only) |
| [`statusline`](productivity/statusline.md) | Pi | Minimal Pi footer with project, branch, provider, model, thinking level, and context usage |
| [`turn-timer`](productivity/turn-timer.md) | Pi | Elapsed time since the latest user input beside the Working label |
| [`stop-overthinking`](productivity/stop-overthinking.md) | Claude Code, ChatGPT, Pi | Stops overthinking and gives a short, practical decision |
| [`subagents`](productivity/subagents.md) | Claude Code, ChatGPT, Pi | Persistent conversation delegation with mode-preserving resume |
| [`todo-hitl`](productivity/todo-hitl.md) | Claude Code, ChatGPT, Pi | Mark deferred code work for human review and address it deliberately |
| [`tool-inspector`](productivity/tool-inspector.md) | Pi | Show Pi's installed tools at startup and inspect their contracts with /tools |
| [`web-toolkit-native`](productivity/web-toolkit.md) | Pi | Native web_search and web_fetch tools |
| [`web-toolkit`](productivity/web-toolkit.md) | Claude Code, ChatGPT, Pi | Skill for local web search and page fetching through the CLI |
| [`writing-for-agents`](productivity/writing-for-agents.md) | Claude Code, ChatGPT, Pi | Guidance for writing predictable documents consumed by agents |
| [`zoom-out`](productivity/zoom-out.md) | Claude Code, ChatGPT, Pi | Gives a higher-level map of a codebase area |

Open a tool guide for invocation, configuration, platform differences and practical limits. Install with `--platform pi` to select Pi. Omitted platforms retain the Claude Code/ChatGPT defaults. Persistent launch and reply commands belong to [subagents](productivity/subagents.md), while shared installation roots and ownership are documented in [Configuration](../configuration.md).
