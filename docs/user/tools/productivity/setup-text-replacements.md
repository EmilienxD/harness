# Setup text replacements

Platforms: **Claude Code, ChatGPT, Pi**. Install with `harness install setup-text-replacements`; see [installation and scope](../../getting-started.md).

## Use it

On Windows with AutoHotkey installed, invoke `/setup-text-replacements` in Claude Code or `$setup-text-replacements` in ChatGPT with a trigger and replacement, for example `$setup-text-replacements expand ;sig to my signature`.

## What happens

The skill edits `A_Startup\CodingHotstrings.ahk`, the per-user AutoHotkey startup script. An ordinary replacement uses `:*:trigger::replacement`, so expansion happens immediately after the last trigger character. Existing entries are preserved; if a trigger already exists, the agent asks before replacing it. The script is relaunched after editing so the new hotstring becomes active.

## Practical note

Choose a trigger unlikely to appear in ordinary typing; `:*:;sig::My signature` expands as soon as `;sig` is typed. This is a system-wide AutoHotkey replacement, so test it in a text field after the script reloads.

## Pi usage

Use `/skill:setup-text-replacements [replacement request]`. This remains a Windows AutoHotkey workflow. Selecting Pi does not add support for other operating systems.
