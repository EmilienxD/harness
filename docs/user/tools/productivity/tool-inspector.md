# Tool inspector

Platforms: **Pi**. Install with `harness install tool-inspector --platform pi`; see [installation and scope](../../getting-started.md).

`tool-inspector` is a Pi-only extension that adds `[Tools]` directly below `[Context]`
in the startup resources listing. It includes built-in and extension tools and follows
Ctrl+O expansion to show descriptions. Tools available indirectly through active
`tool_search` or codemode are labelled `(differed)`; ordinary inactive tools remain
`(not active)`, and hidden tools are labelled `(hidden)`.

```powershell
uv run harness install tool-inspector --platform pi --scope user
```

Restart Pi or run `/reload`. Use `/tools` to print every configured tool's description,
source, exposure, readable parameter reference, and output contract. Use `/tools read`
(or another tool name, with completion) to inspect one tool. Declared output schemas
are converted into indented field summaries with types, required/optional markers,
descriptions, defaults, constraints, and nested fields; no raw JSON is printed.
Reports use the current Pi theme to color headings, field names, types, and
required/optional markers. Inline backtick text uses the theme's code color.
Tools without an exposed output schema are explicitly labelled
rather than assigned an invented return type. Reports never execute tools, request
inference, or enter the model's context. Reports use display-only session entries;
Pi persists them once the session contains a conversation.

The exact startup placement uses Pi 1.2.0's internal resource-list layout and may need
an update after a Pi upgrade. Quiet startup settings remain respected. The extension
works independently of Calm and does not change tool execution or active-tool settings.
