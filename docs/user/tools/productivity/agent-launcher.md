# Agent launcher

## Use it

Installing `agent-launcher` provides `cch` for Claude Code and `cxh` for Codex. The native CLIs must be available on your path. Normal arguments pass through, for example `cch --help` or `cxh --help`. Without project configuration, each wrapper launches its native command with default options.

## Configuration

From a project directory, run `cch --hns-init` or `cxh --hns-init` to create missing starter files under `.harness/agent-launcher/`. You can also pass a path after `--hns-init`. The wrapper looks for `.harness/agent-launcher/config.py` in the current directory and then its ancestors, using the nearest one.

The starter `config.py` has `CONFIG_VERSION`, `COMMANDS`, and a `configure()` function returning Claude and ChatGPT `LaunchOptions`. Its `system-prompt.md` and `claude/settings.json` feed Claude; `chatgpt/config.toml` feeds Codex. You can use standard-library Python modules in `extensions/` to generate Claude prompt context. The Claude-only `/extend-claude-system-prompt` skill can edit the prompt and validate the result.

## Check and troubleshoot

Inspect generated settings with `cch --hns-render-settings` or `cxh --hns-render-settings`; inspect Claude's complete system prompt with `cch --hns-render`. If configuration loading fails, check the error against `CONFIG_VERSION`, the exact `claude` and `chatgpt` `COMMANDS` keys, and the return value of `configure()`. The config is executable Python: review it before launching in an untrusted project, and keep credentials in a private location.
