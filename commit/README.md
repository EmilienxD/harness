# Commit Tool

This document explains the `commit` helper tool used in this repository. The tool
is a small CLI helper that assists with creating, reviewing, and finalizing git
commits following the project's conventions.

Summary
- Purpose: speed up and standardize commits (message formatting, changelog
  snippets, sign-off, and optional pre-commit checks).
- Scope: local developer workflow; it does not push changes by default.

Install
- The commit tool is included in this repo under `commit/` and is intended to
  be run from the repo root. No global install is required.

Basic Usage
- Run the tool from the repository root:

  `commit\run` (Windows Powershell) or `./commit/run` (Unix shells)

- Typical interactive flow:
  - Select staged files or stage files from an interactive prompt.
  - Enter a concise commit subject (50 characters or less recommended).
  - Provide an optional longer description/body (wrap at ~72 chars).
  - Add metadata: issue/PR reference, co-authors, and sign-off.
  - Optionally run automated checks (linters, tests) before committing.

Flags and Non-interactive Modes
- `--yes` / `-y`: accept defaults and commit without interactive prompts.
- `--amend`: amend the previous commit (keeps message editable by default).
- `--no-verify`: skip running pre-commit hooks/checks.
- `--message "..."` / `-m "..."`: provide the commit message non-interactively.
- `--signoff` / `-s`: append a `Signed-off-by:` trailer to the commit message.

Configuration
- `commit/settings.json` contains configurable defaults such as default
  linters to run, local templates, and whether interactive staging is enabled.
  Edit that file to adjust behavior for your development environment.

Examples
- Interactive commit (recommended):

  `./commit/run`

- Non-interactive quick commit with message:

  `./commit/run -m "Fix: make widget load lazily" -y`

- Amend last commit and keep message editable:

  `./commit/run --amend`

Best Practices
- Keep the subject short and imperative (e.g., "Add X feature", "Fix Y bug").
- Use the body to explain why the change was made, not what the change is
  (the diff shows what).
- Reference issue numbers or PRs when applicable (e.g., "Closes #123").

Troubleshooting
- If the tool fails to run, check that `commit/run` is executable (`chmod +x` on
  Unix) or invoke it explicitly with the shell (e.g., `bash commit/run`).
- When `--no-verify` is used, hooks will be skipped — only use this when you
  understand the implications.

Security and Safety
- The tool will not push to remote repositories by default. After committing,
  explicitly run `git push` when ready.
- Review the changes staged by the tool before finalizing the commit.

Extending the Tool
- The tool's implementation is intentionally simple; feel free to modify
  `commit/run` and `commit/settings.json` to add project-specific checks or
  templates. Please keep changes consistent with repository conventions and
  discuss major changes in a PR so teammates are aware.

Contact
- If you have questions or encounter bugs with the commit helper, open an
  issue in this repository or contact the maintainers listed in `CONTRIBUTING`.

Acknowledgements
- Adapted for this project to encourage consistent commit practices and make
  local developer workflows faster and less error-prone.
