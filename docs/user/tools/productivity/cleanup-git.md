# Cleanup git

Platforms: **Claude Code, ChatGPT, Pi**. Install with `harness install cleanup-git`; see [installation and scope](../../getting-started.md).

Automatically inventories every local branch and worktree with a bundled read-only script that runs without arguments from the current directory. Supplies a titled **Git cleanup inventory** in compact TOON tables. Checks merge ancestry, protected branches, local and ignored files, locks, submodules, and ongoing Git operations; includes GitHub facts when `gh` is available. The skill contains the cleanup rules and proposes named actions for approval before deletion or worktree removal. On Pi, `/cleanup-git` and `/skill:cleanup-git` prepare the inventory before expanding the native skill.

## Pi inventory preparation

`cleanup-git` 1.2.1 uses a Pi-only coupled `pi-transport` dependency and package-local input adapter.
Both `/cleanup-git` and `/skill:cleanup-git` collect the shared read-only Git/GitHub inventory before
native skill expansion, preserving arguments and images in one submission. No mutable pending inventory
survives branch changes. Missing skills, invalid repositories and transport failures stop the invocation
before inference; informational missing facts remain visible in the inventory. Approval and immediate
live-state checks remain the shared skill's model-driven workflow, not an automatic deletion policy.

## Verification

The `test:pi-cleanup-git` journey installs the actual package at project/user scope and runs Pi 1.2.0 JSON/RPC on Windows against authenticated fake inference. It checks inventory effects, invocation failures, request counts, lifecycle handling and receipt-driven removal. These checks certify native integration and preparation; approval and immediate live-state checks still govern any cleanup. See the [E2E commands and acceptance boundary](https://github.com/EmilienxD/harness/blob/main/tests/e2e/README.md#pi-document-drafts-git-cleanup-and-test-workflows).
