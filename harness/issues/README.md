# Issues

Everything for getting work out of a conversation and onto the GitHub tracker: one idea → one
reviewed issue, a whole plan → a dependency-linked batch, or the current conversation → a spec
(in chat, or as an issue). Nothing reaches the tracker before a human has looked at it.

One install ships all five skills and one publishing hook:

```bash
uvx --from git+https://github.com/EmilienxD/harness harness install issues
```

## Problem

Creating GitHub issues from Claude Code with the `gh` CLI has three problems:

1. **No review window.** When Claude runs `gh issue create` directly, the issue is live the moment
   the command executes. There's no point to edit the title, fix the body, or cancel it before it's
   public.
2. **Dependency graphs force sequential creation.** If issue B's body needs to say "blocked by #A",
   Claude must create A first, read back its real number, then create B. For a batch of N
   interdependent issues, that's N round trips through the model instead of one — the token cost
   scales with the size of the batch instead of staying flat.
3. **Windows breaks on large bodies.** Windows caps command-line length. A `gh issue create
   --body "..."` call with a long body can exceed that cap and fail outright, on Windows only.

## Solution

Drafting and publishing are separate concerns, owned by different mechanisms. Drafting is a model
turn that writes markdown files you can edit; publishing is a `UserPromptSubmit` hook that fires
before Claude ever sees the prompt, so it costs **0 API calls** and does the `gh` work itself —
including creating the workflow's labels and, for batches, rewriting cross-references into real
issue numbers. The body always goes through `--body-file`, never inline, which is what makes body
size irrelevant to the Windows command-length limit.

### Three flows

| Flow | Skills | Cost |
|---|---|---|
| One issue | `/draft-issue` → `/publish-issues` | 2 API calls |
| A plan, as a batch | `/draft-issues` → `/publish-issues` | 3 API calls |
| This conversation, as a spec | `/to-spec`, or `/to-spec-draft-issue` → `/publish-issues` | 1–2 API calls |

**Single issue.** `/draft-issue` pins down scope, difficulty, and mode with you in chat, then writes
one markdown file under `.issues-gateway/{session-id}/issue-{n}.md`, where `{n}` is the next free
index (pending drafts and already-published files in that session are scanned automatically).
`/publish-issues` publishes every draft in that folder and moves each published file aside so a
rerun never re-creates it.

**Batch.** `/draft-issues` first proposes a breakdown in chat and iterates until granularity,
dependencies, difficulty, and mode look right. Once you approve the mapping, it proceeds directly to
writing one file per issue under `.issues-gateway/{session-id}/`, tagged with a shared session id so
dependent issues can reference each other before any of them exist. `/publish-issues` creates them in
dependency order and rewrites each `{session-id}/{i}` reference into the real number as soon as that
issue exists — a whole dependency graph published without a single model call driving it.

**Spec.** `/to-spec` synthesizes what you've already discussed into a spec and delivers it in chat —
no interview, no files. `/to-spec-draft-issue` does the same synthesis but writes it to
`.issues-gateway/{session-id}/issue-{n}.md` (same auto-indexing), so `/publish-issues` can put it
on the tracker with an `ai:spec` label.

### Why the batch flow is 3 API calls, not one-per-issue

A batch of N interdependent issues normally costs at least N model calls if each issue must be
created (and its real number read back) before the next one that depends on it can be written. Here
the entire batch — any number of issues, any dependency graph — costs a fixed:

- **1 call** for `/draft-issues` to produce the breakdown.
- **1 call** after you approve the mapping to batch-write every issue file in a single tool-use turn
  (all N files requested together, not one file per round trip).
- **1 call** for the wrap-up message that follows, confirming the files and handing off for review.

`/publish-issues` — the step that resolves the dependency graph and hits the tracker — costs **0
additional API calls**.

## Components

```
.claude/
├── settings.json                       # registers the UserPromptSubmit hook
├── skills/
│   ├── draft-issue/SKILL.md            # writes .issues-gateway/{session-id}/issue-{n}.md
│   ├── draft-issues/SKILL.md           # maps, gets approval, then writes the issue batch
│   ├── publish-issues/SKILL.md         # user-invocable, empty body (hook does the work)
│   ├── to-spec/SKILL.md                # conversation -> spec, in chat
│   └── to-spec-draft-issue/SKILL.md    # conversation -> spec, into .issues-gateway/
└── hooks/
    └── publish_issues_UserPromptSubmit_hook.py  # UserPromptSubmit hook: gh calls, id resolution, labels
```

The hook is registered on `UserPromptSubmit` and matches `/publish-issues` or `/publish-issue`
(followed by end of string or whitespace), handling both singular and batch drafts. Every other
prompt passes through untouched (exit 0), so it is safe alongside other `UserPromptSubmit` hooks.

At runtime the drafting skills create a gateway folder at the project root — `.issues-gateway/`:

```
.issues-gateway/
├── .gitignore                                   # contains '*', created on first draft
└── 6b1f0c2e-…-2e8a1d0c4f55/                     # one dir per drafting session
    ├── issue-0.md
    ├── issue-1.md
    └── .published/                              # created by the hook, once gh confirms
        ├── issue-0-#42.md
        └── issue-1-#43.md
```

