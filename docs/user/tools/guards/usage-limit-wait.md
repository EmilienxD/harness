# Usage Limit Wait

`usage-limit-wait` pauses a Claude Code or ChatGPT session when the provider reports an exhausted subscription usage window, then lets work continue after reset. If reading usage state fails, it fails open instead of stopping the session.

Install with `harness install usage-limit-wait`, choose Claude Code or ChatGPT as needed, and restart the provider. It has no TOML policy or editable budget. The hook operates at the selected project or user installation scope. It depends on the provider's usage information; it does not extend or bypass subscription limits.

## When to use it

Choose this for long-running sessions that should wait through a subscription reset rather than fail a turn at the limit. For example, if a provider reports exhaustion and a reset time, the hook waits for that window, then allows execution to continue.

## Limits

The provider's usage reader must supply a usable reset signal. Reader errors fail open, so the hook does not hold a session indefinitely because usage status could not be fetched. There are no user-defined wait intervals or policy patterns.
