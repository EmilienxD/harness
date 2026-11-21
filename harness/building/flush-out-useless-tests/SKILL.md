---
name: flush-out-useless-tests
description: Developer-invoked only. Agents must not invoke this skill on their own. Audit passing tests in up to 35 test files and propose deletion or rewriting for approval.
argument-hint: "[path or module] [focus]"
license: MIT
metadata:
  author: EMB
disable-model-invocation: true
---

Find tests that provide no useful protection, explain the evidence, and recommend deletion or rewriting while preserving meaningful behavioral coverage.

Audit first, report recommendations, and wait for approval before editing tests. Report directly in the conversation; write a report file only when requested.

## 1. Establish a passing baseline

Honor the supplied paths, module, and focus. Without a scope, list the test layout and choose one coherent area. State the selected scope and exclusions before inspecting test bodies. Exclude generated tests, vendored code, dependencies, and build outputs unless explicitly included.

Inspect at most **35 distinct test files per invocation unless explicitly asked for more**.

Build an ordered queue within the scope: prioritize likely tautologies, swallowed assertions, mock self-assertions, and repetitive tests, then append remaining files in stable path order. Search matches are leads, not verdicts.

Run the project's test command for the selected scope before judging usefulness. Record the command and test results. Only passing tests are eligible for audit; exclude failing, skipped, or unexecuted tests and report those exclusions. Collection or setup failures exclude the affected tests. If no tests pass, report that and stop.

## 2. Assess the behavior

For each selected file, inspect every eligible test body and its passing parameter cases; do not stop after the first finding. Read relevant fixtures, helpers, specifications, and production code to understand them. Trace setup, the code exercised, assertion execution, and any framework-provided failure checks. Assertion-free tests may still check that an operation succeeds or that a framework contract holds.

Identify the contract being checked and where the expected result comes from: a specification, an independent oracle, or a valid property. Ask which plausible behavior bug should make the test fail. Distinguish a reasoned example from a failure actually observed by running it.

Apply these verdicts to individual assertions first, then to the whole test:

| Verdict | Pattern | Required reasoning |
| --- | --- | --- |
| Delete | Tautology: expected and actual results come from the same function under test with equivalent inputs | Show that both sides share the same faulty computation and there is no independent contract check. |
| Delete | Mock self-assertion: configure a mock, call it, and assert its configured return value | Show that the assertion checks the mock itself rather than behavior of production code using it. |
| Delete | Can't go red: swallowed failure, unreachable assertion, unobserved callback assertion, or unconditional truth | Trace the execution and failure propagation; verify that the framework cannot observe a meaningful failure. |
| Rewrite, or Delete if no useful contract remains | Private-state assertion | Identify the public behavior it should check instead. Implementation coupling alone does not prove uselessness. |
| Delete duplicates | Happy-path clones checking the same contract | Name the retained test and show equivalent behavior, setup, input classes, and failure protection. Similar syntax or equal line coverage is insufficient. |
| Rewrite | Snapshot that approves changes without a meaningful reviewed contract | Support this with the snapshot and available change history; recommend a focused contract assertion or a smaller meaningful snapshot. Snapshot use or updates alone are insufficient evidence. |
| Keep | Observable output checked against a specification-derived expected value, independent oracle, or meaningful property | Explain the behavior bug this detects. Property and metamorphic tests need not use literal expected values. |
| Keep | Boundary and error paths: empty input, None/null, overflow, denied access, unavailable dependencies | Preserve distinct input classes and failure behavior even when they execute the same lines. |
| Keep | Regression tied to a real bug | Use available history or a documented reproducer; a test name alone does not establish provenance. |
| Keep | Contract at a module or API seam | Preserve externally observable behavior, such as a route's status and response schema. |
| Investigate | Insufficient evidence, unresolved intent, or unavailable execution context | State the missing evidence and leave the test intact. |

For every deletion or rewrite finding, record the location, current assertion behavior, evidence of the weakness, and the contract retained or restored.

## 3. Report and request approval

Include:

- **Area, scope, and coverage:** concrete scope, selected tests, excluded tests. Total audit test files count.
- **Findings:** location (`path:line` and test identifier), evidence, and a recommendation to delete or modify. Explain exactly how to modify a test, and name the retained test for each duplicate. Group Keep results by protected behavior; list Investigate cases separately. Say plainly when no supported deletion or rewrite was found.

Claim completeness only for eligible tests fully reviewed. When proposing cleanup, end with one sentence: "Does this work for you, and would you like me to proceed with the proposed cleanup?" Wait for the answer. A simple yes or similar is a signal to proceed.

## 4. Clean up & verify

Apply the approved deletions and rewrites using project instructions. Preserve distinct boundaries, regressions, and seam contracts. Leave excluded and Investigate tests unchanged; a shared parametrized test body may only be changed when all its cases passed the baseline. Stay within the approved batch.

Run all remaining tests in the audited scope, including kept and modified tests. Every previously passing test that remains, and every replacement test, must pass. Treat a new failure as a cleanup regression: correct or revert your edits and rerun the scoped tests. Keep production code unchanged. Baseline failures remain excluded and are reported separately; unavailable verification means cleanup is unverified.

## 5. Conclude

Finish with a brief summary of what changed and whether verification passed, including any unresolved issue/gotcha. Keep the detailed findings in the pre-cleanup report. If tests remain unaudited, suggest the next batch.
