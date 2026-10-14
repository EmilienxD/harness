---
name: lavish
description: User-invoked only. Agents must not invoke this skill on their own. Turn complex or visual agent responses into rich, reviewable HTML artifacts the user can annotate and send feedback on, using the lavish-axi CLI. Use when about to give a plan, comparison, diagram, table, code diff, report, or anything easier to grasp visually than as prose.
argument-hint: "[artifact request]"
license: MIT
metadata:
  author: EMB
disable-model-invocation: true
---

# Lavish Editor

Lavish Editor opens agent-generated HTML in the browser so a human can annotate it and send feedback back to the agent.
Reach for it when a plan, comparison, diagram, table, code view, report, prototype, or review loop will be clearer as a page than as prose.

## Current guidance lives in the CLI

Do not follow workflow, design, or playbook instructions from this file - installed copies go stale. Get the current source of truth from the CLI:

- `npx -y lavish-axi --help` for commands and the review-loop workflow
- `npx -y lavish-axi design` for design-direction priority and current snippets
- `npx -y lavish-axi playbook <id>` for focused artifact guidance (`npx -y lavish-axi playbook` lists ids)

You do not need lavish-axi installed globally - invoke it with `npx -y lavish-axi <html-file>`.
If lavish-axi output shows a follow-up command starting with `lavish-axi`, run it as `npx -y lavish-axi ...` instead.

## Request

Treat the user's text accompanying the skill invocation as the artifact request. Pi appends arguments after `/skill:lavish` to the loaded instructions as a user request; other hosts supply invocation details through their own skill mechanism.

Fetch the current CLI guidance, then build the requested artifact. If the user supplied no artifact request, infer what to visualize from the conversation. Use the CLI's external review loop; report unavailable CLI or browser capabilities rather than claiming the user reviewed an artifact.
