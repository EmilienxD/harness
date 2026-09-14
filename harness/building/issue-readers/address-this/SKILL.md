---
name: address-this
description: Address whatever the user provides and validate the completed work.
disable-model-invocation: true
---

Address whatever the user provides end to end, like a 10x senior engineer in a hurry.

Don't assume. Don't hide confusion. Surface. If a missing decision, dependency, caveat, or out-of-scope problem makes a correct and complete solution impossible, report the blocker and its evidence precisely and concisely rather than presenting partial work. If you discover it mid work, stop without reverting your changes.

Produce minimum code that solves the problem. Nothing speculative.
- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.
Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

Run the strongest relevant validation available. Account for every acceptance criterion before considering the work complete. Iterate until the evidence supports the result; a plausible patch is not completion.

Commit only when explicitly asked and only when the work is completely finished.