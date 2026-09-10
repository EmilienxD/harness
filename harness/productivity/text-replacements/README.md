# Text Replacements

AutoHotkey-based text replacement manager for Windows (Claude Code and ChatGPT).

## Description

This skill helps users create and manage always-on text replacements using AutoHotkey. Text replacements work system-wide in any application - browser, editor, terminal, etc.

## Platform Support

**Windows only** - requires AutoHotkey and a startup script at:
`C:\Users\<username>\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\CodingHotstrings.ahk`

## Usage

Invoke this skill when the user asks to:
- Add a text replacement or expansion
- Create a hotstring or abbreviation
- Set up auto-complete text

## Examples

```
"Add text replacement btw for by the way"
"Create hotstring teh -> the"
"Make @@ expand to my email"
```

## What it does

- Updates the AutoHotkey startup script
- Preserves existing replacements
- Checks for duplicate triggers
- Reloads the script to apply changes immediately
- Reports the trigger and expansion

## Format

Replacements use AutoHotkey hotstring syntax:
```
:*:trigger::replacement
```

The `*` option expands immediately after typing the trigger (no space/enter needed).
