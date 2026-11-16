# Statusline

Platforms: **Pi**. Install with `harness install statusline --platform pi`; see [installation and scope](../../getting-started.md).

`statusline` replaces Pi's footer with one line when space allows:

```text
harness (main)  openai gpt-6.1-sol medium  125k/200k/256k
```

The project is the current directory's name; the branch comes from Pi's Git watcher.
The provider, model ID, thinking level, and context token counts update with Pi's UI.
`125k/200k/256k` means 125,000 tokens are used, auto-compaction's threshold is
200,000 tokens, and the total context window is 256,000 tokens. Counts of 1,000,000 or more
use an `M` suffix rounded to two decimal places, with trailing zeros omitted (for example, `1.25M`).
Counts from 1,000 to below 1,000,000 are rounded to the nearest thousand with a `k` suffix;
smaller counts are shown directly.
The threshold is calculated from Pi's effective reserved-token setting and the
current context window, including per-model overrides.
Pi can also compact on overflow, so this is the normal trigger threshold, not a guarantee.
Disabled auto-compaction displays `off` instead of the threshold; unavailable values use `?`.

`main` is red; other branches use Pi's theme accent. The model uses Pi's theme heading
color (the secondary gold highlight in the dark theme). Project, provider, and thinking
level remain uncolored. Within the context counters, only the used-token value is colored;
the separators, compaction threshold, and total remain uncolored. Usage progresses from green
(below 50% of the compaction threshold), to blue (50–75%), yellow (75–90%), and red
(90% and above). With auto-compaction disabled or its threshold unknown, colors use
the full context window instead. Unknown usage remains uncolored.
Outside Git, the branch parentheses are omitted. When the footer no longer fits on one
line, provider, model, and thinking level move together onto a second line while the
project/branch stays on the first. Context counters go on whichever row has more space
available (the first row on a tie). The project/branch is independently truncated to the
available width using `…`, so a long branch never forces otherwise fitting details off the second row. If the details still cannot fit
across two lines, fields are removed in this order: provider, thinking level, model, context.
Context placement is recalculated after each removal.
No costs, paths, or extension status rows are added.

```powershell
uv run harness install statusline --platform pi --scope user
```

Restart Pi or run `/reload`. Use `--scope project` for a project-only installation.
This is a Pi-only presentation extension; it does not change model settings or request
inference. Install only one custom-footer extension at a time, since Pi has one footer
slot. Verified against Pi 1.2.0 and 1.4.0's extension loader and footer component API.
The [upgrade checks](https://github.com/EmilienxD/harness/blob/main/tests/e2e/README.md#pi-140-upgrade-checks)
cover live context thresholds, model/thinking changes, wrapping and reload without inference.
