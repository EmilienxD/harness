# Issue writers

Platforms: **Claude Code, ChatGPT, Pi**. Install with `harness install issue-writers`; see [installation and scope](../../getting-started.md).

## When to use

Use `draft-issue` for one agent-sized vertical slice, `draft-issues` for a connected set, `to-spec` for a spec in the response, and `to-spec-draft-issue` for an editable spec issue. `publish-issues` is the separate publication step.

## Invocation

Claude Code uses `/skill-name`; ChatGPT uses `$skill-name`; Pi uses `/skill:skill-name` for drafting and specs, with no short drafting aliases. Pi handles `/publish-issues [--dry]` as a native command with zero inference; there is no `/skill:publish-issues`. Pass a request, plan, spec path, issue number, or URL to a drafting skill. Use `publish-issues --dry` to preview before publishing.

## What happens

`draft-issues` proposes titles, parent links, dependencies, and labels, then waits for your approval before writing files. `to-spec` synthesizes existing context without another interview. Drafting skills leave editable files for review by default. If you explicitly ask the agent to publish, it runs its bundled publishing script using the same core as the publication hook or native Pi command. Approval of a breakdown or draft alone does not authorize publication.

The agent script accepts optional `--dry` and automatically resolves the current session's batch from the provider environment; it has no session-selection argument. It returns issue links and failure details directly to the agent, without queuing a duplicate next-prompt notice. The user command keeps its existing deferred notice behavior.

Deterministic journeys verify agent publication with real Claude Code, Codex and Pi CLIs against local fake model and GitHub APIs, including automatic session identity, immediate results and no deferred notice.

ChatGPT uses `CODEX_THREAD_ID`; Pi uses `PI_SESSION_ID`. Claude's SessionStart hook writes `HARNESS_ISSUES_CLAUDE_SESSION_ID` through `CLAUDE_ENV_FILE` for subsequent Bash commands. Restart or resume Claude after upgrading so that hook runs. Missing, empty or conflicting provider identities stop the script before publication; it never guesses from PIDs or nearby drafts. Nested providers with inherited identities may therefore be rejected. This prevents accidental batch selection, but shell environment variables are editable and do not isolate an agent deliberately bypassing the publisher. Codex environment injection is documented in its [execution server](https://github.com/openai/codex/blob/main/codex-rs/exec-server/README.md); Claude environment persistence and Pi shell metadata are covered in the mirrored [Claude hooks](../../../CLAUDE-REFERENCES/hooks.md#persist-environment-variables) and [Pi environment](../../../PI-REFERENCES/docs/environment-variables.md#shell-tool-session-environment) references.

Review and edit the Markdown files directly. The dry-run text lists valid drafts in publication order with their paths, labels, parents and blockers, followed by errors for skipped drafts. References such as `draft 0` identify the `.issue-0.md` filename index, not the displayed publication position. The preview stays local and does not verify GitHub access or permissions.

## Files and prerequisites

Claude Code and ChatGPT are supported through hooks; Pi uses an extension and the same publishing core. `git` and `gh` are required; publication needs repository access. Drafts live in `.harness/issue-drafts/` as editable Markdown. Published drafts are deleted, and abandoned drafts are swept after a week. If `publish-issues` reaches the model, check its hook or Pi extension installation.

## Example

In Pi: `/skill:draft-issues docs/spec.md`, approve the mapping, review the draft files, and run `/publish-issues --dry` before publishing.

Pi namespaces native session IDs into separate draft batches, preserves identity across reload/resume, and supplies the next draft path for the three file-drafting skills. Response-only `to-spec` leaves the draft store untouched. Publication retains repository locks, dependency ordering, parent links, crash recovery and pending notices. A new/forked Pi session has its own batch. Notices reach the next non-publication prompt once. Finish the active turn before invoking these workflows. Reload Pi after installation and approve the extension resources; a missing skill or failed setup stops preparation. Native JSON/RPC project and user journeys were verified on Pi 1.2.0 with both local fake GitHub journeys and real authenticated `gh` against the private `harness-e2e` test repository.

## Pi publication and session ownership

Writers reuse `issues_core.py` without changing publishing semantics. UUIDv5 identities use
`harness:issues:pi:<native-session-id>`; reload/resume retain that batch, while native new/fork
sessions select another. `/publish-issues [--dry]` is a native command consumed without inference; its skill
shim is installed only for Claude Code and ChatGPT. Repository locks, draft ordering, parent links, crash recovery, stale sweeping
and next-prompt notices remain owned by the shared core.

For the native user command, Pi shows one activity notification during preparation or publication and a text result with created issue titles/links and failure details. The visible report stays out of model context. On the next input, the agent receives a compact notice mapping draft paths to real issue numbers plus reported failures. Agent script publication returns its results immediately instead. Publication timeouts warn that some issues may already exist and direct you to rerun for recovery.

Input routing, cancellation, transport limits and the shared acceptance journeys are documented with [issue readers](issue-readers.md#pi-routing-and-context-preparation).
