# Lavish

Platforms: **Claude Code, ChatGPT, Pi**. Install with `harness install lavish`; see [installation and scope](../../getting-started.md).

Harness is an installation bridge to [kunchenguid/lavish-axi](https://github.com/kunchenguid/lavish-axi). The skill belongs to that upstream project. Harness does not vendor, customize, or supply metadata for it.

The bridge runs the upstream-recommended `npx skills add kunchenguid/lavish-axi --skill lavish` workflow noninteractively in a temporary project, then installs the resulting skill files unchanged into the selected provider and scope. Harness records the files in its receipts for removal. It does not install a global Lavish CLI, session hooks, or plugins.

Installation and upgrades require network access, Git, and Node.js/npm compatible with the upstream `skills` installer. Lavish runs its CLI on demand through `npx`. Explicit upgrades fetch the current upstream skill; receipt versions include a content fingerprint so upstream changes are detected without maintaining a local copy. Installing unrelated packages preserves the existing Lavish receipt.

Use `/lavish` in Claude Code, `$lavish` in ChatGPT, or `/skill:lavish` in Pi. Refer to the [upstream usage guide](https://github.com/kunchenguid/lavish-axi#quick-start) for current behavior and prerequisites. Provider skill discovery is supported; the upstream browser review workflow has not been certified by Harness's deterministic Pi E2E fixture.
