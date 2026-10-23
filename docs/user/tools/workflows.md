# Planning, building, and shipping workflows

Install any package below from the Harness catalogue, or run `harness install <package-name>` from your project. Invoke skills as `/skill-name` in Claude Code, `$skill-name` in ChatGPT, or `/skill:name` in Pi. Deterministic commands such as `commit` use hooks or native extension commands; their tool guides list supported forms. Restart after installing hooks, or restart/reload Pi extensions.

| Package | Platforms | Purpose |
| --- | --- | --- |
| [`audit`](workflows/audit.md) | Claude Code, ChatGPT, Pi | Audits a codebase and reports evidence-backed findings |
| [`breakdown-help-wanted-issue`](workflows/breakdown-help-wanted-issue.md) | Claude Code, ChatGPT, Pi | Explore a request and agree with the user on what to build |
| [`commit`](workflows/commit.md) | Claude Code, ChatGPT, Pi | Zero-model-turn /commit with native Pi branch attribution and shared Git/message generation |
| [`flush-out-useless-tests`](workflows/flush-out-useless-tests.md) | Claude Code, ChatGPT, Pi | Audits passing tests in up to 35 test files and proposes cleanup for approval |
| [`grill-me`](workflows/grill-me.md) | Claude Code, ChatGPT, Pi | Interviews you to stress-test a plan or design |
| [`grill-me-in-cloud`](workflows/grill-me-in-cloud.md) | Claude Code, ChatGPT, Pi | Publishes visual design interviews to a persistent hosted board |
| [`issue-readers`](workflows/issue-readers.md) | Claude Code, ChatGPT, Pi | Prepare issue and commit context for address and review workers |
| [`issue-writers`](workflows/issue-writers.md) | Claude Code, ChatGPT, Pi | Draft and publish GitHub issues |
| [`lavish`](workflows/lavish.md) | Claude Code, ChatGPT, Pi | Create reviewable HTML artifacts with the Lavish Editor |
| [`prototype`](workflows/prototype.md) | Claude Code, ChatGPT, Pi | Build throwaway design prototypes to answer a design question |
| [`read-all-adrs`](workflows/read-all-adrs.md) | Claude Code, ChatGPT, Pi | Reads every project ADR for complete architectural context |
| [`resolving-merge-conflicts`](workflows/resolving-merge-conflicts.md) | Claude Code, ChatGPT, Pi | Resolves in-progress Git merge and rebase conflicts |
| [`setup-git-worktree-maker`](workflows/setup-git-worktree-maker.md) | Claude Code, ChatGPT, Pi | Creates a project-native command for fully initialized Git worktrees |
| [`setup-help`](workflows/setup-help.md) | Claude Code, ChatGPT, Pi | Guides users through setup one step at a time |
| [`ship`](workflows/ship.md) | Claude Code, ChatGPT | Agent-led issue delivery with guarded loop implementers |
| [`tdd`](workflows/tdd.md) | Claude Code, ChatGPT, Pi | Test-driven development through behavior-focused red-green vertical slices |
| [`test-workflows`](workflows/test-workflows.md) | Claude Code, ChatGPT, Pi | Define and confirm end-to-end workflows when their covered code changes |
| [`websearch`](workflows/websearch.md) | Claude Code, ChatGPT, Pi | Web research with concise answers and a Markdown source index |
| [`writing-adrs`](workflows/writing-adrs.md) | Claude Code, ChatGPT, Pi | Writes architectural decision records as durable decision contracts |

`harness install` defaults to the current project, Claude Code and ChatGPT. Add `--platform claude`, `--platform chatgpt`, or `--platform pi` to target a provider, `--scope user` for a user installation, and `--dry-run` to inspect the installer plan.
