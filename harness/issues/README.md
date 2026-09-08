# Issues

Everything for getting work out of a conversation and onto the GitHub tracker: one idea → one
reviewed issue, a whole plan → a dependency-linked batch, an audit → one evidence-preserving issue
per finding, or the current conversation → a spec (in chat, or as an issue). Nothing reaches the
tracker before a human has looked at it.

One install ships six drafting/publishing skills, plus Claude Code's `/save-as-issue`
command and response-cache hooks. Claude Code remains
the default target; pass `--platform chatgpt` for the native ChatGPT payload:

```bash
uvx --from git+https://github.com/EmilienxD/harness@v0.2.0 harness
```

## Problem

Creating GitHub issues from Claude Code or ChatGPT with the `gh` CLI has four problems:

1. **No review window.** When Claude runs `gh issue create` directly, the issue is live the moment
   the command executes. There's no point to edit the title, fix the body, or cancel it before it's
   public.
2. **Dependency graphs force sequential creation.** If issue B's body needs to say "blocked by #A",
   Claude must create A first, read back its real number, then create B. For a batch of N
   interdependent issues, that's N round trips through the model instead of one — the token cost
   scales with the size of the batch instead of staying flat.
3. **Windows breaks on large bodies.** Windows caps command-line length. A `gh issue create
   --body "..."` call with a long body can exceed that cap and fail outright, on Windows only.
4. **Sub-issues need numbers nobody has.** Publishing a spec and then breaking it into sub-issues
   normally costs a round trip just to read back the spec's number — and publishing here happens in
   a hook that produces no assistant turn at all, so the agent never sees it.

## Solution

Drafting and publishing are separate concerns, owned by different mechanisms. Drafting is a model
turn that writes markdown files you can edit; publishing is a `UserPromptSubmit` hook that fires
before the model sees the prompt, so it costs **0 API calls** and does the `gh` work itself —
including creating the workflow's labels and, for batches, rewriting cross-references into real
issue numbers. Bodies always go through LF-only `--body-file` temporary files, never inline, which
avoids both the Windows command-length limit and Windows newline expansion.

Drafting skill bodies are static so Claude Code can reuse its skill prompt cache. The same hook
recognizes drafting invocations, prepares the session directory, finds the next free draft index,
and adds those values as context. Because setup is no longer hidden inside pre-expanded skill shell
syntax, the agent can inspect the draft directory again if it needs another fresh index.

### Drafting flows

| Flow | Skills | Cost |
|---|---|---|
| One issue | `/draft-issue` → `/publish-issues` | 2 API calls |
| A plan, as a batch | `/draft-issues` → `/publish-issues` | 3 API calls |
| Audit findings, one issue each | `/draft-audit-issues` → `/publish-issues` | 3 API calls |
| This conversation, as a spec | `/to-spec`, or `/to-spec-draft-issue` → `/publish-issues` | 1–2 API calls |

The table uses Claude Code's `/skill` spelling. In ChatGPT CLI/IDE prompts, invoke the same skills
as `$draft-issue`, `$draft-issues`, `$draft-audit-issues`, `$publish-issues`, `$to-spec`, and
`$to-spec-draft-issue`.

**Single issue.** `/draft-issue` pins down scope, difficulty, and mode with you in chat, then writes
one markdown file under `.issues-gateway/{session-id}/issue-{n}.md`, where `{n}` is the next free
index among pending drafts in that session. `/publish-issues` publishes every draft in that folder
and deletes each draft file as soon as GitHub confirms creation, so a rerun never re-creates it. Once
every draft in the session is published, it also removes the empty session folder; a later draft in
the same session recreates it automatically.

### Save the latest response as an issue (Claude Code)

After reviewing Claude's final response, run `/save-as-issue`. The command immediately
publishes that response to the current repository using the authenticated `gh` CLI and
prints the issue URL. Invoking the command is the publication approval; there is no
draft file or extra confirmation turn. This command currently ships only for Claude Code.

The title is `Report <session-id> — <generated session title>`. The hook reads the last
non-empty `aiTitle` from an `ai-title` transcript record matching the session ID. This is
optional internal metadata: if the transcript is unavailable or contains no generated
title, the title is simply `Report <session-id>`. Manual session names are not substituted.
Whitespace is normalized and the issue title is capped at 256 characters.

