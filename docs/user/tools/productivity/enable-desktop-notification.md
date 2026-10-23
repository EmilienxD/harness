# Enable desktop notification

Platforms: **Claude Code, ChatGPT, Pi**. Install with `harness install enable-desktop-notification`; see [installation and scope](../../getting-started.md).

`/enable-desktop-notification` enables desktop notifications for the current Claude Code, Codex, or Pi session without a model call. Each completed turn displays the beginning of the session title (Claude's `aiTitle`, Codex's saved thread name, or Pi's native session name, with the session ID as fallback) and a preview of the final response. The setting survives session resume; other sessions stay off. Add `--disable` to turn it off. Codex also accepts `$enable-desktop-notification`; Pi also accepts `/skill:enable-desktop-notification`. Uses native Windows PowerShell toasts, macOS `osascript`, or Linux `notify-send` (install it if missing); a local desktop notification service and enabled OS notifications are required. Claude/Codex state lives under `~/.harness/desktop-notification/` or `$HARNESS_STATE_DIR/desktop-notification/`. Pi stores its preference in the native session, across tree navigation and reload, and starts new/forked sessions disabled. Pi notifies once at final settlement, after automatic continuations; errors and aborts get explicit status text. Delivery failures leave the turn complete and display a diagnostic. Install with `uv run harness install enable-desktop-notification --platform pi`, then `/reload` and approve the resources.

## Implementation and verification

`enable-desktop-notification` 1.1.1 registers a native command and consumes the explicit
`/skill:enable-desktop-notification` spelling before expansion. Enable, disable, invalid
arguments and backend errors finish without a Pi inference request. The extension uses
`pi-transport` 1.0.0's bounded, cancellable interpreter transport to call a small Python adapter
over the existing `desktop_notification.py`; OS delivery remains shared with Claude/Codex.

Research used the mirrored [event declarations](https://github.com/EmilienxD/harness/blob/main/docs/PI-REFERENCES/src/core/extensions/types.ts),
[extension lifecycle](https://github.com/EmilienxD/harness/blob/main/docs/PI-REFERENCES/docs/extensions.md), [session format](https://github.com/EmilienxD/harness/blob/main/docs/PI-REFERENCES/docs/session-format.md)
and the installed Pi 1.2.0 `agent-session.js` and extension runner. The pinned
[upstream session implementation](https://github.com/earendil-works/pi/blob/47fc5f38ec18d56fe64abd41a2dcf9e5170a3dcf/packages/coding-agent/src/core/agent-session.ts)
confirms that settlement handlers are awaited before the external settlement event. `agent_end`
can precede retries or queued continuation; terminal escape sequences also pollute headless
protocol output. Native OS delivery at `agent_settled` fits both JSON/RPC and interactive sessions.

The preference is a non-context custom entry bound to the native session ID. Unlike commit
ownership, it belongs to the whole session: reconstruct it from `getEntries()`, so navigating
to an earlier tree node cannot undo the user's enable/disable choice. A fork copies historical
entries but changes the session ID, so inherited opt-in does not enable a new session. Reload
and exact resume preserve the setting without an external session registry.

Each agent activity sends at most one notification after final settlement. The title uses
the current native session name, falling back to its ID; the body uses the final assistant
text, with explicit failed/aborted status. Deterministic commands do not start agent activity
and do not notify. A failed delivery adds a visible diagnostic without another model turn.
Session replacement/shutdown cancels pending transport. Native backend availability is checked
before opt-in; successful submission does not certify that OS settings display the notification.
