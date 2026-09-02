# aboard

**Stop trusting summaries. Watch your agents work.**

aboard is a VS Code extension for Claude Code that turns invisible sub-agents into **real terminals you can read, interrupt, and take over** — coordinated by one long-lived Manager, with GitHub holding the work state.

---

## The problem

When Claude Code delegates with the `Agent` tool, the sub-agent runs inside the parent process, in a context window you cannot see. You learn what happened from a summary it chose to write.

You can't watch it. You can't stop it mid-mistake. You can't take the keyboard. You can't resume it tomorrow.

|  | Built-in sub-agents | aboard |
| :-- | :-- | :-- |
| Where it runs | Inside the parent process | Its own VS Code terminal |
| What you see | A summary, afterwards | Every token, live |
| When it goes wrong | You find out at the end | You type into it and fix it |
| Next morning | Gone | `--resume`, same session |
| Work state | The context window | GitHub issues and PRs |

## What it looks like

```
aboard ─ Agents                                       claude --agent implementer
├─ manager               running                      ┌───────────────────────────┐
│  ├─ implementer #19    running · lease holder · 2:05│ > Reading calc.py…        │
│  │  └─ Explore         running                      │ ● Edit calc.py            │
│  └─ brainstormer       running                      │ …                         │
└─ raw                   running                      └───────────────────────────┘
```

You talk to the **Manager**. It plans, delegates, and reports — and it cannot edit your code. Each delegated task opens as its own terminal. Click a node and you're inside it. One agent at a time is the *lease holder*: no two delegated tasks touch your working tree at once, and the status bar always names the one that holds it.

The panel has three views, and each answers exactly one question:

- **Agents** — what is running right now. A row appears only while its terminal is open, so everything you see is something you can go and look at.
- **Auto Run** — the next run's issue forecast, the current run's fixed plan and progress, or the recovery card for one that stopped. The forecast loads when first revealed and **Check Now** refreshes it on demand. Start appears only for a ready preview and performs one final read: if the plan changed, aboard shows the update for review instead of starting. Resume appears only after aboard has checked that git and GitHub still match what the run recorded; when they don't, you get the reason and Discard.
- **Recent Activity** — the last twenty agent and run outcomes, including the conversations you can reopen.

## Quick start

