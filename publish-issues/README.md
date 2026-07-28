# Publish Issues

Turn a plan into reviewed, dependency-linked GitHub issues — `/map-issues` → `/draft-issues` → `/publish-issues` — in 2 turns and 3 model calls, with zero issues published before a human has looked at them.

## Problem

Creating GitHub issues from Claude Code with the `gh` CLI has three problems:

1. **No review window.** When Claude runs `gh issue create` directly, the issue is live the moment the command executes. There's no point to edit the title, fix the body, or cancel it before it's public.
2. **Dependency graphs force sequential creation.** If issue B's body needs to say "blocked by #A", Claude must create A first, read back its real number, then create B. For a batch of N interdependent issues, that's N round trips through the model instead of one — the token cost scales with the size of the batch instead of staying flat.
3. **Windows breaks on large bodies.** Windows caps command-line length. A `gh issue create --body "..."` call with a long body can exceed that cap and fail outright, on Windows only.

## Solution

Split issue creation into three stages, each owned by a different mechanism, so review, dependency resolution, and publishing are three separate concerns instead of one:

| Stage | Invoked by | Runs as | Cost |
|---|---|---|---|
| `/map-issues` | user | model turn, chat only | 1 API call |
| `/draft-issues` | user | model turn, writes files, chat message | 2 API calls |
| `/publish-issues` | user | `UserPromptSubmit` hook, no model | 0 API calls |

**`/map-issues`** proposes a breakdown in chat — no files, no tracker calls — and iterates with the user until the granularity, dependencies, difficulty, and mode all look right.

**`/draft-issues`** writes the approved breakdown to one markdown file per issue under `.issues-gateway/`, tagged with a shared batch id so dependent issues can reference each other before any of them exist on the tracker. Nothing is published yet — the user can open, edit, or delete any file before proceeding.

**`/publish-issues`** is intentionally an empty skill. The real work happens in a `UserPromptSubmit` hook that fires the instant the user types `/publish-issues`, before Claude ever sees the prompt. It reads every file in `.issues-gateway/`, creates them with `gh issue create` in batch-id order, and rewrites each `{batch-id}-{i}` reference into the real issue number as soon as that issue exists — so a dependency graph gets published correctly without a single model call driving it. It also creates the workflow's labels if they don't exist yet, and always sends the issue body through `--body-file` rather than inline, which is what makes body size irrelevant to the Windows command-length limit.

### Why this is 2 turns and 3 API calls, not one-call-per-issue

A batch of N interdependent issues normally costs at least N model calls if each issue must be created (and its real number read back) before the next one that depends on it can be written. Here, the entire batch — any number of issues, any dependency graph — costs a fixed:

- **1 call** for `/map-issues` to produce the breakdown.
- **1 call** for `/draft-issues` to batch-write every issue file in a single tool-use turn (all N files requested together, not one file per round trip).
- **1 call** for the wrap-up message that follows, confirming the files and handing off to the user for review.

`/publish-issues` — the step that actually resolves the dependency graph and hits the tracker — costs **0 additional API calls**, because the hook intercepts the prompt before Claude is invoked at all and does the `gh` calls, id resolution, and label creation itself.

## Components

```
.claude/
├── settings.json                      # registers the UserPromptSubmit hook
├── skills/
│   ├── map-issues/SKILL.md            # user-invocable, chat-only, proposes the breakdown
│   ├── draft-issues/SKILL.md          # user-invocable, writes .issues-gateway/{id}-{i}.md
│   └── publish-issues/SKILL.md        # user-invocable, empty body (hook does the work)
└── hooks/
    └── publish_issues.py              # UserPromptSubmit hook: gh calls, id resolution, labels
```

At runtime, `/draft-issues` creates a `.issues-gateway/` folder at the project root:

```
.issues-gateway/
├── a1b2c3-0.md         # drafted, not yet published
├── a1b2c3-1.md
└── .published/         # created by the hook; files move here once gh confirms them
```

### File conventions the three skills agree on

- **Batch id**: a random 6-hex-digit id shared by every issue in one `/draft-issues` run, generated once via Claude Code's `` !`command` `` dynamic-context injection (the shell command runs before the model sees the skill, so the agent only ever reuses the printed value — it never executes the command itself).
- **Filename**: `{batch-id}-{i}.md`, `i` starting at 0 in publish order (blockers before what they block).
- **Cross-references**: `{batch-id}-{i}` wrapped in curly braces inside a body (e.g. `{a1b2c3-0}`) means "blocked by that issue." The hook rewrites these to `#<real-number>` as each referenced issue gets published, and skips (without failing the whole batch) any file whose reference isn't resolvable yet.
- **Labels**: the first non-empty line after the title, formatted exactly as `> difficulty:{low|medium|high}, mode:{afk|hitl}`. The hook parses this line into labels, strips it from the published body, and creates the five labels in the repo if they don't already exist.

## Installation

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
            "args": ["${CLAUDE_PROJECT_DIR}/.claude/hooks/publish_issues.py"]
          }
        ]
      }
    ]
  }
}
```

   - `command` must resolve on the machine actually running Claude Code. `python` works out of the box on Windows via the `py`/`python` launcher; on Linux and macOS, confirm `python` exists on `PATH` — if only `python3` does, change this to `"python3"`.
   - `${CLAUDE_PROJECT_DIR}` is substituted by Claude Code at hook-run time to the project root, so the path resolves regardless of your current working directory inside the repo.
   - This hook only acts on prompts starting with `/publish-issues`; every other prompt passes through untouched (exit 0), so it's safe to add alongside other `UserPromptSubmit` hooks.

2. Make sure the GitHub CLI is installed and authenticated against this repo (`gh auth status`), since `/publish-issues` shells out to it directly.

3. Start (or restart) Claude Code in the repo. The first time it sees a new project-level `.claude/skills/` or `.claude/hooks/` directory, it prompts a workspace-trust dialog — accept it, or `disable-model-invocation`/hooks won't take effect.

4. Verify the three skills are registered by typing `/` — you should see `map-issues`, `draft-issues`, and `publish-issues` in the list. All three are user-invocable only (`disable-model-invocation: true`), so Claude will never trigger them on its own; you always decide when a batch moves to the next stage.

## Usage

```
/map-issues [optional: issue number, URL, or path to a plan]
  → propose a breakdown in chat, iterate until it looks right

/draft-issues
  → writes .issues-gateway/{batch-id}-{i}.md, one per approved issue
  → review/edit the files by hand if needed

/publish-issues
  → hook creates the labels, publishes every file via gh in dependency order,
    resolves {batch-id}-{i} references to real issue numbers,
    moves published files to .issues-gateway/.published/
```
