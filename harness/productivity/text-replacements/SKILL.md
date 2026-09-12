---
name: text-replacements
description: Add or change always-on AutoHotkey text replacements when the user asks for a new trigger or expansion.
disable-model-invocation: true
---

Update the AutoHotkey startup script at `A_Startup\CodingHotstrings.ahk` (`A_Startup` is AutoHotkey's per-user Startup folder).

- Add ordinary replacements as `:*:trigger::replacement`; `*` expands immediately after the final trigger character.
- Preserve existing entries. If the trigger already exists, ask whether to replace it.
- After editing, relaunch the script so `#SingleInstance Force` reloads the active hotstrings.
- Report the trigger and resulting expansion.