A `Stop` hook caches `last_assistant_message` under
`.issues-gateway/.responses/<session-id>.json`. It copies the final text, without parsing
thinking, tool calls, or intermediate commentary out of the transcript. Finish a response
after installing the tool before saving. A new ordinary prompt, session start (including
resume/clear/compaction), or failed turn invalidates the cache; an interrupted turn cannot
silently publish an earlier response. Subagent responses are ignored.

The body bypasses draft parsing: headings, apparent label lines, parent sections, and
draft references are preserved as text. No labels or parent links are added. The publisher
adds its hidden recovery marker; oversized responses use the existing numbered continuation
comments. Repeating the command for the same cached response returns the existing issue,
or resumes an incomplete publication, with its original title. A separate completed turn
can be saved as a new issue even if its text is identical.

The prompt hook blocks both successful and failed saves, so the command costs zero model
calls. GitHub subprocesses have a 30-second timeout and share a 240-second deadline, below
the hook's 300-second timeout. Unknown creation outcomes retain recovery state and refuse
another create until the existing issue can be found. An externally canceled or disabled
hook still cannot guarantee interception; the skill's fallback tells the agent to stop.

### Batch and spec publishing

**Batch.** `/draft-issues` first proposes a breakdown in chat and iterates until granularity,
dependencies, difficulty, and mode look right. Once you approve the mapping, it proceeds directly to
writing one file per issue under `.issues-gateway/{session-id}/`, tagged with a shared session id so
dependent issues can reference each other before any of them exist. `/publish-issues` creates them in
dependency order and rewrites each plain `{session-id}/{i}` reference into the real number as soon as
that issue exists — a whole dependency graph published without a single model call driving it.

**Audit findings.** `/draft-audit-issues` consumes an audit already in the conversation or at a
passed reference. It preserves a strict one-finding-to-one-issue mapping, keeps the audit's location,
impact, evidence, severity, confidence, remediation difficulty, and recommendation, and asks you to
approve the mapping before writing drafts. It does not re-audit, merge findings, or force them into
the implementation-oriented `What to build` and acceptance-criteria template.

**Spec.** `/to-spec` synthesizes what you've already discussed into a spec and delivers it in chat —
no interview, no files. `/to-spec-draft-issue` does the same synthesis but writes it to
`.issues-gateway/{session-id}/issue-{n}.md` (same auto-indexing), so `/publish-issues` can put it
on the tracker with an `[AI]-spec` label.

**Sub-issues.** A draft whose `## Parent` section contains one bare reference is published as a real
GitHub sub-issue of that parent, via `gh issue create --parent`. Knowing the number isn't enough —
GitHub's sub-issue graph is structural — so the hook makes the link itself and strips the section
from the published body, since GitHub renders the parent natively. This costs no model call: the
reference is one line in a file the drafting skill was already writing.

**Oversized issues.** A processed body plus its hidden recovery marker fits in one issue up to
GitHub's 65,536-character limit. A larger payload is split at a conservative 60,000-character
target after labels, cross-references, and parent handling are resolved. Part 1 is the issue
body and identifies the total part count; the remaining parts are visibly numbered continuation
comments. Splitting prefers paragraphs, then lines, and only hard-splits exceptionally long lines.
Fenced code blocks are kept together where possible and are closed/reopened with the same language
when a block itself cannot fit.

Every issue and continuation part carries a hidden draft-key/content-digest/index marker. Before creating
the issue, the hook reserves an `inflight` state entry. If a run stops after creation or between
comments, rerunning `/publish-issues` finds the existing marker-bearing issue and comments, skips
parts already present, and continues without duplicating content. The draft is retained until every
continuation exists. Editing its processed title, labels, parent, or body while it is incomplete
causes the rerun to stop that draft and report the partial issue URL rather than mixing versions.
The returned issue URL is checked against its title and body before any number enters the state.
If a create response is lost and recovery cannot find its marker yet, the hook refuses another
create and retains the draft for later recovery. This also covers a failed parent-link operation
after GitHub has already created the issue. Recovery lists issues directly, without GitHub search
indexing delays. An OS file lock allows only one publisher per batch, even without `portalocker`;
an overlapping invocation reports that the batch is already being processed.

### Spec → sub-issues, without a round trip

