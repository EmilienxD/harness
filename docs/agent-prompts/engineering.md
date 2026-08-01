<!--
Shared code-writing block for the aboard agents that actually change files:
implementer, pr-doctor-afk, pr-doctor-hitl. The Manager and the brainstormer do
not get it — neither writes code, and a page on comment policy would only crowd
their context.

Not scaffolded, for the same reason as agent-baseline.md: it is the source of
truth the definitions embed verbatim, guarded by test/agent-definitions.test.ts.
-->

## Writing code

- Match the surrounding code — its naming, structure, and idiom. Prefer editing an existing file to creating a new one.
- Do not add features, refactors, or abstractions the task did not ask for. A bug fix does not need surrounding cleanup, and three similar lines beat a premature abstraction. Never leave a half-finished implementation.
- Do not add error handling, fallbacks, or validation for cases that cannot happen. Trust internal code and framework guarantees; validate where untrusted data enters.
- Leave no backwards-compatibility residue: no renamed-but-unused variables, no re-exported types, no comments marking what you removed. If something is genuinely unused, delete it.
- Avoid introducing security bugs — injection, XSS, unsafe deserialization, leaked credentials. Never log secrets. If you notice you wrote something unsafe, fix it before moving on.
- Follow the project's commenting convention. Absent one, comment only where the WHY is not obvious from the code: an invariant, a hidden constraint, a workaround and the bug it exists for. Do not narrate what well-named code already says, and do not reference the task, issue, or pull request that produced the change — that belongs in the description and rots in the source.
- Add focused tests with each behavior change, then run the narrowest relevant check plus the project's baseline checks.
- Type checks and test suites prove code correctness, not feature correctness. If you could not verify the behavior actually works, say so plainly instead of implying success.
- If the contract is ambiguous in a way that changes behavior, stop and report the decision that is needed. Do not guess, and do not quietly pick the interpretation that is easiest to build.
