# Validate Request

Explore an idea against the codebase, resolve the questions that matter, and produce a chat
report the user can approve, revise, or reject. The agent investigates before interviewing,
surfaces blockers, and challenges proposals whose costs outweigh their benefits. It does not
implement the request or write an issue draft.

## Install

```bash
uvx --from git+https://github.com/EmilienxD/harness@v0.2.0 harness
```

The skill is user-invocable only on both platforms. Restart the selected product after
installation and review/trust its project hooks when prompted. The GitHub fallback requires
`git` and an authenticated `gh` with access to the current repository.

## Use

```text
/validate-request Let users retry failed imports without uploading the file again
/validate-request
```

Use `$validate-request` in ChatGPT, with the request in the surrounding user text.
An explicit request takes precedence over any fallback issue.

With no request, the skill uses the oldest **open issue by creation time** with the exact label
`[AI]-help-wanted`. A `UserPromptSubmit` hook fetches it for a standalone invocation and supplies
its number, URL, title, creation time, and full body directly in `additionalContext` as concise
plain text. It orders matches on GitHub and pages past pull requests, so it does not select the
oldest among a limited set of recent issues. If that context exceeds the host's model-visible
limit, Claude Code or ChatGPT saves the full text to its own temporary file and gives the agent
a preview and file path.

The hook ignores invocations with a request and unrelated prompts. It recognizes bare
`/validate-request`, `$validate-request`, and ChatGPT's standalone Markdown skill reference.
For other invocation forms, the skill performs the lookup if no source was supplied.
An empty queue prompts the agent to ask for a request; a failed lookup is reported separately.
Neither outcome blocks prompt submission. The hook never changes the issue or its labels.

The report covers purpose, current behavior with evidence, scope and acceptance criteria,
blockers and unresolved decisions, and a recommendation. After validating it, invoke the
existing [`draft-issue`](../issues/README.md) skill to turn the report into a reviewed draft
with the appropriate labels. Install `issues` separately for that next step; its drafting
and publishing workflow is unchanged.
