# prefer-edit-tool

A `PostToolUse` / `PostToolUseFailure` hook that notices when Claude *writes* a
file from a shell command — a heredoc redirect, `sed -i`, an inline
`python - <<'PY'` calling `open(path, "w")`, a PowerShell `Set-Content` — and
reminds it, once per offending command, to use the built-in **Write** and
**Edit** tools instead.

The read-side counterpart is [`prefer-read-tool`](../prefer-read-tool/README.md);
the two are independent and install cleanly side by side.

## Problem

Left to itself, Claude reaches for the shell to change files: `cat > f <<'EOF'`,
`sed -i 's/a/b/' f`, or a Python snippet with `open()` and `.write()`. Writing
this way is worse than reading that way, for three reasons:

- **The change is invisible in the TUI.** Claude Code renders Write and Edit as
  a reviewable diff. A heredoc renders as a wall of shell, and nothing shows
  what actually landed on disk.
- **Failures are silent.** `Edit` errors out when its target string is missing
  or matches twice. A heredoc with an unescaped `$`, a backtick, or CRLF
  line endings writes the wrong bytes and exits 0 — Claude reads "success" and
  moves on.
- **Read tracking is bypassed.** Tools like `on-edit-block` and the built-in
  read-before-write rule key off the real edit tools.

## Solution

Register the same script on `PostToolUse` and `PostToolUseFailure` with a
`Bash|PowerShell` matcher (matching `Bash` alone misses Windows setups where
the PowerShell tool is the primary shell). After every shell call, the hook
scans the command for write signals and, on a match, returns
`additionalContext` naming the signals it saw and explaining why Write/Edit is
preferable. Claude Code attaches that next to the tool result.

Detected signals:

| Signal | Examples |
|---|---|
| Output redirect | `> file`, `>> file`, `cat <<'EOF' > file` |
| `tee` | `cat <<'EOF' \| sudo tee file` |
| In-place stream edits | `sed -i`, `sed -i.bak`, `perl -pi -e`, `awk -i inplace` |
| Inline Python writing a file | `open(p, "w")` — and `"a"`, `"x"`, `"r+"`, `"wb"`, any non-read mode — `.write()`, `.write_text()`, `json.dump()`, `fileinput ... inplace`, `os.replace()`, `shutil.copy()` |
| Inline Node writing a file | `fs.writeFileSync()`, `fs.promises.appendFile()`, `fs.createWriteStream()`, `fs.openSync(p, "w")`, a bare `writeFile()` from a destructured import, `Bun.write()`, `Deno.writeTextFile()` |
| PowerShell file writes | `Set-Content`, `Add-Content`, `Out-File`, `Export-Csv`, `New-Item -Value`, `[IO.File]::WriteAllText` |
| Patch application | `patch`, `git apply` |
| Byte-level writes | `dd of=`, `truncate` |

The Python rule is the one that matters most in practice and is the one most
easily missed, so it fires on a write-shaped call anywhere in the command — in
a heredoc, behind `python3 -c`, under `uv run` — as long as something
python-shaped is being invoked. The Node rule works the same way, gated on
`node`/`bun`/`deno`/`npx`/`tsx`, so a `grep` for the literal text
`writeFileSync` isn't mistaken for a write.

The hook **never blocks anything**. Both events fire after the command has
already run, so there is nothing to undo — it can only add context.
`PostToolUseFailure` is registered alongside `PostToolUse` on purpose: a shell
write that *failed* is exactly the case worth flagging, and `PostToolUse` fires
only on success.

Detection is deliberately generous, and false positives are the intended
trade-off — a missed shell write costs a bad edit nobody reviewed, a false
positive costs one ignored sentence. Redirects that don't write a file are
still filtered out: `2>/dev/null` and other fd-prefixed redirects, `&>`,
`> $null`, `> NUL`, and the `->`, `=>`, `>=`, `>>`, `<div>`, `Vec<T>` sequences
that appear inside heredoc'd source code — a redirect only counts when the
operator starts a word, as shell redirects do. Legitimate shell writes — a build command redirected to
its output file, `git apply` on a real patch — do trigger the reminder, which
is why the text says shelling out is worth it when Write/Edit don't fit rather
than *never do this*.

## Components

| File | Purpose |
|---|---|
| `.claude/settings.json` | Registers the hook on `PostToolUse` and `PostToolUseFailure` with a `Bash\|PowerShell` matcher |
| `.claude/hooks/prefer_edit_tool_PostToolUse_hook.py` | Scans the executed command and emits the reminder |

## Installation

```bash
uvx --from git+https://github.com/EmilienxD/harness@v0.2.0 harness
```

That copies the hook into `.claude/hooks/`, marks it executable, and merges the
registration below into `.claude/settings.json` without disturbing any hooks you
already had. Add `--dry` first to see the exact file list and settings diff. See
the [repo README](../../README.md) for `--user`, `--local`, and `uninstall`.

<details>
<summary>Installing by hand</summary>

1. Copy `claude/prefer_edit_tool_PostToolUse_hook.py` into `.claude/hooks/` in your repo.
2. Make it executable: `chmod +x .claude/hooks/prefer_edit_tool_PostToolUse_hook.py`
3. Add (or merge) the following into your repo's `.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Bash|PowerShell",
        "hooks": [
          {
            "type": "command",
            "command": "python3",
            "args": ["${CLAUDE_PROJECT_DIR}/.claude/hooks/prefer_edit_tool_PostToolUse_hook.py"]
          }
        ]
      }
    ],
    "PostToolUseFailure": [
      {
        "matcher": "Bash|PowerShell",
        "hooks": [
          {
            "type": "command",
            "command": "python3",
            "args": ["${CLAUDE_PROJECT_DIR}/.claude/hooks/prefer_edit_tool_PostToolUse_hook.py"]
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

</details>

Restart or reload Claude Code so it picks up the new hook config, then test it:
ask the agent to `printf 'hi\n' > /tmp/probe.txt`. The tool result should come
back with the reminder attached as context.

Requires a working Python 3 where the installer runs — its absolute path is
baked into the hook config, so the interpreter does not need to stay on PATH
afterwards.
