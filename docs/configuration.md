# Configuration

aboard settings (`aboard.*`) are edited in VS Code Settings. They resolve through three layers, highest precedence first:

1. `.vscode/settings.json` — an explicit VS Code workspace or folder value.
2. `.aboard/settings.json` — the project override file, checked in and shared with the team.
3. The user, profile, or default value.

`.aboard/settings.json` is optional and never scaffolded; create it when a project needs its own configuration. Keys may be written flat or nested, with or without the redundant `aboard.` prefix, so all three of these set the same thing:

```json
{
  "launch": { "maxInlinePromptChars": 4000 },
  "aboard": { "timeouts": { "managerPrompt": 45 } }
}
```

Changes apply live. An unknown key or an invalid value is reported in Output → aboard and falls back to the value from the next layer.

## Settings worth knowing

| Setting | Default | What it does |
| :-- | :-- | :-- |
| `aboard.terminals.closeOnSessionEnd` | `false` | Close an agent's terminal when its Claude session ends. Off by default: quitting the session (`exit`, double Ctrl+C) and closing the terminal are separate gestures, so the shell is left for you to reuse. The agent leaves the fleet either way, and the leftover terminal never blocks a relaunch. |
| `aboard.autoRun.review` | `false` | Launch a pr-doctor after each issue is addressed during an auto-run. Automated review stays opt-in; the explicit review action is always available. |
| `aboard.autoRun.mergeRunPullRequest` | `false` | Merge the run's own pull request when the run ends. An auto-run addresses each issue on its own branch, merges those into one session branch (`aboard/run/<run id>`), and opens a single pull request from it into the branch you were on when the run started — never into the repository's default branch of its own accord. Off by default: that target is a branch you are working on, a conflict there is likely, and landing a batch of automated work on it is your decision. When on, aboard attempts the merge once, merges the target back in and retries if that resolves the conflict, and otherwise leaves the pull request open and tells you. |
| `aboard.autoRun.worktree.enabled` | `false` | Give an auto-run a checkout of its own instead of working in your files. See [Running in a checkout of its own](#running-in-a-checkout-of-its-own). |
| `aboard.launch.claudeCommand` | `claude` | The command aboard launches. Wrapper arguments come first and aboard's flags are appended unchanged. A path with spaces goes in quotes. |
| `aboard.launch.maxInlinePromptChars` | `4000` | Longest prompt passed inline as a command-line argument. Longer prompts spill to `.aboard/runtime/prompts` and are referenced with `@path`. |
| `aboard.launch.effort` | `inherit` | Reasoning effort (`--effort`) for every session aboard starts or resumes, the Manager included. `inherit` passes no flag, leaving Claude Code's own effort level in charge. Applied per process — a running agent keeps the level it started with. |
| `aboard.bridge.port` | `4823` | Preferred loopback port. If occupied, aboard selects an ephemeral port. |
| `aboard.manager.roadmapReminderBytes` | `150000` | How many transcript bytes may pass with no roadmap injection before the Manager is reminded of the pending tasks and their positions. Bytes rather than turns, because turn size varies far too much to pace on; the check is a bounded read of the transcript's tail, so it costs the same whether the session is minutes or days old. `0` disables the reminder — the session-start and post-compact briefings still carry the full roadmap. The default targets roughly six to eight reminders across a full Manager context; it has **not** been calibrated against measured Manager transcripts, so treat it as a starting point and lower it if the Manager loses track of task positions between briefings. |
| `aboard.manager.transcriptBackups` | `5` | How many Manager session transcripts aboard keeps under `.aboard/runtime/transcripts`. Claude Code deletes its own session files older than `cleanupPeriodDays` every time it starts, the minimum is one day and there is no way to turn the sweep off, so aboard copies the Manager's transcript at each turn boundary and restores it if a resume finds it gone. The copy is incremental — only the bytes the transcript gained — and a restore never overwrites a session Claude Code still has. `0` turns both the backup and the restore off; copies already on disk are left for you to delete. |

The full list, with descriptions, is in VS Code Settings under **aboard**.

## Running in a checkout of its own

By default an auto-run works in your files: it moves HEAD, needs a clean working tree before it starts, and owns the repository until it finishes. With `aboard.autoRun.worktree.enabled` on, it gets a second checkout of this repository instead — created beside your project directory, never inside it — runs every agent there, and leaves your working tree and your branch exactly as they are. You can keep working while it does, and a dirty tree of yours no longer refuses the run.

| Setting | Default | What it does |
| :-- | :-- | :-- |
| `aboard.autoRun.worktree.enabled` | `false` | Turn the whole thing on. Off by default: a separate checkout costs a full copy of the tree plus whatever the setup command installs into it. |
| `aboard.autoRun.worktree.root` | *(sibling of the project)* | Where those checkouts are created. Must be outside the project directory, or the run would address issues in a directory the repository itself contains. |
| `aboard.autoRun.worktree.keep` | `false` | Keep the checkout after the run ends. aboard removes it when the queue drains, and always keeps it — whatever this says — when the run stopped or parked an issue, because its terminals and unfinished work are in there. |
| `aboard.autoRun.worktree.setupTimeoutSeconds` | `600` | How long the setup command below may take. |

**Project configuration follows the run.** Git supplies every tracked `.claude/` and `.aboard/` file. When aboard first creates the checkout, it fills in missing files from those directories in your main checkout without replacing anything Git supplied. This carries aboard's scaffold and any user-owned local Claude configuration you chose to keep there; aboard neither supplies nor requires `.claude/settings.local.json`. It is a creation-time snapshot: changing or adding local configuration later does not alter a resumed run. Claude's `.claude/worktrees/` and all of `.aboard/runtime/` are excluded, and aboard refuses symbolic links or junctions rather than following them into another directory.

Every local-only file copied this way must already be ignored by Git in the run checkout. aboard checks this before copying and refuses the run with the exposed paths if any could be swept up by the `git add -A` used during implementation. Ignoring either whole configuration directory is supported; so is committing shared configuration while ignoring only personal files.

**Runtime must never be tracked.** Before creating a checkout, aboard inspects the exact session branch or base commit it will use and refuses if Git tracks any path under `.aboard/runtime/`, including a `.gitkeep`. A resumed checkout receives the same check at its own `HEAD`. Remove the directory from the index, keep it ignored, commit and publish that change to the inspected branch, then retry; aboard reports bounded path names but neither reads nor automatically changes those files.

**Setting the checkout up.** A fresh checkout has no `.env`, no `node_modules`, no virtualenv. `.aboard/session-setup.ps1` (Windows) and `.aboard/session-setup.sh` (macOS and Linux) are scaffolded empty for you to fill in; aboard runs the one for the current platform once, immediately after creating the checkout, with the working directory set to it and `ABOARD_PROJECT_ROOT`, `ABOARD_SESSION_PATH`, `ABOARD_SESSION_BRANCH`, and `ABOARD_RUN_ID` in the environment. Your copy is never overwritten by an update. A non-zero exit refuses the run, and so does anything the script leaves untracked and not gitignored — the run stages with `git add -A`, and a copied `.env` must not reach a pull request.

**What this is and is not.** Agents work in a directory that looks like an ordinary clone, and their launches carry `Read`/`Edit` deny rules covering your own checkout. That prevents the accident — an agent editing your branch instead of its own. It is not a sandbox: `Bash` reaches the whole filesystem, and aboard does not try to police shell commands. Note also that the work is outside your VS Code window until its pull request opens; the terminals stay visible, and aboard tells you the path.

## Claude in Chrome

Chrome access is a per-launch choice rather than a persistent setting. Use `/general-purpose --chrome`, set `chrome: true` on `run_agent`, use `/auto --chrome`, set `chrome: true` on `start_auto_run`, or run **Aboard: Start Auto Run with Chrome** from the command palette. `/auto --dry --chrome` previews the same choice without starting a run. The ordinary forms explicitly pass `--no-chrome`; the Chrome forms pass `--chrome`. Auto-run chooses once for the entire run and passes the choice only to implementers, including after recovery. General-purpose fleet restoration likewise replays the session's original choice.

`/auto` also accepts free-form guidance after its optional flags, such as `/auto --chrome no unit tests needed`. The extension appends it under `# Additional User Guideline For this Session` at the end of every implementer and pr-doctor prompt in that run. It is stored only in the gitignored runtime run record so recovery preserves the instruction; `/auto --dry <guideline>` previews it without writing that record.

Enabling the integration exposes browser tools and the signed-in Chrome session to Claude. aboard does not auto-approve those tools: your own Claude permissions decide whether calls run or prompt. Missing extensions, unsupported providers, or a disconnected browser remain visible in the Claude terminal rather than silently falling back.

## Agent tool sets are not settings

Every aboard-defined agent takes its capability set from the `tools:` field of its `.aboard/agents/<name>.md` definition — including the Manager. The Manager alone admits `mcp__aboard__*`; non-Manager launches additionally receive that namespace as an infrastructure-level denial. The MCP registration itself is ephemeral and passed only to the Manager. To widen or narrow an agent's ordinary capabilities, edit its definition; the change applies on its next launch.

The definitions are deliberately **not** in `.claude/agents/`. For each start or resume, aboard builds `.aboard/runtime/agents/<id>/`: a rewritten definition, generated hook settings, and the aboard skills for that launch. Claude receives the bundle through `--add-dir` and `--settings`; a hand-started session never discovers it. `Explore` remains Claude Code's named built-in and `general-purpose` remains its default session, but both receive the same private hook-and-skill bundle while aboard owns them.

Model and effort are edited in the same place and compose rather than compete: `aboard.launch.effort` sets the session level, and an agent or the Explore profile that declares `model: opus` or `effort: high` in its own frontmatter overrides it. Nothing in an aboard launch applies that frontmatter on its own, so aboard reads both fields and passes `--model`/`--effort` on the command line for you — including on a resume. Use the per-agent file to give one agent more or less reasoning than the rest; use the setting as the fleet-wide default. A level aboard does not recognise is reported in Output → aboard rather than passed through, because Claude Code refuses the whole launch on an unknown one.

### Routing a model by issue difficulty

Either field may instead be set to `by-difficulty`, which hands that one choice to the difficulty label on the issue the agent is being sent at. The three roles that only ever work a single issue — `implementer`, `pr-doctor-afk`, and `pr-doctor-hitl` — ship that way, so a rename is not addressed at the same price as a redesign:

| Issue label | `model:` | `effort:` |
| :-- | :-- | :-- |
| `[AI]-routine-difficulty` | `haiku` | `medium` |
| `[AI]-basic-difficulty` | `sonnet` | `high` |
| `[AI]-advanced-difficulty` | `opus` | `medium` |
| `[AI]-expert-difficulty` | `opus` | `high` |
| *no difficulty label* | `opus` | `high` |

The label rates the work; it never decides whether the work runs. Only `[AI]-afk` and `[AI]-hitl` admit an issue to a run, and an issue with no difficulty label is ordinary — it is worked at the last row, the most capable tier, because the mistake worth avoiding is a hard job given to a small model.

The two fields are independent, and either one you name yourself wins outright: `model: by-difficulty` with `effort: max` routes the model and pins the reasoning level for every tier. Pinning both is how you turn the routing off for an agent, and `model: opus` alone is exactly the definition that shipped before. The tier reaches the terminal you are watching, the rewritten definition, and any later resume of that session, so an agent never comes back cheaper than it started.
