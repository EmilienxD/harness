# Issue delivery with `/ship`

Platforms: **Claude Code, ChatGPT**. Install with `harness install ship`; see [installation and scope](../../getting-started.md).

The skill runs `issue-context` and `ship-stubs` through pinned uvx commands recorded in its opening instructions. uv and Git must be on PATH; first use downloads and builds the helpers into uv's cache. Installation adds their skill instructions and retains the persistent `subagents` runtime; it does not install these helper CLIs. `test-workflows` supplies its own pinned uvx command. Sandboxed providers need acquisition network access and a writable uv cache.

`test:ship-helpers` verifies the published helper pins through real headless Codex and fake inference on Windows: issue context from a local GitHub CLI fixture, rejection of an unimplemented anchored stub, acceptance after a native shell write, no installed helper CLIs, and the retained persistent runtime. It checks five inference requests and zero unexpected requests. Full live GitHub delivery, Claude and POSIX remain separate acceptance boundaries.

Run `/ship` in Claude Code or `$ship` in ChatGPT. With no argument it selects the oldest open `[AI]-triaged` issue without open blockers or open sub-issues, skipping claimed issues and those needing a decision or help. Pass issue numbers explicitly to direct parallel sessions. A parent expands to leaf issues in dependency order, with one loop and PR per leaf. After each delivery you choose whether to continue; an explicit instruction to process the whole queue also works. Pass a PR URL to pick up review comments on its existing branch/worktree.

The Lead reads full GitHub context through `issue-context`, creates a worktree only through the project's initialized-worktree script, and defines success before implementation. Missing or failing scripts stop delivery with a suggestion to run `setup-git-worktree-maker`. Project instructions supply the target branch (the Lead asks if absent), merge method (squash by default), and test locations (defaults: `tests/unit/` and `tests/workflow/`). The first branch commit contains deliberately failing unit stubs and workflow criteria only. Implementers fill exactly those stubs; `ship-stubs check` provides the structural Python contract check, while other languages need their native discovery/diff check. Each issue's run state (criteria anchor, implementer sessions, prompts, reports, and evidence) lives in `~/.harness/ship/<owner>-<repo>/issue-<n>/`, which `/ship <PR>` resumes from.

Implementers run in visible terminals through initialized Aboard when available or the standalone terminal launcher. Every successful Stop delivers a report automatically, including context usage when measurable, and waits for exact-token Lead feedback or release. Feedback keeps the same conversation. The Lead accepts a report only when every required test and workflow passes with evidence, without rerunning verification. It replaces an implementer when context or feedback limits, repeated failures, or an unconvincing report warrant it. A fresh implementer receives the original prompt, diff, last report, and recorded problems. Only one implementer may be active per worktree. The optional explorer also uses the subagents runtime.

The Lead owns Git/GitHub mutations and workflow confirmation. Loop-only guards deny Git/GitHub mutation, writes into the repository's other checkouts, and workflow edits. Your own sessions in the same worktree stay unrestricted. These command/path hooks are guardrails, not an operating-system sandbox. Steering is included in reports; interrupts pause delivery. A killed waiting hook invalidates its token, so stale feedback is rejected. Waiting uses `session.stopWaitHours` (up to 24 hours). A timed-out working implementer keeps its worktree reservation until it reaches Stop or its process exit is confirmed; the Lead waits for it to become inactive before publishing or replacing it. Unknown context skips the context threshold; unvalidated Claude model windows remain unknown. Aboard can resume an idle loop in its existing terminal; an idle standalone terminal must exit before runtime resume, or the Lead can launch a fresh implementer. A later `/ship <PR>` conversation on the same provider takes over a released implementer and receives its reports. On Claude, `ship` sets `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` to 100 in its installed settings scope: each implementer report continues the Lead's turn through a Stop hook, and Claude otherwise ends a turn after 8 consecutive continuations.

Before opening a PR the Lead merges the latest target once, requests a confirming round when it brought changes/conflicts, stamps passing workflows, checks stale workflows affected by the diff, and enforces the stub contract. The sync confirmation is outside the feedback cap. PR descriptions explain the change and staging checks and use `Refs #n`, keeping the issue open. `[AI]-auto-merge` permits the Lead to merge; other PRs remain open. The Lead comments with the PR link. Decisions, exhausted caps, and expired waits preserve work in a draft PR with `[AI]-needs-decision` and a precise question. Unrelated blockers become linked `[AI]-help-wanted` issues; in auto-merge mode the Lead delivers the prerequisite first and resumes the original. You verify staging and close the issue yourself.

| Label | Meaning |
| --- | --- |
| `[AI]-triaged` | User-approved eligibility for automatic selection. |
| `[AI]-in-progress` | Claimed; `/ship` keeps it until the issue is closed. |
| `[AI]-needs-decision` | Waiting for your decision, alongside the claim. |
| `[AI]-help-wanted` | A tracked prerequisite needing breakdown or help. |
| `[AI]-auto-merge` | The Lead merges the passing PR. |
| `[AI]-*-difficulty` | Routes a `by-difficulty` implementer profile using existing difficulty mappings. |

Missing labels are created on first use. Labels plus PR timeline references describe issue state from GitHub alone. `[AI]-afk` and `[AI]-hitl` remain Aboard's metadata. `address-this`, `review-this`, Aboard Auto Run, and manual ask/reply keep their existing flows.

Sparse `.harness/config.json` version 1 settings:

```json
{
  "version": 1,
  "providers": {
    "claude": { "delegations": { "loop": { "model": "by-difficulty" } } },
    "chatgpt": { "delegations": { "loop": { "model": "by-difficulty" } } }
  },
  "loop": { "maxFeedback": 3, "maxImplementers": 2, "freshContextPercent": 65 },
  "session": { "stopWaitHours": 24 }
}
```

The `loop` profile accepts `model` and `effort`; omitted values inherit provider settings, and `by-difficulty` selects the existing model/effort mapping. Implementers use the Lead's provider and the worktree's configuration. Target and merge method belong in project instructions, not this configuration. Runtime commands are `harness loop launch --cwd <worktree> --prompt-file <file>`, `lookup <session>`, `feedback <session> --wait-token <token> --file <file>`, `release <session> --wait-token <token>`, and `resume <session> --file <file>`. `launch` accepts `--parent <Lead-id>` when not already inside the registered Lead environment.

## Pi status

Pi support is not shipped. The reusable Lead skill and issue/stub CLIs are insufficient: Pi still needs Lead binding, loop reports/wait tokens, bounded feedback, context telemetry and pre-tool implementer restrictions. Preserve Git/GitHub ownership, workflow freshness caps, released-implementer adoption, PR resume, token invalidation and one implementer per worktree. [Subagents](../productivity/subagents.md) supports ordinary Pi delegation but rejects Pi loop implementers. Require real session/denial evidence before advertising `/ship` parity.
