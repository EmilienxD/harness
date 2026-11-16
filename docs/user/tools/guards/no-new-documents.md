# No New Documents

Platforms: **Claude Code, ChatGPT, Pi**.

Route new documents through a draft review before adding them to your project.

## When to use it

Use it when agents should ask before expanding your documentation.

## Install

```bash
harness install no-new-documents
```

Add `--platform pi` for Pi or choose another provider with the options in [Get started](../../getting-started.md). Restart your agent or run `/reload` in Pi. Approve Pi project resources when prompted.

## Use it

Choose protected documentation paths in the installed policy. The starter protects the root documentation directory. Use recursive patterns if you want deeper directories covered too. Existing documents remain editable. New protected documents are saved as drafts. Review a draft and ask the agent to revise it if needed. Use `/approve-doc-draft <path>` or `/reject-doc-draft <path>` in Claude Code or Pi.

ChatGPT uses `$approve-doc-draft <path>` or `$reject-doc-draft <path>`. Omit the path to list pending drafts. Quote paths containing spaces. Approval refuses to overwrite an existing target. Rejection deletes the draft. Exclusions override protection, including protection from another scope. Invalid policies can leave paths unprotected. Review policy changes carefully.

## Limits

This is a guardrail for supported agent tool calls, not a security sandbox. Start the session in the project whose policies you want to use.

See [Configuration](../../configuration.md#guard-policies) for scope and customization.
