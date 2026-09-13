---
name: handoff-grilling
description: Create a detailed handoff of a grill-me conversation that preserves the user's initial request verbatim, every decision and its rationale, and the explored codebase evidence. Explicit invocation only.
disable-model-invocation: true
---

Write a detailed handoff document so a fresh agent can continue a conversation conducted with `grill-me`. Save it to the temporary directory of the user's OS, not the current workspace.

The handoff must be self-contained and preserve the reasoning trail of the grilling session. Include:

- The user's initial request exactly as written, verbatim and clearly delimited. Do not correct, shorten, paraphrase, or normalize it.
- Every decision reached, including the chosen option, why it was chosen, relevant tradeoffs, rejected alternatives and why they were rejected, and whether the choice came from the user or from an accepted recommendation.
- Every unresolved question, assumption, disagreement, and branch of the design tree that remains open.
- The facts established during the session and the evidence supporting them.
- Every relevant directory, file, symbol, command, URL, issue, specification, plan, ADR, commit, or diff that was traversed or examined. Cite precise paths and explain what each contributed to the discussion. Include line numbers when they are known and useful; do not invent them.
- The current shared understanding, scope boundaries, constraints, implementation implications, and the exact next steps for the receiving agent.

Keep decision chronology when it explains why later choices changed or superseded earlier ones. Distinguish confirmed facts, user decisions, accepted agent recommendations, and still-unverified inferences. Prefer completeness and specificity over compactness.

Reference existing artifacts by path or URL instead of reproducing their full contents, except for the user's initial request, which must always appear verbatim. Redact secrets and credentials from all other sections. If the initial request itself contains a secret or credential, replace only that value with a clear redaction marker and explicitly note that this is the sole reason the quotation is not byte-for-byte identical.

If the user provides details alongside the invocation, treat them as the intended focus of the next session and emphasize the relevant decisions and evidence without omitting the rest of the grilling record.
