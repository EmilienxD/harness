# Calm

Platforms: **Pi**. Install with `harness install calm --platform pi`; see [installation and scope](../../getting-started.md).

`calm` is a Pi-only extension that hides every tool's transcript output and file diffs,
including built-in, extension, SDK, and MCP tools. Web summaries show the search query or fetched URL.
Each tool call appears independently in a compact chat block. Its tool name sits on the
top border beside the left corner, with the command, path, or query inside the block.
Parallel and nested calls can display multiple blocks at once.
Commands preserve line breaks and wrap to fit the terminal. Summaries are capped at 350
characters, including a trailing `…` when truncated.
An animated Braille spinner sits to the left of the tool name while the tool runs. Completion replaces it
with a green `•` on success or a red `•` on failure. Each call stays visible while
running and disappears independently three seconds after it completes, even if other calls
are still running or the agent has already finished. No calls are coalesced or queued for display.
Agent execution keeps running at full speed. Reloading or switching sessions clears the display;
disabling Calm immediately restores native tool rows.
Pi's normal running indicator stays in the input bar.
Install it globally with:

```powershell
uv run harness install calm --platform pi --scope user
```

Restart Pi and run `/calm` to toggle the display; it confirms `calm mode: enabled` or
`calm mode: disabled`. The preference is saved in the effective
Pi agent directory's `calm` file and survives restart. A fresh installation starts disabled.
Use `/calm` again to restore tool details; Ctrl+T still controls reasoning visibility.
Calm removes the empty label for reasoning you have already collapsed. Images and assistant
responses remain visible. Since Calm 1.8.0, all tool rows use the same compact presentation,
including tools with custom renderers and Background Shell's shell overrides; no tool opt-in
or companion-package update is needed. Disabling Calm restores each tool's original rendering.
Separate extension widgets and notifications are unchanged.
Session data and tool execution
are preserved. Pi 1.2.0 is the verified host version; the display adapters use internal
component fields and may need updates after Pi upgrades.

This is a local fork of [Kun Chen's Calm extension](https://github.com/kunchenguid/dotfiles/tree/9a4a6387d0dd6f4bf9b8a5a732b406916bbbf95d/home/.pi/agent/extensions/calm),
under its MIT license, with Pi 1.2 renderer compatibility, native PowerShell coverage, and
the boat animation removed. Remove the earlier standalone `extensions/calm` copy before
installing this package to avoid loading both versions.

## Pi implementation and verification

`calm` ships a Pi-only presentation extension in
`harness/productivity/calm/`. Its `/calm` command persists an agent-directory preference
without inference. It hides all tool rows and collapsed thinking labels while retaining
Pi's normal running indicator. Version 1.9.0 shows every requested/executing tool's name
and command/path in its own transient chat block, including parallel and nested calls.
Each block stays visible through execution and disappears independently three seconds after
completion; provider requests and agent settlement preserve these holds. Native tool completion events
replace the spinner with a green success or red failure dot. Timers never delay tool execution and are cancelled on session
replacement, reload and shutdown. The local fork preserves the upstream MIT license and carries
Pi 1.2.0 renderer-copy compatibility plus native PowerShell coverage. Since 1.8.0, the common
tool-row adapter covers every tool, including extension/SDK overrides and custom renderers,
without registration markers. Images remain visible, and disabling Calm restores native rendering. The real RPC journey verifies command effects, native
tool execution and exact request counts; component checks verify row hiding, restoration,
reasoning expansion, image preservation and reload against the installed Pi SDK.
