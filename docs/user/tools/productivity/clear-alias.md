# Clear alias

Platforms: **Pi**.

Install with `harness install clear-alias --platform pi`. See [installation and scope](../../getting-started.md).

`clear-alias` is a Pi-only extension that adds `/clear` as an alias for `/new`. It starts a fresh session without a model request. It does not delete saved sessions.

```powershell
harness install clear-alias --platform pi --scope user
```

Restart Pi or run `/reload`, then use `/clear`.
