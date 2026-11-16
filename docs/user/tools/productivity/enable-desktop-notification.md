# Enable desktop notification

Platforms: **Claude Code, ChatGPT, Pi**.

Install with `harness install enable-desktop-notification`. See [installation and scope](../../getting-started.md).

`/enable-desktop-notification` enables desktop notifications for the current Claude Code, Codex, or Pi session without a model call. Each completed turn displays the beginning of the session title (Claude's `aiTitle`, Codex's saved thread name, or Pi's native session name, with the session ID as fallback) and a preview of the final response. The setting survives session resume. Other sessions stay off.

Add `--disable` to turn it off. Codex also accepts `$enable-desktop-notification`. Uses native Windows PowerShell toasts, macOS `osascript`, or Linux `notify-send` (install it if missing). A local desktop notification service and enabled OS notifications are required. Claude/Codex state lives under `~/.harness/desktop-notification/` or `$HARNESS_STATE_DIR/desktop-notification/`.

Pi stores its preference in the native session, across tree navigation and reload, and starts new/forked sessions disabled. Pi notifies once at final settlement, after automatic continuations. Errors and aborts get explicit status text. Delivery failures leave the turn complete and display a diagnostic. Install with `harness install enable-desktop-notification --platform pi`, then `/reload` and approve the resources.