**You need:** VS Code 1.125+, Claude Code, Git, the GitHub CLI (`gh`), and [`uv`](https://docs.astral.sh/uv/).

1. Install the extension (`code --install-extension aboard-*.vsix`).
2. Open your project, click the aboard icon, hit **Initialize**. It installs aboard-owned agent definitions, skills, and hooks under `.aboard/`, starts a loopback-only bridge, and supplies authenticated, role-scoped MCP configuration only to the Manager and brainstormers it launches. Your project-wide Claude settings and MCP servers are untouched.

When an extension update ships different project assets, aboard pauses its runtime and offers **Update .aboard/**. Unchanged owned files are upgraded, locally edited files are preserved and listed, and aboard starts again only after the project records the new scaffold revision.
3. Click **+ New Manager** and ask it something: *"What's the state of this project?"*

Then try one of these in the Manager terminal:

| You type | What happens |
| :-- | :-- |
| `/brainstorm caching strategy` | A brainstormer terminal opens, focused, ready to talk — the Manager never sees the prompt |
| `/general-purpose` | Plain Claude Code, no workflow, tracked by the fleet |
| `/prototype Try the parser API` | A user-driven prototyper opens, follows the project's prototype-location convention (or asks you where to write), and reports back here when you run `/done` |
| `/auto` | The extension walks every open `afk`/`hitl` issue, dependencies first and then oldest first: branch, address, commit, PR, merge — one issue at a time, onto a branch of the run's own |
| `/auto --dry` | Read-only forecast: show the issues found, their dependency-aware order and branches, settings-driven review/merge behavior, blockers, and every point where you will need to act |
| `/auto no unit tests needed` | Start the same run and append that guideline to every implementer and pr-doctor prompt |
| `/done` or `/done <report>` | Close this session and report its last complete answer, or your replacement text, to the session that launched it |
| `/reopen` | The last session you were handed comes back — same conversation, same agent definition. `/reopen brainstorm` picks by type, `/reopen 7` by agent id, and **Aboard: Reopen a Session** lists them all |
| *"Address issue #14"* | One implementer terminal, one branch, one PR, `Closes #14` |

When a session delegates work, its Stop hook waits so the result can arrive without another prompt. Press **Escape** whenever you want the terminal back before that work finishes. Escape cancels only the wait: the eventual report stays queued and is delivered by the next hook that fires.

aboard does not choose or hide a prototype location. The prototyper uses a dedicated scratch, temporary, playground, spike, experiment, demo, or prototype location established by project instructions or architecture; if the project defines none, it asks before writing code. That location may be tracked or ignored, so the user controls whether the work is committed. This is a prompt-level working convention, not a security sandbox: the prototyper's shell can still reach the project. `/done` uses the last complete assistant message aboard observed; if the final turn ended abnormally before its Stop hook ran, that fallback can be older than the terminal's last visible output, so pass explicit report text when that distinction matters.

## The auto-run, honestly

`/auto` is the closest aboard gets to hands-off, and it's deliberately fenced in:

- **Preview the whole bargain first.** `/auto --dry` reads git and GitHub but changes neither. It reports whether a real run can start, the issue order and exact issue branches, which issues carry `[AI]-chrome`, the prospective `aboard/run/<run-id>` session branch and its target, unpublished target commits that the session branch will carry, skipped issues and dependency cycles, review/worktree/final-merge settings, and the user action required at HITL, conflict, failure, and final-PR gates. It is a forecast only because GitHub may change before you start; once a run starts, that plan is what it works.

- **Add guidance permanently or for one run.** Set `aboard.autoRun.prompt` for a persistent note, or put free-form text after the optional `--dry` flag, for example `/auto no unit tests needed`. aboard appends the configured note first and the command's note last to every implementer and pr-doctor prompt. Both are kept in private VS Code workspace storage so interrupted runs resume with the same instructions; `/auto --dry <guideline>` previews them without persisting anything.

- **The extension does every git and GitHub side effect** — branch, commit, push, PR, merge. Agents only produce content. A branch name and a `Closes #N` trailer derived from the issue are correct by construction; an agent writing them is a sampling operation that drifts silently.
- **Nothing lands on your branch behind your back.** A run cuts one session branch, `aboard/run/<id>`, from the branch you were on. Every issue branches off that, merges back into it, and the run closes the issue itself — GitHub only honours `Closes #N` on the default branch, and a run never merges there. When the queue drains, you get **one** pull request from the session branch into the branch you started on. `aboard.autoRun.mergeRunPullRequest` decides whether aboard tries to merge that one; it is off by default.
- **`aboard/*` is reserved.** Issue and session branches are run-owned artifacts, so a new auto-run refuses to use one as the branch that receives its final pull request. Check out the human-owned integration branch you want before starting another run.
- **One issue at a time, and one fixed list.** No parallel fan-out: merge conflicts and self-contradicting agents destroy more value than concurrency creates. Before Start, the Auto Run view continuously forecasts the current queue. The list is settled once Start performs its final read; label something `afk` an hour later and it waits for the next run. The frozen list remains visible while the run works.
- **Optionally, out of your way entirely.** With `aboard.autoRun.worktree.enabled`, the run takes a second checkout of the repository beside your project and works there — your files and your branch are untouched, a dirty tree of yours no longer refuses the run, and you can keep working while it does. It costs a full checkout plus whatever your `.aboard/session-setup.*` installs into it, so it is off by default. Agents get deny rules covering your checkout; that stops the accident, not a determined shell command.
- **Labels decide how far it goes.** `afk` means an issue may be merged unattended. `hitl` means the run opens the PR and stops — your merge *is* the approval. Parent issues and sub-issues use the same classification rules; there is no special planning label.
- **And how much it costs.** A difficulty label on the issue — `routine`, `basic`, `advanced`, `expert` — picks the model and reasoning level its implementer and reviewer run at, so a rename is not addressed at the price of a redesign. It is the definition's own choice to ask: any agent whose `model:` or `effort:` names a value keeps it, and an unlabelled issue gets the most capable tier rather than the cheapest.
- **Every phase is idempotent.** Close your laptop mid-run. Resume picks up at the first step that didn't finish, and every mutation is journalled beforehand so a crash between "the push succeeded" and "the record saved" is recognised rather than repeated.

- **It refuses to guess.** Before each step, aboard checks the whole plan against git and GitHub. A run-owned branch that moved, an issue closed or relabelled under it, a pull request retargeted or merged by somebody else: any of these stops the run and says which. It doesn't roll anything back, and it doesn't quietly carry on with a plan that no longer describes reality. Stopping costs you a click; continuing costs you work you never approved.
- **Review is opt-in.** LLM tokens are your money, not ours.
- **Chrome is opt-in per issue.** Add `[AI]-chrome` to an implementable issue to launch that issue's implementer with Claude in Chrome. The choice is frozen with the plan, survives resume, and a later label change breaks recovery instead of silently changing the launch.

## Why you can leave it running

- **One writer, enforced.** The write lease is derived from each agent's actual tool set, not a flag someone remembered to set. Two delegated tasks cannot edit your tree at once. It locks automated work, never your own hands: a terminal you're chatting in takes no lease, so you stay free to work in parallel.
- **Loopback only.** The bridge binds `127.0.0.1` and requires a per-activation bearer token on every request. Tokens live outside your project and are never committed.
- **Your config stays yours.** aboard never modifies `.claude/`, `.gitignore`, or `CLAUDE.md`. Hooks and skills are selected from an isolated bundle for each aboard launch.
- **Nothing hidden runs.** The bridge is the only creator of agents. A Claude session you start by hand is outside the system, and aboard's hooks stay silent in it.
- **Scaffolded files are versioned.** Edit one, and the next update warns instead of clobbering it.

## Things aboard will never do

This list is a feature, and it's [written into the contract](./AGENTS.md#mission) so it survives future contributors:

- Approve its own pull requests.
- Let the Manager quietly implement something itself.
- Fan out N agents at your repo to look fast.
- Review everything by default and hand you the bill.
- Type into a live TUI on your behalf.

> aboard is not an autonomous software factory. It's an attempt to make building a real project *with* agents feel good. Automation is applied where it removes tedium, never where it removes judgement.

## Documentation

| | |
| :-- | :-- |
| [AGENTS.md](./AGENTS.md) | The product, behavior, and architecture contract — the reasoning behind every decision above, the auto-run phase by phase, and the module layout |
| [docs/configuration.md](./docs/configuration.md) | Every `aboard.*` setting and how the three config layers resolve |
| [docs/command-terminals.md](./docs/command-terminals.md) | Running a script's command in a visible VS Code terminal over the bridge |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | Build, test, package |

## Status

Pre-1.0 and moving. The runtime works end to end; the API, scaffold assets, and settings may still change between versions. Issues and discussion are welcome — [AGENTS.md](./AGENTS.md) is the best place to argue with a decision, and it names its open questions.

Licensed under [MIT](./LICENSE).
