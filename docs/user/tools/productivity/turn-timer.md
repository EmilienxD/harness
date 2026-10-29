# Turn timer

Platforms: **Pi** interactive terminal UI only.

```powershell
uv run harness install turn-timer --platform pi --scope user
```

Restart Pi or run `/reload`. Use `--scope project` for a project-only installation.

The built-in spinner and editor remain unchanged. The working label becomes:

```text
Working · 25m 10s
```

The extension records a monotonic timestamp when Pi emits an input event and updates
`ctx.ui.setWorkingMessage()` once per second while working. Another user input resets
the timer immediately, including steering or queued follow-up input. Thus this measures
time since submission, not time since a queued message starts being processed. Inputs
handled by another extension can also pass through this boundary; slash commands that
do not emit an input event do not reset the timer. Runs started without input fall back
to their start time. Minutes are unbounded and seconds always use two digits.

Tool calls and automatic continuations retain the timestamp. Final `agent_settled`
stops the timer and replaces the working display with a frozen `Worked · 25m 10s`
widget above the editor, without a spinner. Pi removes its built-in working row at
loop end, so the extension uses an above-editor widget for this completed state.
The next input or run clears it; session switching, shutdown and reload clear it too.
The original animated spinner remains untouched while working.
No session entries or model requests are generated. The completed duration is not
persisted across reloads or process restarts or added to assistant messages.

Pi provides one working-message slot: another extension using that slot can conflict.
RPC clients must implement their own timer display; Pi's working-message UI API is a
no-op there. Non-UI runs do not create timers.

## Verification and limits

Unit coverage checks formatting, input resets, loop restarts, cleanup, non-UI behavior,
and receipt-owned native-package installation/removal at project and user scope.
`tests/unit/turn_timer_host.mjs` exercises the installed Pi extension loader and real
session event dispatch without inference. These checks do not establish visual terminal
acceptance or a real-provider E2E journey; manual interactive testing remains required.
