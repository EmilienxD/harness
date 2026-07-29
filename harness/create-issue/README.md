# Create Issue

Turn one idea into a reviewed, labeled GitHub issue — `/draft-issue` → `/publish-issue` — in 2 turns and 2 model calls, with nothing published before a human has looked at it.

For breaking a whole plan into multiple dependency-linked issues, see [`create-issues`](../create-issues/README.md).

## Problem

Creating a GitHub issue from Claude Code with the `gh` CLI has two problems:

1. **No review window.** When Claude runs `gh issue create` directly, the issue is live the moment the command executes. There's no point to edit the title, fix the body, or cancel it before it's public.
2. **Windows breaks on large bodies.** Windows caps command-line length. A `gh issue create --body "..."` call with a long body can exceed that cap and fail outright, on Windows only.

## Solution

Split issue creation into two stages, each owned by a different mechanism, so reviewing and publishing are separate concerns:

| Stage | Invoked by | Runs as | Cost |
|---|---|---|---|
| `/draft-issue` | user | model turn, writes one file, chat message | 2 API calls |
| `/publish-issue` | user | `UserPromptSubmit` hook, no model | 0 API calls |

**`/draft-issue`** pins down the issue with you in chat — scope, difficulty, mode — then writes it to one markdown file under `.issue-gateway/`, named after the drafting session's id. Nothing is published yet — the user can open, edit, or delete the file before proceeding.

**`/publish-issue`** is intentionally an empty skill. The real work happens in a `UserPromptSubmit` hook that fires the instant the user types `/publish-issue`, before Claude ever sees the prompt. It reads every draft in `.issue-gateway/`, creates them with `gh issue create`, creates the workflow's labels if they don't exist yet, and moves each published file aside so a rerun never re-creates it. It always sends the body through `--body-file` rather than inline, which is what makes body size irrelevant to the Windows command-length limit.

### Why this is 2 turns and 2 API calls, not one-call-per-issue

- **1 call** for `/draft-issue` to write the file.
- **1 call** for the wrap-up message that follows, confirming the file and handing off to the user for review.

`/publish-issue` — the step that actually hits the tracker — costs **0 additional API calls**, because the hook intercepts the prompt before Claude is invoked at all and does the `gh` calls and label creation itself.

## Components

```
.claude/
├── settings.json                     # registers the UserPromptSubmit hook
├── skills/
│   ├── draft-issue/SKILL.md          # user-invocable, writes .issue-gateway/{session-id}.md
│   └── publish-issue/SKILL.md        # user-invocable, empty body (hook does the work)
└── hooks/
    └── publish_issue.py              # UserPromptSubmit hook: gh calls and labels
```

At runtime, `/draft-issue` creates a `.issue-gateway/` folder at the project root:

```
.issue-gateway/
├── .gitignore                 # contains '*', created on first draft
├── 6b1f0c2e-5a3d-4c19-9f7b-2e8a1d0c4f55.md    # drafted, not yet published
└── .published/                # created by the hook; files move here once gh confirms them
    └── 6b1f0c2e-5a3d-4c19-9f7b-2e8a1d0c4f55-#42.md
```

### File conventions the two skills agree on

- **Filename**: `{session-id}.md`, where the session id is the Claude Code session id of the `/draft-issue` run, injected straight into the skill as `${CLAUDE_SESSION_ID}` (nothing to generate, and unique per session). A silent `` !`mkdir -p …` `` line in the skill creates the directory before the model sees it, and drops a `.gitignore` containing `*` at `.issue-gateway/` so drafts never get committed.
- **Labels**: the first non-empty line after the title, formatted exactly as `> difficulty:{low|medium|high}, mode:{afk|hitl}`. The hook maps that line to the real label names (`low-difficulty`, `medium-difficulty`, `high-difficulty`, `afk`, `hitl`), strips it from the published body, and creates the five labels in the repo if they don't already exist.
- **Blockers**: real tracker issue numbers only (`#42`). A single issue has no sibling drafts, so there is no reference resolution to do at publish time.

## Installation

```bash
uvx --from git+https://github.com/EmilienxD/harness harness install create-issue
```

That copies the two skills and the hook into `.claude/` and merges the hook
registration below into `.claude/settings.json`, leaving any hooks you already
had in place. Add `--dry-run` first to see the exact file list and settings
diff. See the [repo README](../../README.md) for `--user`, `--local`, and
`uninstall`.

<details>
<summary>Installing by hand</summary>

1. Copy the `.claude/` folder into your repository root. If you already have a `.claude/settings.json`, merge the `hooks.UserPromptSubmit` array below into your existing file instead of overwriting it — Claude Code merges hook arrays, not whole files, so an overwrite would silently drop any hooks you already had.

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "python",
            "args": ["${CLAUDE_PROJECT_DIR}/.claude/hooks/publish_issue.py"]
          }
        ]
      }
    ]
  }
}
```

   - `command` must resolve on the machine actually running Claude Code. `python` works out of the box on Windows via the `py`/`python` launcher; on Linux and macOS, confirm `python` exists on `PATH` — if only `python3` does, change this to `"python3"`.
   - `${CLAUDE_PROJECT_DIR}` is substituted by Claude Code at hook-run time to the project root, so the path resolves regardless of your current working directory inside the repo.
   - This hook only acts on the exact prompt `/publish-issue`; `/publish-issues` (from the sibling `create-issues` tool) and every other prompt pass through untouched (exit 0), so it's safe to add alongside other `UserPromptSubmit` hooks.

</details>

2. Make sure the GitHub CLI is installed and authenticated against this repo (`gh auth status`), since `/publish-issue` shells out to it directly.

3. Start (or restart) Claude Code in the repo. The first time it sees a new project-level `.claude/skills/` or `.claude/hooks/` directory, it prompts a workspace-trust dialog — accept it, or `disable-model-invocation`/hooks won't take effect.

4. Verify the two skills are registered by typing `/` — you should see `draft-issue` and `publish-issue` in the list. Both are user-invocable only (`disable-model-invocation: true`), so Claude will never trigger them on its own; you always decide when an issue moves to the next stage.

## Usage

```
/draft-issue [optional: what the issue is about, or an existing issue number/URL]
  → writes .issue-gateway/{session-id}.md
  → review/edit the file by hand if needed

/publish-issue
  → hook creates the labels, publishes every draft via gh,
    moves published files to .issue-gateway/.published/
```
