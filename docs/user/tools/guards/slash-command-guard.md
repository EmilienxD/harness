# Slash command guard

Platforms: **Pi**. Install with `harness install slash-command-guard --platform pi`; see [installation and scope](../../getting-started.md).

`slash-command-guard` reserves a leading `/` for Pi commands. An unknown command such as
`/typo hello` shows `Command /typo not found.` without adding a user message or making a
model request. Native commands, extension commands (including `/clear`), resolved
`/skill:name` invocations, and prompt templates keep their normal behavior. Skills and
prompt templates can still invoke the model as usual. Slashes later in a normal message
are unaffected; prefix a slash-leading path with ordinary text when you want to discuss it.

```powershell
uv run harness install slash-command-guard --platform pi --scope user
```

Restart Pi or run `/reload` to activate it.

## Pi implementation and verification

`slash-command-guard` ships a Pi-only input extension in 1.0.0.
Native UI and extension commands dispatch before its input handler;
resolved skills and prompt templates pass through to native expansion. Other slash-leading
input is handled with a command-not-found notification before inference or message insertion.
Real Pi 1.2.0 project/user RPC journeys verify zero-inference denial, command dispatch,
`/clear`, reload, resource expansion, and receipt-driven removal; JSON checks verify no agent
run for rejected input. See `tests/e2e/tools/pi-slash-command-guard/`.