### File conventions the skills and hooks agree on

- **Session id**: the Claude Code session id of the drafting run, injected straight into the
  skill as `${CLAUDE_SESSION_ID}` (nothing to generate, and unique per session, so no collision
  handling is needed). Each drafting skill runs a `` !`…` `` command before loading that creates
  the session directory, drops a `.gitignore` containing `*` so drafts are never committed, and
  (for single-issue and batch flows) resolves the next free `issue-{n}` index so pending drafts are
  never overwritten.
- **Filename**: `{session-id}/issue-{i}.md`. `{i}` is the next free index for single-issue and spec
  drafts; for a batch, numbering continues from that index in publish order (blockers before what
  they block).
- **Labels**: the first non-empty line after the title. For issues: `> ` followed by a
  comma-separated list of label tokens — `difficulty:{low|medium|high}` and `mode:{afk|hitl}` are
  each optional (the user can ask the drafting skill to skip them), and extra labels the user asks
  for are listed alongside them after the skill verifies they exist in the repo (`gh label list`).
  For specs: `> ai:spec` (plain `> spec` from older drafts also still parses). The hook maps the
  difficulty/mode/spec tokens to the workflow's own label names (`ai:low-difficulty`,
  `ai:medium-difficulty`, `ai:high-difficulty`, `ai:afk`, `ai:hitl`, `ai:spec`), applies any extra
  tokens as-is, strips the line from the published body, and creates the canonical labels in the
  repo only if they don't already exist — an existing label is never re-styled. The `ai:` prefix
  keeps these labels from colliding with a repo's own, and lets projects that share this workflow
  use one common label set. GitHub label renames don't migrate issues, so repos label-scoped before
  this change keep their old `spec`/`afk`/… labels; the hook simply stops touching them.
- **Blockers**: real tracker numbers only (`#42`) in single-issue drafts — there are no sibling
  drafts to resolve. In a batch, `{session-id}/{i}` in curly braces (e.g.
  `{6b1f0c2e-…-2e8a1d0c4f55/0}`) means "blocked by that issue"; the hook rewrites it to
  `#<real-number>` as each referenced issue is published, and skips — without failing the batch — any
  file whose reference isn't resolvable yet.

## Installation

```bash
uvx --from git+https://github.com/EmilienxD/harness harness install issues
```

That copies the five skills and the hook into `.claude/` and merges the hook registration below
into `.claude/settings.json`, leaving any hooks you already had in place. Add `--dry` first to
see the exact file list and settings diff. See the [repo README](../../README.md) for `--user`,
`--local`, and `uninstall`.

<details>
<summary>Installing by hand</summary>

1. Copy the `.claude/` folder into your repository root. If you already have a
   `.claude/settings.json`, merge the `hooks.UserPromptSubmit` array below into your existing file
   instead of overwriting it — Claude Code merges hook arrays, not whole files, so an overwrite would
   silently drop any hooks you already had.

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "python",
            "args": ["${CLAUDE_PROJECT_DIR}/.claude/hooks/publish_issues_UserPromptSubmit_hook.py"]
          }
        ]
      }
    ]
  }
}
```

   - `command` must resolve on the PATH of the machine actually running Claude Code. For a manual
     install use whichever name works locally (`python` via the `py`/`python` launcher on Windows,
     usually `python3` on Linux/macOS). The `harness` installer sidesteps this: it checks each
     candidate (`python3`, `python`, `py`) actually runs and writes its absolute path into
     `settings.json`, so the hooks no longer depend on PATH at all.
   - `${CLAUDE_PROJECT_DIR}` is substituted by Claude Code at hook-run time to the project root, so
     the path resolves regardless of your current working directory inside the repo.

</details>

2. Make sure the GitHub CLI is installed and authenticated against this repo (`gh auth status`),
   since the publishing hooks shell out to it directly.

3. Start (or restart) Claude Code in the repo. The first time it sees a new project-level
   `.claude/skills/` or `.claude/hooks/` directory, it prompts a workspace-trust dialog — accept it,
   or `disable-model-invocation`/hooks won't take effect.

4. Verify the skills are registered by typing `/`. All of them are user-invocable only
   (`disable-model-invocation: true`), so Claude never triggers them on its own; you always decide
   when a draft moves to the next stage.

## Usage

```
/draft-issue [optional: what the issue is about, or an existing issue number/URL]
  → writes .issues-gateway/{session-id}/issue-{n}.md (next free index)
  → review/edit the file by hand if needed

/publish-issues [--dry]
  → hook creates the labels, publishes every draft via gh,
    moves published files to .issues-gateway/{session-id}/.published/
  (also accepts /publish-issue alias — same hook, same behavior)

/draft-issues [optional: issue number, URL, or path to a plan]
  → proposes a breakdown in chat and iterates until it looks right
  → after approval, writes .issues-gateway/{session-id}/issue-{i}.md, one per issue

/to-spec
  → synthesizes the conversation into a spec, in chat only

/to-spec-draft-issue
  → same synthesis, written to .issues-gateway/{session-id}/issue-{n}.md for /publish-issues
```