The common flow is `/to-spec-draft-issue` → `/publish-issues` → `/draft-issues` in one session, and
the middle step is a hook: it erases the prompt and produces no assistant turn, so the agent would
never learn that the spec became `#42`. Two mechanisms close that gap, and they cover different
failure modes:

- **Durable published state.** Every successful create is recorded in
  `.issues-gateway/.state.json` under `published` before the draft file is deleted, and the state is loaded back
  at the start of the next run. So a `{session-id}/{i}` reference — in `Blocked by` or under
  `## Parent` — to an issue published in an *earlier* run resolves too, even though its draft file
  is long gone. Every state read/write runs under a file lock on a `.state.lock` sidecar
  (portalocker when available, native OS locking otherwise), so two sessions publishing at once in the same
  project merge their entries instead of clobbering each other.
- **A one-shot notice.** Each run queues what it created in the same `.state.json`, under
  `pending_notice`.
  The next prompt that isn't a publish command flushes it into the agent's context as
  `additionalContext` and clears that section. It rides along with a prompt you were sending anyway, so it
  costs **0 extra API calls** and roughly one line of tokens per issue — and it means the next
  `/draft-issues` can write a real `#42` under `## Parent`, and can tell you what got published.

The published state is deterministic and survives compaction; the notice makes the agent aware. Neither
requires you to change how you drive the workflow.

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
│   ├── draft-audit-issues/SKILL.md     # writes one evidence-preserving draft per audit finding
│   ├── publish-issues/SKILL.md         # user-invocable, empty body (hook does the work)
│   ├── save-as-issue/SKILL.md          # publish the latest final response, no model turn
│   ├── to-spec/SKILL.md                # conversation -> spec, in chat
│   └── to-spec-draft-issue/SKILL.md    # conversation -> spec, into .issues-gateway/
└── hooks/
    ├── publish_issues_UserPromptSubmit_hook.py  # drafting context, command dispatch, publishing
    └── save_as_issue.py                        # response caching and direct report publishing
```

The hook is registered on `UserPromptSubmit`. It intercepts `/save-as-issue`, `/publish-issues`, and
`/publish-issue`, and adds setup context for the four explicit drafting skills. Every other prompt
passes through untouched (exit 0) — carrying the pending-publish notice, if there is one — so it is
safe alongside other `UserPromptSubmit` hooks. It is registered with `"timeout": 300`
because `UserPromptSubmit` lowers the default command-hook timeout to 30 seconds, which a large
batch of `gh` calls can exceed; a timed-out hook is canceled and the prompt reaches Claude anyway,
which for this hook would mean a half-published batch and a literal `/publish-issues` for the model
to interpret.

At runtime the hook creates a gateway folder at the project root — `.issues-gateway/`:

```
.issues-gateway/
├── .gitignore                                   # contains '*', created on first draft
├── .state.json                                  # published refs + inflight work + pending notice
├── .state.lock                                  # sidecar carrying the state file lock
└── 6b1f0c2e-…-2e8a1d0c4f55/                     # one dir per drafting session
    ├── issue-0.md
    └── issue-1.md
