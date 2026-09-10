# Launch configuration

Aboard and the Harness CLI share `.harness/launch.json` version 2. A project file wins over
`~/.harness/launch.json`; when neither exists, the built-in Claude defaults apply. The file is
re-read for each launch, resume, and reopen. Existing processes keep the settings with which they
started.

```json
{
  "version": 2,
  "platform": "claude",
  "command": ["claude"],
  "stopWaitHours": 24,
  "interactive": {
    "model": "inherit",
    "effort": "inherit"
  },
  "explore": { "model": "haiku", "effort": "low" },
  "implementer": { "model": "by-difficulty", "effort": "by-difficulty" },
  "reviewer": { "model": "by-difficulty", "effort": "by-difficulty" }
}
```

`platform` is required and is either `claude` or `chatgpt`; it is never inferred from `command`.
The four profiles configure ordinary sessions, read-only Explore children, and the two Auto Run
worker roles. `inherit` leaves model or effort selection to the provider. `by-difficulty` is valid
only for worker profiles. Claude profiles additionally accept `deniedTools`. ChatGPT worker profiles
accept `webSearch` and `subagents`; when omitted, the user's native Codex settings are inherited.

The manual delegation identities (`Prototype`, `Web Search`, `Brainstorm`, and `General`) use the
`interactive` profile. Aboard does not remove built-in agent or web tools from interactive or manual
sessions. Explicit profile settings are preserved.

Auto Run is extension-controlled: implementers and reviewers always disable built-in subagents and web
search, regardless of permissive profile settings. Its Git/GitHub and worktree restrictions are also
reapplied when an Auto Run conversation resumes.

`stopWaitHours` controls how long a parent Stop hook waits for a successful delegated result and
defaults to 24. The wait does not retain a database transaction. Failed or cancelled children do
not wake the parent; their status is delivered on the next user prompt.

The scaffold owns `.harness/launch.json`. Other `.abd/` files remain Aboard-owned Auto Run and
workspace assets; `.abd/launch.json` is not read.
