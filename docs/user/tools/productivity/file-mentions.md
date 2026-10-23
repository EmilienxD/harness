# File mentions

Platforms: **Pi**. Install with `harness install file-mentions --platform pi`; see [installation and scope](../../getting-started.md).

`file-mentions` gives Pi Claude-style automatic file context. After installing, restart Pi or run
`/reload`, then write prompts such as:

```text
Explain @src/main.ts using @"docs/design notes.md" and show how it fits into @src/components/.
```

```powershell
uv run harness install file-mentions --platform pi --scope user
```

The extension keeps your original text and images, appending an HTML-style `<file-mentions>`
container with `<file path="…">` and `<directory path="…">` blocks in model context. Absolute paths
identify each resource; HTML escaping keeps file contents and unusual filenames inside their
containers. In Pi's interactive transcript, the user message block shows only your original text.
A separate grey info notification below it lists relative-path statuses such as `src/main.ts loaded.`
Unavailable references show `path not loaded.` and bounded folder listings identify truncation.
Content hiding also applies to older snapshots after reload/resume; info notifications are emitted
only for live messages, not when rendering history. Full contents remain in the stored message and provider
context (and thus raw JSON/session exports); this is display filtering, not secret redaction.
Relative paths resolve from Pi's working directory; absolute paths, `~/…`, Windows paths and quoted paths with
spaces are supported. Repeated references to the same resolved path load once per message;
later messages read fresh content. Fenced/inline code examples and expanded skill/context blocks
are ignored, and loaded contents are never recursively scanned for more mentions.

Limits are 20 distinct reference spellings per message, 256 KiB per UTF-8 text file and 1 MiB of
raw content across files/listings. Oversized, binary, missing, unreadable or non-UTF-8 files produce
an explicit `<unavailable>` block rather than partial file contents. Other references still load.
References beyond the count limit are reported in an `<omitted>` block. Images/PDFs are not
attached through this extension; use Pi's image attachment support or a suitable file tool.

Folders include immediate names only, including dotfiles, with `/` for directories and `@` for
symlinks. Names are JSON-quoted to keep control characters on one line. Each listing samples at
most 100 entries, sorts that sample, and caps output at 16 KiB; `truncated="true"` signals omitted
entries. It neither recurses nor loads file contents from a folder mention.

This mirrors Claude's file/listing convenience, not all of its policies: there is no Claude token
counter, MCP-resource expansion or automatic ancestor `CLAUDE.md` loading. See
[Claude's documented behavior](https://code.claude.com/docs/en/common-workflows#reference-files-and-directories).
Pi's own instruction discovery is unchanged. Reading happens inside the extension, not through
a model tool call: tool-call guards/reminders do not observe these reads, and mentions do not
satisfy `on-edit-block`'s read-evidence requirements. Explicit mentions can read outside the project
and follow symlinks; only reference files you intend to send to the model.

## Pi implementation and verification

`file-mentions` ships a Pi-only input extension in 1.2.0. User `@path` references append escaped file/directory containers with absolute paths,
per-message canonical-path deduplication, fresh UTF-8 file bytes, bounded shallow directory
samples and explicit unavailable/omitted metadata. A native user-Markdown transformer hides the
snapshot in the interactive transcript, leaving the original user block unchanged. Live user
`message_end` events emit relative-path loaded/skipped/truncated statuses through Pi's native
grey info notifications after the user block. Rendering and history replay never emit notifications.
Model context and stored snapshots retain the content; old 1.0 snapshots also receive content
hiding on replay. Real installed user-message component checks cover hidden contents, unchanged
user blocks, relative labels, special characters and reload. RPC checks verify native info
notification payloads and their ordering after user-message start. Code examples
and expanded skill/context blocks are excluded; input text/images are preserved. Limits are
20 reference spellings, 256 KiB per file, 1 MiB aggregate raw content and 100 entries/16 KiB per
listing. These extension-owned reads are not tool-outcome evidence for path guards. Real Pi
1.2.0 project/user JSON and RPC journeys verify resource bytes/paths, fresh content, directory
bounds, skips, native receipt writes, exact inference counts and receipt-driven removal.
See `tests/e2e/tools/pi-file-mentions/`.
