# No New Documents

`no-new-documents` protects new files in chosen documentation paths on Claude Code, ChatGPT, and Pi. Existing files remain editable. A blocked new file is written as a draft under `.harness/doc-drafts/` with the same relative path, for example `docs/arch/plan.md` becomes `.harness/doc-drafts/docs/arch/plan.md`. The draft directory is git-ignored.

Install with `harness install no-new-documents` and restart the provider. Set protected paths in `.harness/guards/no-new-documents.toml`, or `~/.harness/guards/no-new-documents.toml` for user scope:

```toml
version = 1
protected = ["**/docs/**", "project-notes/**"]
```

The starter protects `**/docs/**`. Patterns use gitignore-style `*`, `?`, and `**`. User and project protected paths both apply; Harness preserves the starter file after edits.

For Pi, add `--platform pi`. Its user-scope starter lives at `<PI_CODING_AGENT_DIR>/hooks/no-new-documents.toml`, defaulting to `~/.pi/agent/hooks/no-new-documents.toml`. Home and project policies also apply. The extension guards native writes and recognized literal shell creations, including nested tool calls; arbitrary scripts and other extensions' direct filesystem access remain outside this guardrail.

Native writes follow Pi's `@`, tilde, file URL, Unicode-space and Windows shell-path expansion. Logical and resolved paths both retain protection, and draft writes reject linked ancestors. Malformed policy or an unavailable Python helper blocks covered calls. Existing documents remain editable.

Review the draft, then run `/approve-doc-draft docs/arch/plan.md` or `/reject-doc-draft docs/arch/plan.md` in Claude Code or Pi; use `$approve-doc-draft` or `$reject-doc-draft` in ChatGPT. With no path, these commands list drafts; a directory handles its pending drafts together. Quote paths containing spaces. Approval never overwrites an existing target. To request changes, tell the agent what to revise in the draft.

## When to use it

Use this when creating documents should involve a human review, while routine edits to existing documents can proceed. The protected paths control where the draft flow applies; paths outside them follow normal provider behavior.

## Review example and limits

For a new `docs/arch/plan.md`, inspect `.harness/doc-drafts/docs/arch/plan.md` and ask for revisions there. Approval moves the draft to its target; rejection deletes the draft. Neither command calls a model. A draft is local to the project, and approval refuses a target that has appeared since the draft was created.
