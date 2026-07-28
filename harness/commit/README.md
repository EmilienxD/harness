# zero-call-commit

A `/commit <message>` command for Claude Code that stages and commits your
changes without spending a single additional model call.

## Problem

Asking the agent to commit at the end of a session is redundant and expensive.
Claude has to look at `git status`, decide which commands to run, execute
them, and report back — typically 2 to 5 extra turns, each one re-sending the
full conversation history as input tokens. On a long session, that "just
commit it" request can be one of the priciest things you ask the agent to do,
for a task that's fundamentally mechanical.

## Solution

Intercept the `/commit` prompt with a `UserPromptSubmit` hook, which fires
**before** the prompt is ever sent to the model. The hook does the git work
itself and rejects the prompt with a status string, which Claude Code shows
directly to the user in place of a model response.

Net result: typing `/commit fix the login bug` runs `git add`, `git commit`,
and returns a confirmation — with zero new API calls, because the model
never sees the prompt at all.

This only works because `UserPromptSubmit` runs pre-model. A `PreToolUse`
hook (an earlier design considered for this tool) fires only after the model
has already emitted a tool call, so it can't avoid that first API round trip.

## Components

| File | Purpose |
|---|---|
| `.claude/settings.json` | Registers the hook on the `UserPromptSubmit` event |
| `.claude/hooks/commit_user_prompt_submit_hook.py` | Parses the prompt, stages changes, commits, and reports back — all without touching the model |

No slash-command or skill definition is required. The hook matches on the
raw prompt text (`^/commit ...`), so `/commit` doesn't need to be a
registered command for this to work.

**Note:** `commit_user_prompt_submit_hook.py` currently stages everything (`git add -A`) via a
placeholder — `get_changed_paths()` — rather than parsing the session
transcript for the exact files Claude touched. Replace that function with
real transcript parsing if you want commits scoped to just this session's
changes.

## Installation

1. Copy `hooks/commit_user_prompt_submit_hook.py` into `.claude/hooks/` in your repo.
2. Make it executable: `chmod +x .claude/hooks/commit_user_prompt_submit_hook.py`
3. Add (or merge) the following into your repo's `.claude/settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "python3 .claude/hooks/commit_user_prompt_submit_hook.py"
          }
        ]
      }
    ]
  }
}
```

4. Restart or reload Claude Code so it picks up the new hook config.
5. Test it: type `/commit test message` in a session with uncommitted
   changes. You should see a `Committed <sha>: test message` response with
   no model "thinking" delay, and the commit should appear in `git log` with
   a `Claude-session: <id>` trailer.

Requires `python3` and `git` on PATH inside the environment Claude Code runs in.