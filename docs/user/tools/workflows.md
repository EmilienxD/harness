# Planning, building, and shipping workflows

Install any package below from the Harness catalogue, or run `harness install <package-name>` from your project. Skills are invoked as `/skill-name` in Claude Code and `$skill-name` in ChatGPT. The `commit` command is handled by a prompt hook. Packages with hooks need the target application restarted after installation.

| Package | When and how to use it |
| --- | --- |
| [`audit`](workflows/audit.md) | Invoke `audit` with a repository, path, or audit focus. It reads code and reports ranked findings with file and line evidence, confidence, and remediation difficulty. |
| [`breakdown-help-wanted-issue`](workflows/breakdown-help-wanted-issue.md) | Invoke with a request to explore it against the codebase and agree on scope. With no argument it fetches the oldest open GitHub issue labeled `[AI]-help-wanted`; this path needs `gh` access. |
| [`grill-me`](workflows/grill-me.md) | Invoke with a plan or design. It asks all currently answerable decisions in rounds, recommends options, and waits for explicit answers before proceeding. |
| [`grill-me-in-cloud`](workflows/grill-me-in-cloud.md) | Invoke with a plan or design to run the same decision interview on a persistent hosted board. Its hook supplies round and asset paths outside the repository, then publishes the round and returns the session URL. |
| [`lavish`](workflows/lavish.md) | Invoke with an artifact request when a plan, comparison, report, diagram, or prototype deserves a reviewable browser page. It uses `npx -y lavish-axi`; the CLI supplies the current design and feedback workflow. |
| [`prototype`](workflows/prototype.md) | Invoke with one design question to test. It builds a disposable prototype in a git-ignored project folder, usually `prototypes/`, and reports the evidence and its limits. |
| [`read-all-adrs`](workflows/read-all-adrs.md) | Invoke before architecture work to read every Markdown decision record under `docs/adr/`. |
| [`websearch`](workflows/websearch.md) | Invoke with a research question for a concise cited answer. It reads and updates the trusted-source index at `.harness/websearch/INDEX.md`; documentation queries can use the Context7 CLI. |
| [`writing-adrs`](workflows/writing-adrs.md) | Invoke after an architectural decision is settled to create an ADR or update its existing record in place. |
| [`issue-readers`](workflows/issue-readers.md) | Installs `address-this` and `review-this`. Invoke either with an issue or commit to prepare bounded context for implementation or review. Their starter skill bodies are editable; Git and authenticated `gh` are required. |
| [`issue-writers`](workflows/issue-writers.md) | Use `draft-issue`, `draft-issues`, `to-spec`, or `to-spec-draft-issue` to prepare local Markdown in `.harness/issue-drafts/`. Review or edit the draft, then invoke `publish-issues` to create GitHub issues; `--dry` previews the publication. Requires Git and authenticated `gh`. |
| [`tdd`](workflows/tdd.md) | Invoke for behavior-focused test-driven work. It agrees on public test seams, then proceeds in small failing-test and implementation slices. This skill may also be selected automatically when relevant. |
| [`commit`](workflows/commit.md) | Enter `/commit <message>` to stage files changed by the current session and commit without a model call. Use `--dry` to preview or `--ai` for a Gemini-generated message; only `--ai` needs an API key. |
| [`resolving-merge-conflicts`](workflows/resolving-merge-conflicts.md) | Invoke during an in-progress Git merge or rebase. It investigates both sides, resolves conflicts, runs project checks, and completes the operation. |
| [`setup-git-worktree-maker`](workflows/setup-git-worktree-maker.md) | Invoke to create or update a project-specific worktree setup command. It derives copied local files, setup steps, an alias, and optionally a VS Code task, then validates the command without creating a worktree. |
| [`setup-help`](workflows/setup-help.md) | Invoke for an installation or configuration task that benefits from one verified action at a time. It maintains a short view of the remaining setup steps as prerequisites emerge. |

`harness install` defaults to the current project and both providers. Add `--platform claude` or `--platform chatgpt` to target one provider, `--scope user` for a user installation, and `--dry-run` to inspect the installer plan.
