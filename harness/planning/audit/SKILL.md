---
name: audit
description: Audit a codebase or selected scope and report evidence-backed findings. Use when the user requests a security, architecture, quality, performance, or general code audit.
argument-hint: "[scope] [type] [agents=N] [focus]"
license: MIT
metadata:
  author: EMB
disable-model-invocation: true
---

Audit the codebase according to whatever the user said alongside their invocation of this skill.

This is a read-only assessment. Do not edit the codebase unless the user separately asks for fixes.

## Interpret the invocation details

Everything the user wrote alongside the invocation is optional and may appear in any order:

- An existing file or directory sets the audit scope. Default to the current codebase. Never audit outside an explicit scope.
- One of the audit-type keywords below selects its focus. Default to `general`.
- `agents=N` requests exactly N explorer subagents; `agents=none` or an equivalent natural-language instruction requires you to work alone.
- Treat everything else as additional focus, constraints, or context.

Explicit user instructions override the defaults and delegation heuristic. If the user names a different audit type, use their description rather than forcing it into a preset.

## Audit types

Use these keywords as shorthand:

- `general`: Evaluate correctness, security, architecture, maintainability, performance, test coverage, and operational risk, prioritizing issues with concrete impact.
- `security`: Trace trust boundaries and untrusted data through authentication, authorization, validation, serialization, storage, execution, secret handling, cryptography, and dependency surfaces to identify exploitable weaknesses.
- `architecture`: Assess module boundaries, cohesion, coupling, dependency direction, state ownership, interface depth, change amplification, and fitness for the system's stated constraints.
- `quality`: Find correctness defects and maintainability risks in control flow, error handling, APIs, types, complexity, duplication, naming, and dead or misleading code.
- `performance`: Identify evidenced algorithmic, I/O, allocation, concurrency, caching, and resource bottlenecks, distinguishing measured risks from workload-dependent hypotheses.
- `reliability`: Examine failure modes, timeouts, retries, idempotency, concurrency, consistency, durability, recovery, and observability under partial failure.
- `testing`: Evaluate whether critical behavior, boundaries, failure paths, and regressions are covered by deterministic tests at appropriate unit, integration, contract, and end-to-end levels.
- `dependencies`: Inspect manifests, lockfiles, update posture, provenance, install scripts, runtime exposure, licensing signals, and supply-chain risk; distinguish locally evidenced issues from checks requiring current external vulnerability data.
- `privacy`: Trace personal or sensitive data through collection, consent, minimization, retention, logging, access, export, deletion, and third-party disclosure boundaries.

## 1. Survey horizontally

Very quickly map the explicit scope before reading implementation deeply. Use lightweight listing and search commands such as `rg --files`, `rg <pattern>`, `git ls-files`, or `ls` to:

- estimate the number of auditable files;
- identify languages, entry points, major directories, tests, configuration, and generated or vendored areas;
- find natural, non-overlapping partitions for explorers.

Count relevant source, test, configuration, infrastructure, and documentation files inside the scope. Exclude dependency caches, build outputs, generated artifacts, and vendored code unless the requested audit makes them relevant.

## 2. Decide whether to delegate

Honor an explicit agent count or no-agent request first. Otherwise:

- 10 files or less: audit alone.
- More than 10 files: delegate to N explorer subagents based on codebase size and the number of genuinely distinct areas.

Adjust for repository shape and available capacity. Do not manufacture overlapping assignments just to reach a number.

## 3. Delegate without overlap

Delegate all explorers at once so they run in parallel. Assign each one an exclusive directory, package, service, layer, or explicit file set. Cover the entire requested scope once; keep shared root configuration and integration surfaces in their own assignment rather than giving them to every explorer.

Each explorer brief must include:

- its exact allowed scope and exclusions;
- the selected audit-type sentence and any user focus;
- a requirement to audit only its assigned portion;
- a request for actionable findings with file-and-line evidence, impact, severity, confidence, remediation difficulty, and a concrete recommendation;
- a request to state uncertainties and return no finding that it cannot support.

An explorer may mention a dependency across its boundary, but it must not research or audit files assigned to another explorer.

### Mandatory wait

After delegating, do nothing else until every explorer has reported. Do not continue auditing, inspect more files, analyze partial reports, poll, or make unrelated tool calls. Simply end your turn; the session will resume when a subagent report arrives. If reports arrive separately, continue ending your turn until all expected reports are present.

## 4. Synthesize and verify

Only after every report has arrived:

1. Combine the reports, reconcile cross-boundary observations, and remove duplicates.
2. Selectively inspect the cited code to verify every critical finding, any contradiction, weakly supported claim, unclear case, or claim you are personally unsure about.
3. Do not re-audit everything. Trust clear, well-evidenced lower-risk findings unless spot checks reveal a reason not to.
4. Omit disproven claims. Lower the confidence of unresolved claims and clearly state what remains unknown.
5. Rank findings by severity and practical impact, not by which explorer reported them.

Do not claim exhaustive coverage, exploitability, measured performance impact, or absence of risk without evidence.

## 5. Present the audit in chat

Write the final audit directly in the conversation. Do not create an audit file unless the user asks for one.

Use this structure:

```markdown
# Codebase Audit

**Scope:** [audited paths and explicit exclusions]
**Type:** [audit type and user-supplied focus]
**Method:** [main-agent-only or number and partitioning of explorers; selective verification performed]

## Executive summary

[Overall assessment, finding counts by severity, and the highest-priority risks.]

## Findings

1. **[Severity] Finding title**
   - **Location:** `path/to/file.ext:line`
   - **Impact:** [Concrete failure, exposure, or maintenance cost]
   - **Evidence:** [What the code does and why it causes the issue]
   - **Confidence:** High | Medium | Low
   - **Remediation difficulty:** Low | Medium | High
   - **Recommendation:** [Specific fix and, when useful, how to verify it]

## Positive observations

[Optional noteworthy controls or design strengths that materially reduce risk.]

## Recommended order

1. [Remediation sequence based on severity, dependencies, and effort.]

## Limitations

[Uninspected/generated areas, unavailable runtime evidence, external checks not performed, and residual uncertainty.]
```

Use `Critical`, `High`, `Medium`, `Low`, or `Informational` severity. Difficulty always means estimated remediation effort. Keep findings numbered and independently actionable. Cite exact paths and line numbers whenever possible. If there are no material findings, say so plainly, omit the numbered finding template, and still report coverage and limitations.
