# zero-call-commit

A `/commit <message>` command for Claude Code and ChatGPT that stages and
commits your changes without spending a single additional model call.

Optionally, `--ai` will write the message for you from the staged diff. That
one flag does make a network call — but to a small, cheap model directly, not
through the host model, so the full conversation payload is never re-sent. See
[`--ai`](#--ai--generated-commit-messages).

## Problem

Asking the agent to commit at the end of a session is redundant and expensive.
Claude has to look at `git status`, decide which commands to run, execute
them, and report back — typically 2 to 5 extra turns, each one re-sending the
full conversation history as input tokens. On a long session, that "just
commit it" request can be one of the priciest things you ask the agent to do,
for a task that's fundamentally mechanical.

## Solution

Intercept the `/commit` prompt with a `UserPromptSubmit` hook, which fires
**before** the prompt is ever sent to the model. The hook does the git work
itself and rejects the prompt with a status string, which the host shows
directly to the user in place of a model response.

Net result: typing `/commit fix the login bug` runs `git add`, `git commit`,
and returns a confirmation — with zero new API calls, because the model
never sees the prompt at all.

This only works because `UserPromptSubmit` runs pre-model. A `PreToolUse`
hook (an earlier design considered for this tool) fires only after the model
has already emitted a tool call, so it can't avoid that first API round trip.

## Components

| Host | Components |
|---|---|
| Claude Code | `.claude/settings.json` plus `.claude/hooks/commit_UserPromptSubmit_hook.py` |
| ChatGPT | `.codex/hooks.json`, `.codex/hooks/commit_ChatGPT_hook.py`, and its shared commit core |

The hook matches the raw prompt text (`^/commit ...`), so `/commit` does not
need to be a registered built-in command. The installed skill is an
explicit-only fallback that reports a hook installation or trust problem if
the prompt ever reaches the model.

## Usage

```
/commit <message>              stage this session's changes and commit
/commit --dry <message>    show exactly what would happen, change nothing
/commit --ai                   generate the message from the staged diff
/commit --ai <guidance>        generate, but steer the emphasis
/commit --dry --ai         preview the generated message without committing
```

Flags must come before the message, so `/commit mention --ai in the docs`
commits with that literal message rather than parsing `--ai` as a flag.

### What gets committed

Only the files the agent actually wrote this session, not every dirty file in
the repo. On Claude Code, the hook reads the session's JSONL transcript,
collects the `Edit`/`Write`/`NotebookEdit` tool calls, and stages exactly those
paths.
Writes that failed, writes outside the repo (`~/.claude/settings.json`),
gitignored paths (an agent-scratch dir like `.issues-gateway/`, build output,
...), and files created then deleted are all dropped — `--dry` lists each
discard so a "missing" file is never a mystery. A tracked file inside an
ignored directory still stages, exactly as git itself treats it.

Files Claude wrote **through the shell** count too. Claude does not only use
the edit tools: a `cat > f <<'EOF'` heredoc, `sed -i`, an inline
`python - <<'PY'` calling `open(p, "w")`, `node -e` with `writeFileSync`, a
PowerShell `Set-Content`, or a plain `mv`/`rm`/`touch` all change files that
belong in the commit. `Bash` and `PowerShell` calls in the transcript are
parsed for their targets, so a session that mixed both kinds of write stages
both. (The [`prefer-edit-tool`](../prefer-edit-tool/README.md) hook nudges
Claude towards Write/Edit in the first place; `/commit` doesn't assume it is
installed.)

Some shell writes name no target that can be read from the command —
`git apply`, a path held in a `$VAR`, a glob, or a write after a `cd`. Those
are reported rather than guessed at, and the hook stages the whole tree
instead of committing a subset. `--dry` lists the commands responsible, and a
real run says so in its result line.

The commit is pathspec-scoped, so anything you staged by hand beforehand
stays staged and is left out. If the transcript can't be read at all, the
hook falls back to `git add -A`; `--dry` says so loudly when that happens.

ChatGPT does not expose its transcript as a stable hook interface. Its native
adapter instead snapshots dirty-file fingerprints before each `Bash` or
`apply_patch` call and records the actual delta afterwards under `.git`. This
catches arbitrary generators and shell writes without parsing command syntax,
while preserving edits that were already dirty before the agent touched the
repo. If the pre-tool snapshot is unavailable, it visibly widens to the whole
tree rather than risk a partial commit.

### `--ai` — generated commit messages

`--ai` makes the message optional. It sends one request to a small Gemini
model containing the diff about to be committed, the file list, your recent
commit subjects (so the generated message matches the repo's existing
style), and a narrative of the session reconstructed from the transcript —
which is the only source for *why* the change was made.

This is the one place the tool spends money, and it is not a Claude turn:
it's a direct API call to a cheap model, so the conversation history is
never re-sent. The call happens **after** staging and only if there is
genuinely something to commit.

`--dry --ai` is the useful pairing: it generates and prints the message
without staging or committing anything, so you can copy it, edit it, and
replay it as `/commit <your edited message>` — or just run it again for a
different draft.

Large diffs are trimmed per-file rather than globally truncated, and lock
files and other generated artefacts are listed but their contents omitted,
so one `package-lock.json` can't crowd out the actual feature.

**Setup.** `--ai` needs a Google AI Studio API key (the free tier is far more
than enough for commit messages), but no Python package installation. The hook
makes the Gemini REST request with Python's standard library.

Provide the key one of three ways. Recommended first:

1. **`env` in `.claude/settings.local.json`** — Claude Code's own mechanism for
   handing environment variables to hooks. `settings.local.json` is
   per-machine and never committed (the installer gitignores it for you), so
   this is both persistent and safe:

   ```json
   { "env": { "GEMINI_API_KEY": "your-key-here" } }
   ```

   Restart Claude Code afterwards. This also works in `settings.json` and in
   `~/.claude/settings.json`, but prefer `settings.local.json` — a repo's
   `settings.json` gets committed.

2. **Key file** — a single line in `.claude/commit-ai.key`, either in the repo
   or in `~/.claude/`. Also gitignored by the installer, and needs no restart.

3. **Environment variable** — `GEMINI_API_KEY` or `GOOGLE_API_KEY`. If you
   already use Gemini anywhere else there is nothing to do.

   ```bash
   setx GEMINI_API_KEY "your-key-here"      # Windows, applies to new shells
   export GEMINI_API_KEY="your-key-here"    # add to ~/.bashrc or ~/.zshrc
   ```

The resolution order is the reverse of the above, most-authoritative first:
the live environment, then each `.claude/settings*.json` `env` dict, then each
`.claude/commit-ai.key` — with project scope ahead of user scope throughout.
So an exported variable always wins, and a per-repo key overrides your global
one.

On ChatGPT, use the same environment variables or put the key in
`.codex/commit-ai.key` (project) or `~/.codex/commit-ai.key` (user). ChatGPT's
JSON hook configuration has no Claude-style `env` dictionary, so the native
adapter intentionally does not inspect `hooks.json` for secrets.

Do **not** paste the key into an agent prompt — Claude Code writes prompts to
its transcript, and the ChatGPT adapter records them in its session state.
Since the session narrative sent to Gemini is built from your own prompts, the
hook also runs a redaction pass over it for key-shaped strings before anything
leaves the machine.

Set `COMMIT_AI_MODEL` to override the default `gemini-3.5-flash-lite`.

The free Gemini tier caps **tokens per minute**, not just requests, and that
cap is well below the model's advertised context window — a single oversized
request gets rejected outright. So the hook sizes the prompt against the TPM
number: `MODEL_TPM_LIMITS` in the hook maps each model id to its per-minute
input-token limit (dated and preview suffixes inherit the base model's entry),
and the diff and session-narrative budgets shrink proportionally when that
limit is tighter than they are, with a hard cap on the assembled prompt as a
backstop. Token counts are estimated from character length at a pessimistic
3 chars/token, with 20% of the limit left unspent — no `countTokens` round-trip,
which would cost a request and charge against the very budget it measures.

Set `COMMIT_AI_TPM_LIMIT` to a token count to override the map entirely; paid
tiers have far higher limits and shouldn't require editing the hook. `/commit
--dry --ai` prints the estimated prompt size and the limit it was sized against.

Set `COMMIT_AI_BASE_URL` to override the Gemini API root, which defaults to
`https://generativelanguage.googleapis.com/v1beta`. A trailing slash is
optional. This is useful for a Gemini-compatible proxy or gateway; the hook
appends `/models/<model>:generateContent` to the configured value.

Everything except `--ai` works with no key or network. Neither mode needs
third-party Python packages.

### Debugging

The hook doubles as a standalone CLI, which always runs dry and can be
pointed at any historical transcript without touching a repo:

```bash
python .claude/hooks/commit_UserPromptSubmit_hook.py \
    --transcript ~/.claude/projects/<project>/<session>.jsonl \
    --cwd /path/to/repo --ai
```


## Installation

Claude Code (the backward-compatible default):

```bash
uvx --from git+https://github.com/EmilienxD/harness@v0.2.0 harness
```

ChatGPT:

```bash
uvx --from git+https://github.com/EmilienxD/harness@v0.2.0 harness
```

After installing for ChatGPT, restart it and open `/hooks` to review and trust
the three native hook definitions. Until they are trusted, ChatGPT skips them.

The default command copies the hook and the skill into `.claude/`, marks the
hook executable,
merges the `UserPromptSubmit` registration below into `.claude/settings.json`
without disturbing any hooks you already had, and adds a small fenced block to
the repo's `.gitignore` so the two places `--ai` looks for an API key
(`.claude/commit-ai.key` and `.claude/settings.local.json`) can never be
committed. Add `--dry` first to see the exact file list, settings diff, and
`.gitignore` diff. Uninstalling removes the block again, leaving any rules you
wrote yourself untouched. See the [repo README](../../README.md) for `--user`,
`--local`, and `uninstall`.

<details>
<summary>Installing by hand</summary>

1. Copy `shared/hooks/commit_core.py` and
   `claude/hooks/commit_UserPromptSubmit_hook.py` into `.claude/hooks/` in your repo.
2. Copy `shared/skills/commit/SKILL.md` into `.claude/skills/commit/SKILL.md`.
3. Make both hook files executable.
4. Add (or merge) the following into your repo's `.claude/settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "python3",
            "args": ["${CLAUDE_PROJECT_DIR}/.claude/hooks/commit_UserPromptSubmit_hook.py"]
          }
        ]
      }
    ]
  }
}
```

`command` must resolve on the PATH of the machine running Claude Code
(`python` on Windows, usually `python3` elsewhere). The `harness` installer
sidesteps this: it checks each candidate (`python3`, `python`, `py`) actually
runs and writes its absolute path into `settings.json`, so the hook no longer
depends on PATH at all.

5. If you plan to use `--ai`, add these to your `.gitignore` so a key can't be
   committed:

```gitignore
.claude/commit-ai.key
.claude/settings.local.json
```

</details>

Then restart or reload Claude Code so it picks up the new hook config, and test
it: type `/commit test message` in a session with uncommitted
   changes. You should see a `Committed <sha>: test message` response with
   no model "thinking" delay, and the commit should appear in `git log` with
   a `Claude-session: <id>` trailer.

Requires `git` on the PATH Claude Code sees, and a working Python 3 where the
installer runs — its absolute path is baked into the hook config, so the
interpreter does not need to stay on PATH afterwards.
