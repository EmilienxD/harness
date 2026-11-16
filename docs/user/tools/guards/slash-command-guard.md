# Slash command guard

Platforms: **Pi**.

Install with `harness install slash-command-guard --platform pi`. See [installation and scope](../../getting-started.md).

`slash-command-guard` reserves a leading `/` for Pi commands. An unknown command such as `/typo hello` shows `Command /typo not found.` without adding a user message or making a model request. Native commands, extension commands (including `/clear`), resolved `/skill:name` invocations, and prompt templates keep their normal behavior. Skills and prompt templates can still invoke the model as usual.

Slashes later in a normal message are unaffected. Prefix a slash-leading path with ordinary text when you want to discuss it.

```powershell
harness install slash-command-guard --platform pi --scope user
```

Restart Pi or run `/reload` to activate it.
