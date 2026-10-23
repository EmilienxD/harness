# Environment context

Platforms: **Pi**. Install with `harness install environment-context --platform pi`; see [installation and scope](../../getting-started.md).

`environment-context` is a Pi-only extension that adds runtime metadata to model context:

- `<environment>` contains OS name/version/architecture, the original session-start timestamp,
  and the local timezone. The timestamp is explicitly labeled as a session-start snapshot,
  not the current time; resume and reload retain the original timestamp.
- `<git_snapshot>` refreshes before each agent run. It includes full counts of changed,
  modified, tracked-added, deleted, renamed, copied, untracked/new, and conflicted files,
  plus staged/unstaged counts. Categories can overlap; conflicted files are counted separately.
  Individual untracked files are counted, including inside new directories.
- The displayed Git file list is limited to 12 files and 1,200 characters, with a truncation
  marker. Counts still cover the full status. Git inspection has a two-second deadline per
  command; failures report unavailable status and unknown counts rather than partial totals.
- Outside a Git working tree it reports “No Git exists in the cwd.” A GitHub remote is not
  required. Pi's existing cwd section is left unchanged.

```powershell
uv run harness install environment-context --platform pi --scope user
```

Restart Pi or run `/reload`. Use `--scope project` for a project-only installation.
The extension uses local OS/session metadata and read-only Git commands; it makes no model
requests of its own. Git state is a snapshot and should be rechecked before destructive actions.