```

### File conventions the skills and hooks agree on

- **Session id**: the native session id of the drafting run. On Claude Code this is already a UUID;
  on ChatGPT the adapter derives a stable UUID-shaped batch id from the thread id. The hook creates
  the session directory, drops a `.gitignore` containing `*` so drafts are never committed, resolves
  the next free `issue-{n}` index, and injects all three values as context. Skill files contain only
  placeholders, so their bodies remain byte-for-byte stable between invocations.
- **Filename**: `{session-id}/issue-{i}.md`. `{i}` is the next free index for single-issue and spec
  drafts; for a batch, numbering continues from that index in publish order (blockers before what
  they block).
- **Labels**: the first non-empty line after the title. One format for every draft, specs included:
  `> ` followed by a comma-separated list of label tokens —
  `difficulty:{routine|basic|advanced|expert}` and `mode:{afk|hitl}` are
  each optional (the user can ask the drafting skill to skip them), a spec's line always includes
  `spec`, `chrome` marks implementation work that needs a real browser to test a design change end
  to end, and extra labels the user asks for are listed alongside them after the skill verifies they
  exist in the repo (`gh label list`) — multi-word labels included (`> spec, security`, `> good first
  issue, difficulty:basic`). The hook maps the difficulty/mode/chrome/spec tokens to the workflow's own label
  names (`[AI]-routine-difficulty`, `[AI]-basic-difficulty`, `[AI]-advanced-difficulty`,
  `[AI]-expert-difficulty`, `[AI]-afk`, `[AI]-hitl`, `[AI]-chrome`, `[AI]-spec`), applies any extra
  tokens as-is, strips the line from the published body, and creates the canonical labels in the
  repo only if they don't already exist — an existing label is never re-styled. The `[AI]-` prefix
  keeps these labels from colliding with a repo's own, and lets projects that share this workflow
  use one common label set. The difficulty names avoid `low`, `medium`, and `high` because those are
  commonly confused with reasoning effort in AI tooling; here the label chooses the model, not the
  effort setting.
- **Blockers**: real tracker numbers only (`#42`) in single-issue drafts — there are no sibling
  drafts to resolve. In a batch, a plain-text `{session-id}/{i}` token (no backticks, no braces, e.g.
  `6b1f0c2e-…-2e8a1d0c4f55/0`) means "blocked by that issue"; the hook rewrites it to a bare
  `#<real-number>` as each referenced issue is published — bare, because GitHub only autolinks issue
  numbers that aren't wrapped in inline code — and skips, without failing the batch, any
  file whose reference isn't resolvable yet. References to issues published in an earlier run
  resolve from the published state.
- **Parent**: a `## Parent` section (any heading level) whose first non-empty line is one bare
  reference and nothing else — `#42`, an issue URL, or `{session-id}/{i}`, the same token used for a
  blocker — publishes the issue as a GitHub sub-issue of that parent and removes the section from
  the body. Parent linking is structural, not label-based: a spec drafted earlier in the session is
  referenced like any other draft, by its filename index (`{session-id}/0`), whether it is already
  on the tracker or still an unpublished draft. Prose under `## Parent` is left exactly as written
  and creates no link, so the section is
  safe to use for a human note instead; `none` there is an explicit opt-out and is dropped from the
  body. A parent that isn't resolvable yet is retried within the run just like a blocker, and the
  draft is left in place rather than published without its link. On a `gh` too old for
  `gh issue create --parent`, the link is made afterwards with `gh issue edit --parent` and the
  reference is kept in the body as a fallback.
- **State file**: `.state.json` at the gateway root holds durable, inflight, and transient hook state. Its
  `published` object records `{"{session-id}/{i}": {number, url, title, labels, parent}}` for every
  batch — one shared map for the whole project, because reference keys already carry their session
  id. It is written after each successful create, immediately, so an interrupted run still leaves
  behind the numbers it did create, and it is what makes references resolve across runs, once the
  draft files themselves are gone. Read-modify-write cycles hold a file lock on a
  `.state.lock` sidecar (the sidecar — not the state file — carries the lock, so the state file's
  own atomic temp-file replace can't be blocked or truncated by lock semantics, on Windows or
  POSIX). If the state reservation cannot be saved, publishing stops before creating that issue
  and retains its draft. Corrupt or malformed published state degrades to "nothing
  known yet" rather than blocking a publish.
- **Pending notice**: `.state.json` also has a `pending_notice` object that collects what each run
  published (and how many drafts failed). The next prompt that isn't a publish command injects it as
  `additionalContext` and clears that section, so it is delivered exactly once. It is deliberately
  not keyed by session id — a `/clear` between publishing and the next prompt must not strand it —
  and two publish runs in a row accumulate rather than overwrite. A malformed notice is dropped,
  never raised: this hook sees every prompt in the session and must not be able to fail one.
- **Inflight publication**: the `inflight` object is keyed by `{session-id}/{i}` and stores
  the repository, reservation time, publication fingerprint, processed issue metadata, complete-body
  SHA-256, part count, whether creation was attempted, issue URL/number once known, and completed part indexes. The reservation is
  written under the same lock before issue creation. The issue is added to `published` as soon as
  its URL is known so later references resolve even while comments are pending. Marker inspection
  makes issue creation and comment posting resumable; malformed inflight entries are ignored without
  disturbing valid `published` or `pending_notice` data.
