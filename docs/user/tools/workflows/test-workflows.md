# Test workflows

Platforms: **Claude Code, ChatGPT, Pi**. Install with `harness install test-workflows`; see [installation and scope](../../getting-started.md).

Installation adds the shared skill. Run the CLI on demand with uv and Git:

```sh
uvx --from git+https://github.com/EmilienxD/harness@d0c2b77165a680cd86b7668daf20940e17826b3f#subdirectory=harness/building/test-workflows test-workflows status
```

Use this uvx prefix for every `test-workflows` command below. The first invocation downloads and builds the pinned package; later invocations reuse uv's cache. No host CLI is installed. Sandboxed providers need network access for acquisition and write access to uv's cache.

Store one Markdown file per capability in the project's workflow folder, default `tests/workflow/`. Use the test title as its filename. Put the check and its coverage patterns in `tests/workflow/greeting.md`:

```markdown
---
covers: ["src/greeting/**/*.py"]
---
## Preconditions
- The application is running with its development configuration.
## Steps
- Open the greeting page and submit a name.
## Acceptance Criteria
- [ ] The page displays the personalized greeting.
## Potential Problems
- An empty name produces a broken or misleading greeting.
```

Run the workflow, then `test-workflows confirm tests/workflow/greeting.md` to automatically create or update the sibling `greeting.manifest.json` with the normalized covered-file hash and generated `verified_files` inventory. Commit both files. Agents write and read the Markdown, including its `covers` patterns; the CLI manages the manifest. A workflow without a manifest is unconfirmed (`stale`). Hashes normalize line endings, so equivalent Windows and Unix checkouts agree. `test-workflows status` reports workflow states and changed covered files in TOON format, including broken mappings whose globs match nothing and malformed workflows or manifests. Add `--json` before or after the command to output JSON instead; this also applies to confirmation and command errors. Exit codes are 0 for all passing, 1 for a stale/broken/invalid workflow, and 2 for a command error. Discovery finds tracked/non-ignored Markdown with `covers` front matter; use `--directory <folder>` or `--root <checkout>` before the subcommand to narrow it.

Run `test-workflows status` explicitly when verifying changes, as you would run unit tests, then run the affected checks and confirm passing ones. Loop implementers run and report; only the Lead stamps their results. Pi uses the same shared skill and on-demand CLI; invoke `/skill:test-workflows` to load it explicitly. Confirmation records verification performed by the agent; it does not execute the acceptance steps.

## Pi execution and evidence

`test-workflows` 1.6.0 maps its shared skill to Pi and runs the pinned CLI through uvx.
Pi's native skill format already supplies the required context; an extension would add no executable
boundary. Status compares covered-file hashes, actual workflow execution supplies evidence, and explicit
confirmation records a passing run. Failed execution leaves the earlier manifest stale.

The `test:pi-test-workflows` journey installs the real package and exercises native project/user skill usage, actual workflow execution, explicit confirmation, covered-file hash changes and receipt-driven removal. The verified environment is Windows Pi 1.2.0 JSON/RPC with authenticated fake inference. It certifies CLI/skill integration rather than unscripted model judgment, POSIX or TUI behavior. See the [E2E commands](https://github.com/EmilienxD/harness/blob/main/tests/e2e/README.md#pi-document-drafts-git-cleanup-and-test-workflows).
