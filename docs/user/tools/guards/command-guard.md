# Command Guard

`command-guard` checks shell commands before execution in Claude Code and ChatGPT. It denies a command when a configured regular expression matches and reports that rule's reason. The shipped policy covers destructive disk and file operations, force pushes, credential access, network content piped into a shell, and Windows equivalents. It is a guardrail over observed tool calls, not a security sandbox.

Install with `harness install command-guard` and restart the provider. Edit `.harness/guards/command-guard.toml` in a project or `~/.harness/guards/command-guard.toml` at user scope. Harness preserves edits to this starter policy on upgrade. User rules load before project rules.

```toml
version = 1

[[rules]]
reason = "network content piped into a shell"
patterns = ['''(curl|wget).*\|\s*(ba|z)?sh''']
```

Each `[[rules]]` entry needs a `reason` and a list of command regular expressions in `patterns`. Review the shipped rules before removing any; a regex may match more than intended. See the [guard overview](../guards-and-extensions.md) for installer scope options.

## When to use it

Install this when shell commands should stop at a known set of dangerous patterns before the provider runs them. It is useful in repositories where routine agent work includes Git, package managers, or scripts, but a force push or credential command needs a deliberate manual path.

## Example and limits

If a proposed `git push --force` matches the starter's remote-history rule, the hook denies that tool call and returns its reason. Edit the matching rule in the TOML file when repository policy differs. Regex matching sees the command text passed to the hooked tool; commands hidden inside another program, alternate spellings, and unhooked execution paths remain outside this check.