- **Successful publish cleanup**: every issue is recorded after creation is verified, then its
  draft is deleted before its recovery state is cleared. An oversized draft is deleted, removed from `inflight`, counted as
  published, and queued for the normal agent notice only after all continuation markers exist. A
  continuation failure retains the draft and progress, reports the partial URL and failed part, and
  does not prevent unrelated drafts from being processed. If another draft fails later in the same
  run, known references are still rewritten to their real `#<number>` form before it is retained.

## Installation

```bash
uvx --from git+https://github.com/EmilienxD/harness@v0.2.0 harness
```

For ChatGPT:

```bash
uvx --from git+https://github.com/EmilienxD/harness@v0.2.0 harness
```

That installs skills under `.agents/skills/`, the shared publishing core and a thin native adapter
under `.codex/hooks/`, and registers the adapter in `.codex/hooks.json`. Review and trust the hook
definition when ChatGPT prompts you. Its `UserPromptSubmit` adapter uses the same shared drafting
setup as Claude Code, deriving a stable UUID-shaped batch id from the ChatGPT thread id and injecting
the resulting values as developer context. The adapter also delegates publishing to the shared core,
including 65,536-character splitting and resumable continuation comments.

That copies the six skills and the hook into `.claude/` and merges the hook registration below
into `.claude/settings.json`, leaving any hooks you already had in place. Add `--dry` first to
see the exact file list and settings diff. See the [repo README](../../README.md) for `--user`,
`--local`, and `uninstall`.

<details>
<summary>Installing by hand</summary>

1. Copy `shared/hooks/issues_core.py`, `claude/hooks/save_as_issue.py`, and
   `claude/hooks/publish_issues_UserPromptSubmit_hook.py` into your repository's `.claude/hooks/`,
   then copy the directories under `claude/skills/` into `.claude/skills/`. If you already have a
   `.claude/settings.json`, merge each hook event array below into your existing file
   instead of overwriting it — Claude Code merges hook arrays, not whole files, so an overwrite would
   silently drop any hooks you already had.

```json
{
  "hooks": {
    "Stop": [
      {"hooks": [{"type": "command", "command": "python", "args": ["${CLAUDE_PROJECT_DIR}/.claude/hooks/save_as_issue.py"]}]}
    ],
    "StopFailure": [
      {"hooks": [{"type": "command", "command": "python", "args": ["${CLAUDE_PROJECT_DIR}/.claude/hooks/save_as_issue.py"]}]}
    ],
    "SessionStart": [
      {"hooks": [{"type": "command", "command": "python", "args": ["${CLAUDE_PROJECT_DIR}/.claude/hooks/save_as_issue.py"]}]}
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "python",
            "args": ["${CLAUDE_PROJECT_DIR}/.claude/hooks/publish_issues_UserPromptSubmit_hook.py"],
            "timeout": 300
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
  → hook creates the labels, publishes every draft via gh, links each draft
    that declares a parent as a real GitHub sub-issue,
    publishes bodies over 65,536 characters as numbered continuation comments,
    deletes each draft file after GitHub confirms creation,
    and hands the real issue numbers to the agent on your next prompt
  → --dry reports the issue/part/comment counts without invoking gh or writing state
  (also accepts /publish-issue alias — same hook, same behavior)

/draft-issues [optional: issue number, URL, or path to a plan]
  → proposes a breakdown in chat and iterates until it looks right
  → after approval, writes .issues-gateway/{session-id}/issue-{i}.md, one per issue

/draft-audit-issues [optional: path, issue, or URL containing an audit]
  → proposes an exact one-to-one mapping from numbered findings to issues
  → after approval, writes one evidence-preserving draft per finding

/to-spec
  → synthesizes the conversation into a spec, in chat only

/to-spec-draft-issue
  → same synthesis, written to .issues-gateway/{session-id}/issue-{n}.md for /publish-issues
```

The spec-to-sub-issues loop, end to end:

```
/to-spec-draft-issue     → issue-0.md, labelled "> spec"
/publish-issues          → creates it as #42; state records it; notice queued
/draft-issues            → the notice arrives with this prompt, so the breakdown
                           is drafted with "## Parent" → #42 (or {session-id}/{i}
                           of the spec draft if you skipped the publish step)
/publish-issues          → each issue is created as a sub-issue of #42
```
