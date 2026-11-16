# Commit

Platforms: **Claude Code, ChatGPT, Pi**.

Install with `harness install commit`. See [installation and scope](../../getting-started.md).

## When to use

Use `commit` after reviewing completed work from the current session. A dry run lets you inspect the file set before creating a Git commit.

## Invocation

Use `/commit <message>`, `/commit --dry`, or `/commit --ai [guidance]`. Hooks on Claude Code/ChatGPT and a native Pi command handle the request before an agent model call.

## What happens

The command verifies files written during the session, stages eligible changes, and commits them. Missing or uncertain ownership stops the command. It never falls back to `git add -A`. `--dry` previews the operation. `--ai` makes a direct Gemini request to generate the message using the diff and bounded session context. The other forms work locally without an API key.

There is no confirmation dialog: use `--dry` before committing if you want a preview. Pi displays the report as a notification (or a displayed custom message without a UI). Claude Code and ChatGPT display it through hook feedback: even a successful commit stops the submitted prompt from reaching the agent. A hook's blocking report does not imply Git failed.

Ownership applies to whole files. Editing a file that already contains someone else's uncommitted changes requires manual review and commit. Later changes to an owned file, unexpected HEAD changes, conflicting staged changes, and merges also stop automatic commit. Unrelated staged files are preserved.

Failed AI generation leaves the command's own staged entries available for an explicit-message retry, provided those entries remain unchanged.

## Files and prerequisites

`git` is required. For `--ai`, set `GEMINI_API_KEY` or `GOOGLE_API_KEY`, or store `{"version": 1, "commit": {"geminiApiKey": "your-key"}}` in gitignored `.harness/config.local.json`. The same section in user `~/.harness/config.json` (or `$HARNESS_STATE_DIR/config.json`) applies across repositories. Keep the key out of committed `.harness/config.json`.

If the command reaches the agent as skill text, check that its hook or extension is loaded and trusted.

## Example

Run `/commit --dry` to inspect the proposed commit, then `/commit Fix empty-cart validation`.
