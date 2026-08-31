---
name: draft-audit-issues
description: Turn an existing codebase audit into one evidence-preserving GitHub issue draft per finding, ready for review and publication through the issues gateway.
disable-model-invocation: true
---

Turn the findings from an existing audit into GitHub issue drafts. Preserve a strict one-finding-to-one-issue mapping and the audit's evidence-oriented format.

This skill is part of an issue publishing system that uses a gateway for publishing issues. Your job stops at issue drafting, as markdown files. The gateway handles publishing automatically — you are not allowed to call `gh issue create`.

## 1. Gather the audit

Use the audit already present in the conversation. If the user passes a file, issue, or URL containing an audit, read its full contents. If there is no identifiable audit with numbered findings, ask the user to provide or run one; do not invent findings or perform a new audit.

Include every numbered finding unless the user explicitly selects a subset. Do not merge, split, deduplicate, reprioritize, re-audit, or turn findings into implementation plans. Exclude positive observations, recommended-order entries, and general limitations that are not findings.

For every finding, preserve:

- title;
- location;
- impact;
- evidence;
- severity;
- confidence;
- remediation difficulty;
- recommendation;
- any finding-specific uncertainty or limitation.

You may make small formatting edits, but do not strengthen claims, remove qualifications, or add implementation details not supported by the audit.

## 2. Decide issue metadata

Findings are independent by default. Add a parent or blocking relationship only when the user requests it or the audit explicitly establishes it.

Choose workflow labels separately from the audit metadata:

- **Difficulty** (default, but optional) estimates the reasoning needed to remediate the finding. Normally map audit remediation difficulty `Low` to `difficulty:basic`, `Medium` to `difficulty:advanced`, and `High` to `difficulty:expert`. Use `difficulty:routine` only for explicitly trivial mechanical work.
- **Mode** (default, but optional) is `hitl` for sensitive work, Critical or High findings, low-confidence findings that need human validation, and complex or risky changes; otherwise use `afk`.
- **Browser**: add `chrome` only when remediation needs a real browser for end-to-end validation.
- **Extra labels**: add only labels the user asks for. Verify them with `gh label list` and use the repository's exact spelling; do not invent extra labels.

Difficulty and mode are defaults, not requirements. Omit either when the user asks. Keep severity, confidence, and remediation difficulty in the body even when a workflow label conveys related information. The publisher requires at least one label; if the user omits both workflow labels, require a verified repository label instead.

## 3. Review the one-to-one mapping

Before writing files, present a numbered list with one proposed issue for every included finding. Show the original finding number, title, severity, confidence, remediation difficulty, parent or blockers if any, and proposed labels.

State the issue count and confirm that it equals the included finding count. Ask the user to approve the mapping or correct titles, relationships, and labels. Do not invite merging or splitting. Stop and wait for approval; after approval, continue directly with drafting without requiring another invocation.

## 4. Write one file per finding

Create `.issues-gateway/${CLAUDE_SESSION_ID}/issue-{i}.md`, starting at:
!`d="./.issues-gateway/${CLAUDE_SESSION_ID}"; mkdir -p "$d"; [ -e ./.issues-gateway/.gitignore ] || printf '*\n' > ./.issues-gateway/.gitignore; max=-1; for f in "$d"/issue-*.md; do [ -f "$f" ] || continue; i="${f##*/issue-}"; i="${i%%[^0-9]*}"; [ -n "$i" ] && [ "$i" -gt "$max" ] && max="$i"; done; echo $((max + 1))`

Number consecutive files in audit finding order unless real dependencies require blockers first. Write all files using multiple Write tool calls in parallel. Do not inspect the gateway directory; the command above prepared it and selected the first free index.

Use this template, omitting optional sections that do not apply:

<issue-template>
# {Finding title}

> {labels}

## Parent

One bare issue reference. Omit when there is no parent.

## Location

The audit's exact path-and-line evidence.

## Impact

The audit's impact statement.

## Evidence

The audit's evidence, including qualifications and finding-specific uncertainty.

## Recommendation

The audit's recommendation.

## Audit metadata

- Severity: {Critical | High | Medium | Low | Informational}
- Confidence: {High | Medium | Low}
- Remediation difficulty: {Low | Medium | High}

## Blocked by

Only dependencies explicitly established by the user or audit. Omit otherwise.

</issue-template>

The first non-empty line after the title must be `> ` followed by the comma-separated labels. At least one label is required by the publisher. Workflow label tokens are `difficulty:{routine|basic|advanced|expert}`, `mode:{afk|hitl}`, and `chrome`; the publisher creates their canonical `[AI]-` labels when needed.

For relationships between drafts from this turn, use the plain `${CLAUDE_SESSION_ID}/{i}` reference. Use an existing issue's real `#number` or URL for external relationships. Do not wrap references in backticks or braces; the publisher rewrites draft references to real issue numbers.

## 5. Hand off

List the relative draft paths and confirm the number of files equals the number of included audit findings. Tell the user the drafts are reviewable and editable. Mention `/publish-issues --dry` for a non-mutating preview and `/publish-issues` to publish.
