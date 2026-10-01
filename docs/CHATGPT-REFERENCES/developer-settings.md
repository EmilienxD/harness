# Developer settings

> For the complete documentation index, see [llms.txt](https://learn.chatgpt.com/llms.txt). Markdown versions of documentation pages are available by appending `.md` to the page URL.

Codex CLI reads your personal defaults from `~/.codex/config.toml`. Add a
`.codex/config.toml` file to a trusted project or subfolder when you need
project-specific overrides. The CLI and IDE extension share these configuration
layers.

## Inspect your settings

Use these commands to understand the effective settings for the current
session:

- Run `/status` to see the active model, approval policy, writable roots, and
  token usage.
- Run `/debug-config` to see the configuration layers in precedence order and
  the source of managed policy requirements.
- Start Codex with `--strict-config` to treat unrecognized `config.toml` keys as
  errors instead of ignoring them.

See [Developer commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli) for the full
interactive command reference.

## Change settings for one run

Use a dedicated flag when one exists. Common examples include `--model`,
`--sandbox`, `--ask-for-approval`, `--profile`, and `--search`. Use `-c` or
`--config` to override any supported configuration key for one run.

The model override below requires GPT-6.1 Sol access. If it isn't available to
your account or workspace, omit `--model` or choose a model listed by `/model`.
See [GPT-6.1 Sol availability by plan](https://learn.chatgpt.com/docs/models#gpt-6.1-sol).

```bash
codex --model gpt-6.1-sol
codex --profile deep-review
codex --config model_reasoning_effort='"medium"'
```


Command-line flags and `--config` values have the highest precedence. For the
complete flag list, see [Developer commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli).

## Configuration layers

The CLI applies command-line flags and `--config` overrides before project,
profile, user, system, and built-in settings. Use that precedence to keep shared
defaults in configuration files and one-off changes on the command line.

For the complete order and common options, see [Config basics](https://learn.chatgpt.com/docs/config-file/config-basic).

## Change settings in the TUI

The interactive terminal UI provides pickers for common session and display
settings:

| Goal                      | Command                                      | Related configuration                         |
| ------------------------- | -------------------------------------------- | --------------------------------------------- |
| Choose a model            | `/model`                                     | `model`, `model_reasoning_effort`             |
| Change permissions        | `/permissions`                               | Approval and sandbox settings                 |
| Choose a response style   | `/personality`                               | `personality`                                 |
| Configure optional tools  | `/experimental`, `/memories`                 | Feature-specific `config.toml` keys           |
| Customize the terminal UI | `/keymap`, `/statusline`, `/title`, `/theme` | Keys under `[tui]`                            |
| Set editing defaults      | `/vim`, `/raw`                               | `tui.vim_mode_default`, `tui.raw_output_mode` |

Some commands apply only to the current session, while some pickers offer to
save the choice. Set the related configuration key when you want a default for
future sessions. For the terminal theme, editor, completions, and shortcut
workflows, see [CLI customization](https://learn.chatgpt.com/docs/cli-customization).

## Settings references

- [Advanced configuration](https://learn.chatgpt.com/docs/config-file/config-advanced) covers profiles, one-off overrides, and other advanced workflows.
- [Configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference) lists the available keys and values.
- [Sample configuration](https://learn.chatgpt.com/docs/config-file/config-sample) provides a complete example file.
- [Environment variables](https://learn.chatgpt.com/docs/config-file/environment-variables) documents variables used by the CLI and installer.