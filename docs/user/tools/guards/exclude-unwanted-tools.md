# Exclude unwanted tools

Platforms: **Pi**. Install with `harness install exclude-unwanted-tools --platform pi`; see [installation and scope](../../getting-started.md).

`exclude-unwanted-tools` is a Pi-only extension that persistently excludes `powershell`,
`codemode`, `find`, `grep`, and `ls` from the session tool registry, including tools
registered by other extensions. Other tools remain subject to Pi's normal selection rules.
The exclusion list is fixed in the package payload; it does not edit `settings.json`.

```powershell
uv run harness install exclude-unwanted-tools --platform pi --scope user
```

Restart Pi or run `/reload` to activate it.

**Compatibility:** verified against Pi 1.2.0. This adapter patches the private
`AgentSession._isAllowedTool` method because changing active tools alone does not remove
them from the registry. If that method is missing, loading reports an error; the fallback
is to launch Pi with `--exclude-tools powershell,codemode,find,grep,ls`. This is a tool
preference, not a security boundary. The patch is process-wide, and `/reload` does not
undo it: after uninstalling or changing the exclusion list, restart Pi.
