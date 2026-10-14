---
name: setup-text-replacements
description: User-invoked only. Agents must not invoke this skill on their own. Add or change always-on AutoHotkey text replacements when the user asks for a new trigger or expansion.
argument-hint: "[trigger and expansion]"
license: MIT
metadata:
  author: EMB
disable-model-invocation: true
---

Update the AutoHotkey startup script at `A_Startup\CodingHotstrings.ahk` (`A_Startup` is AutoHotkey's per-user Startup folder).

This workflow requires Windows and AutoHotkey. Verify both are available before editing; on another platform or without AutoHotkey, report the missing requirement. Pi supplies no desktop automation automatically: use available shell tools to edit and relaunch the script, and report a reload that could not be completed.

- Add ordinary replacements as `:*:trigger::replacement`; `*` expands immediately after the final trigger character.
- Preserve existing entries. If the trigger already exists, ask whether to replace it.
- After editing, relaunch the script so `#SingleInstance Force` reloads the active hotstrings.
- Report the trigger and resulting expansion.
