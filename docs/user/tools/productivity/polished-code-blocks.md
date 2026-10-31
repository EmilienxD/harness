# Polished code blocks

Platforms: **Pi**. Install with `harness install polished-code-blocks --platform pi`; see [installation and scope](../../getting-started.md).

`polished-code-blocks` replaces Pi's literal Markdown code fences with rounded frames,
a language label with a block number (for example, `powershell #1`), and the active
theme's syntax highlighting. Long lines wrap inside
the frame; nested blocks and streaming responses still use Pi's Markdown parser.
No line numbers are added. This changes all code blocks rendered by Pi's shared
Markdown component, not raw tool output, stored messages, or model requests.

```powershell
uv run harness install polished-code-blocks --platform pi --scope user
```

Restart Pi or run `/reload`, then run `/code-blocks` (or `/code-blocks demo`) for a
local preview; press any key to close it. The preview makes no model request and
adds nothing to the conversation. Preview blocks are not assigned session numbers.

Use `/copy-block 1` to copy block #1, or `/copy-block` with no argument to copy the
latest assistant code block. Numbers start at 1 across assistant text on the active
session branch, including nested blocks, and are rebuilt on resume, reload, and
branch navigation. Copying preserves the original code's logical lines, indentation,
and Unicode without fences, frames, padding, or terminal-width wrapping. It uses
Pi's clipboard support, makes no model request, and also works with frames disabled.
Only assistant text is numbered for copying, not thinking, tool output, or previews.
At narrow widths the label may be truncated or the frame omitted; the copy number
still works.

`/code-blocks off` restores the stock renderer;
`/code-blocks on` enables frames again. The extension starts enabled on each session
start or reload; the toggle is not persisted. Very narrow layouts omit the frame.

Verified with the real Pi 1.2.0 and 1.4.0 extension loader, assistant-message component and
Markdown renderer, including wrapping, themes, nested blocks, numbered copying,
branch navigation and reload. Clipboard payload checks stub the clipboard transport;
OS clipboard integration uses Pi's exported helper. Pi has
no public standard-code-block renderer hook, so this uses an internal Markdown
adapter that may need updating after Pi upgrades. It does not replace Calm's tool
or thinking renderers. To remove it:

```powershell
uv run harness uninstall polished-code-blocks --platform pi --scope user
```

Run `/reload` after removal to restore native rendering.
