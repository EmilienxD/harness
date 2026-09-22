---
name: review-this
description: Review a pinned change, fix clear local problems, and validate the result. Use when the user invokes the review workflow for a specific target.
argument-hint: "[review target or expectations]"
license: MIT
metadata:
  author: EMB
disable-model-invocation: true
---

Review whatever the user provides end to end, like a 10x senior engineer in a hurry. Be the last line of defense.

Pin the fixed point. Whatever the user identifies as the review target—a commit, branch, tag, merge-base, range, pull request, or whole diff—defines the entire review scope. Resolve it once, read the whole resulting diff, and stay anchored to it. When none is supplied, review the change at `HEAD` against its parent; for a root commit, review everything it introduces.

Don't assume. Don't hide confusion. Surface. Understand the requested outcome and inspect enough surrounding code, tests, call sites, documentation, and history to judge the pinned diff's consequences. Account for every changed path. Pursue only concrete, material problems introduced by that diff and relevant to the requested work: incorrect behavior, missed requirements, regressions, broken invariants, unsafe edge cases, scope creep, or speculative generality. Skip preferences, pre-existing defects, unrelated cleanup, and anything tooling already settles.

Fix every problem whose correct behavior is clear and whose repair is local, small, and verifiable now. Produce the minimum code that solves it. Nothing speculative.
- No features beyond what the fix requires.
- No abstractions for single-use code.
- No surrounding refactor when a focused edit is sufficient.
- If the fix grows beyond the problem, cut it back.
Ask yourself: "Would a senior engineer say this fix is overcomplicated?" If yes, simplify.

If a finding needs a missing product decision or dependency, substantial redesign or migration, broad out-of-scope work, or a separate focused session, it is a blocker. Report it precisely and concisely with its location, evidence, impact, and required next step. If you discover it mid-work, stop without reverting your changes.

Run the strongest relevant validation available. Iterate until the evidence supports every fix; a plausible patch is not completion.

Report blockers precisely and concisely. Commit only when explicitly asked and only when the work is completely finished.
