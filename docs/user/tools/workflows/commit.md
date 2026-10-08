# Commit

## When to use

Use `commit` after reviewing completed work from the current session. A dry run lets you inspect the file set before creating a Git commit.

## Invocation

Use `/commit <message>`, `/commit --dry`, or `/commit --ai [guidance]`. This hook-backed command is intercepted before a model call on both supported providers.

## What happens

The hook identifies files written during the session, stages eligible changes, and commits them. `--dry` previews the operation. `--ai` makes a direct Gemini request to generate the message using the diff and bounded session context; the other forms work locally without an API key.

## Files and prerequisites

`git` is required. For `--ai`, configure `GEMINI_API_KEY`, `GOOGLE_API_KEY`, or a provider-local `commit-ai.key`. Project installs add ignore rules for `commit-ai.key` and `settings.local.json` under the selected provider directory. If the command reaches the agent as a skill, check that its hook is enabled and trusted.

## Example

Run `/commit --dry` to inspect the proposed commit, then `/commit Fix empty-cart validation`.
