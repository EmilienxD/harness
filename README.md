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

## Quick start

**You need:** VS Code 1.125+, Claude Code, Git, the GitHub CLI (`gh`), and [`uv`](https://docs.astral.sh/uv/).

1. Install the extension (`code --install-extension aboard-*.vsix`).
2. Open your project, click the aboard icon, hit **Initialize**. It installs agent definitions, skills, and hooks, starts a loopback-only bridge, and adds the authenticated aboard MCP registration while preserving your existing servers and settings.
3. Click **+ New Manager** and ask it something: *"What's the state of this project?"*

Then try one of these in the Manager terminal:

| You type | What happens |
| :-- | :-- |
| `/brainstorm caching strategy` | A brainstormer terminal opens, focused, ready to talk — the Manager never sees the prompt |
| `/general-purpose` | Plain Claude Code, no workflow, tracked by the fleet. Add `--chrome` when this session needs visible browser debugging |
| `/auto` | The extension walks every open `afk`/`hitl` issue, dependencies first and then oldest first: branch, address, commit, PR, merge — one issue at a time, onto a branch of the run's own |
| `/auto --chrome` | The same run, with Claude in Chrome enabled for every implementer in this run |
| `/reopen` | The last session you were handed comes back — same conversation, same agent definition. `/reopen brainstorm` picks by type, `/reopen 7` by agent id, and **Aboard: Reopen a Session** lists them all |
| *"Address issue #14"* | One implementer terminal, one branch, one PR, `Closes #14` |

## The auto-run, honestly

`/auto` is the closest aboard gets to hands-off, and it's deliberately fenced in:

- **The extension does every git and GitHub side effect** — branch, commit, push, PR, merge. Agents only produce content. A branch name and a `Closes #N` trailer derived from the issue are correct by construction; an agent writing them is a sampling operation that drifts silently.
- **Nothing lands on your branch behind your back.** A run cuts one session branch, `aboard/run/<id>`, from the branch you were on. Every issue branches off that, merges back into it, and the run closes the issue itself — GitHub only honours `Closes #N` on the default branch, and a run never merges there. When the queue drains, you get **one** pull request from the session branch into the branch you started on. `aboard.autoRun.mergeRunPullRequest` decides whether aboard tries to merge that one; it is off by default.
- **One issue at a time.** No parallel fan-out. Merge conflicts and self-contradicting agents destroy more value than concurrency creates. Issues merge into a branch nobody else is touching, so conflicts collect at the one pull request a human looks at.
- **Optionally, out of your way entirely.** With `aboard.autoRun.worktree.enabled`, the run takes a second checkout of the repository beside your project and works there — your files and your branch are untouched, a dirty tree of yours no longer refuses the run, and you can keep working while it does. It costs a full checkout plus whatever your `.aboard/session-setup.*` installs into it, so it is off by default. Agents get deny rules covering your checkout; that stops the accident, not a determined shell command.
- **Labels decide how far it goes.** `afk` means an issue may be merged unattended. `hitl` means the run opens the PR and stops — your merge *is* the approval. Four labels, no hidden state: `spec`, `todo`, `afk`, `hitl`.
- **Every phase is idempotent.** Close your laptop mid-run. Resume re-derives state from git and GitHub rather than trusting a file.
- **Review is opt-in.** LLM tokens are your money, not ours.
- **Chrome is opt-in per run.** Browser tool definitions and signed-in browser access are loaded only when you type `/auto --chrome`, call `start_auto_run` with `chrome: true`, or use the dedicated palette command.

## Why you can leave it running

- **One writer, enforced.** The write lease is derived from each agent's actual tool set, not a flag someone remembered to set. Two delegated tasks cannot edit your tree at once. It locks automated work, never your own hands: a terminal you're chatting in takes no lease, so you stay free to work in parallel.
- **Loopback only.** The bridge binds `127.0.0.1` and requires a per-activation bearer token on every request. Tokens live outside your project and are never committed.
- **Your config stays yours.** aboard adds hook registrations to `.claude/settings.json` and nothing else. It never writes `permissions`. It never scaffolds a `CLAUDE.md` — that file is yours.
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
| [CONTRIBUTING.md](./CONTRIBUTING.md) | Build, test, package |

## Status

Pre-1.0 and moving. The runtime works end to end; the API, scaffold assets, and settings may still change between versions. Issues and discussion are welcome — [AGENTS.md](./AGENTS.md) is the best place to argue with a decision, and it names its open questions.

Licensed under [MIT](./LICENSE).
