# Aboard

Platforms: **Claude Code, ChatGPT, Pi**. Install with `harness install aboard`; see [installation and scope](../../getting-started.md).

`aboard` installs the Aboard VS Code extension for Claude Code, ChatGPT, and Pi. It opens attended sessions and Auto Run workers in visible terminals, tracks live work in **Agent Fleet**, and keeps completed work in **Recent Activity**. Background agents have read-only progress views.

Select `aboard` in the Harness catalogue or run `harness install aboard`. Harness verifies and installs a pinned VSIX plus required worker assets. The coupled `auto` bridge is installed with Aboard; `issue-readers` is a reusable dependency. Initialize a project once in VS Code, then choose **Run Agent**, **Run Claude Code**, or **Run Codex** in the Aboard panel.

Project launch settings live in `.harness/config.json`; `{ "version": 1 }` is valid and omitted values use defaults. Aboard project settings live in `.abd/settings.json`, with `aboard.*` VS Code settings supplying user or profile defaults. New launches read current launch settings; existing terminals retain theirs.

Auto Run forecasts a queue of labelled GitHub issues. Review the panel forecast or run `/auto --dry` in an Aboard-launched Claude session (`$auto --dry` in ChatGPT). Start from the panel or use `/auto` (`$auto` in ChatGPT). Aboard coordinates issue branches and a RUN branch, with visible workers and recoverable state. Its final pull request remains open for review unless configured automatic merging succeeds. The [Aboard README](https://github.com/EmilienxD/harness/blob/main/apps/aboard/README.md) has the full settings reference for repository collaborators.

## When to install it

Choose Aboard when you want provider sessions in VS Code terminals you can inspect and resume, or when you want to process labelled issues through Auto Run. Select a background agent in the Fleet, or run **Aboard: Watch Background Agent**, for read-only live progress.

## Configure launches

The following `.harness/config.json` selects the default Auto Run provider and gives Claude's Auto Run exploration a separate command:

```json
{
  "version": 1,
  "autoRun": { "provider": "claude" },
  "providers": {
    "claude": {
      "autoRun": {
        "explore": { "command": ["clauder", "run", "kiro"] }
      }
    }
  }
}
```

Manual delegation profiles use `providers.<provider>.delegations` with `explore`, `prototype`, `websearch`, `brainstorm`, `address`, `review`, and `general` keys. Auto Run workers use separate `explore`, `address`, and `review` keys under `providers.<provider>.autoRun`. The configured command must exist. Optional `.abd/session-setup.ps1` and `.abd/session-setup.sh` scripts prepare worktree checkouts.

## Auto Run choices and limits

AFK mode accepts a successful worker result with one clean descendant commit. HITL mode waits for you to accept by creating exactly one nonempty commit with a clean checkout. Aboard owns branch changes, publication, and integration. A stopped or interrupted run retains recovery state; a normal HITL acceptance commit advances without manual resume.

Set `aboard.sessions.interactiveResumeMode` to `reuse-terminal` in VS Code settings to submit a continuation into a matching live interactive child terminal. Its default is `fork`; if the terminal cannot be reused, Aboard uses the fork or reopen flow. Exploration is read-only and headless and cannot be taken over or resumed.

## Pi sessions and restrictions

The catalogue's Aboard 0.3.9 pin ships native Pi launch/configuration, session lookup/resume, preflight, lifecycle and skill adapters, UI/provider choices, managed extension assets and worktree setup. Use `--platform pi` when installing the Pi assets. Visible terminal sessions, leases, authenticated bridge messages and prompt receipts retain the same product contract. Fresh sessions let Pi assign their IDs and bind the observed startup identity; resume/fork validate explicit saved identity. Session replacement ends the old binding before the new one is attached.

Read-only and safety admission runs before checkout creation. Native read-tool selection alone cannot constrain MCP/custom mutators or trusted extension I/O. A required restriction extension must load through a controlled path and tool/resource coverage must be enforceable; `requireEnforceableRestrictions` refuses launches without that evidence. Pi still runs with the operating-system user's permissions. Worktrees supply an assigned working directory and per-turn guidance, not filesystem isolation.

Auto Run keeps its existing acceptance-commit contract and Git permissions. These differ from the stricter Lead-owned Git/GitHub mutations required by `/ship`. A zero JSON process exit or accepted RPC prompt is insufficient completion evidence: settlement, final message status and abort/error outcomes matter. The full application navigation and verification commands live in the [Aboard README](https://github.com/EmilienxD/harness/blob/main/apps/aboard/README.md).
