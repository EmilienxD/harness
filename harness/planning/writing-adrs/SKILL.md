---
name: writing-adrs
description: Write or edit architectural decision records (ADRs). Use whenever a task creates, changes, or supersedes an ADR.
argument-hint: "[decision or ADR path]"
license: MIT
metadata:
  author: EMB
---

## ADR authoring rules

Use this skill whenever authoring an ADR. Every ADR must follow these rules and format.

### What an ADR is

A contract. It records decisions and rules that were agreed on and are now binding. It is a small knowledge base for one feature: someone starting a session on that feature reads it and immediately knows what is settled, what the values are, and what to build next. It is not a design doc, not a tutorial, not a changelog, not a code map.

### Lifecycle

- An ADR is written once and almost never edited. Only a reversal of an agreed decision justifies an edit.
- `status: accepted` means the decision was agreed between the owner and the agents. It does not mean "verified against the code". Never claim code verification anywhere in the file.
- Reversing a decision means a new numbered record with `supersedes`, and the old one flipped to `superseded` with `superseded-by`. Do not edit a decision into a different decision.
- Files are `NNNN-kebab-case-title.md`, next free number, never reused. Add a row to `docs/adr/README.md`'s index.

### Hard prohibitions

- No code identifiers: no constant, variable, function, class, method, field, enum, table, column, or test names.
- No file paths and no line references. The only allowed links are other ADRs and `reference/unit-economics.md`.
- No code blocks of real code. A formula in plain words is allowed (see skeleton).
- No considered options, no rejected alternatives, no pros-and-cons, no decision drivers. The choice is already made; write only the outcome.
- No "Verified by" / "Confirmation" section, no test names, no compliance-checking instructions.
- No implementation narration (how a transaction commits, what a function returns, which module owns what).
- Nothing that a rename or refactor would invalidate. Test: if a variable rename would force an edit here, the sentence is wrong.

### What must be in it

- The decision, stated first, in one to three sentences.
- Every agreed value: prices, ratios, limits, bounds, thresholds, TTLs, percentages, orderings, defaults. Values are decisions and belong here.
- Rules as terse bullets, each one independently checkable by a human reading it.
- Provider or vendor facts that the decision depends on, described as facts (a cache read costs 10% of input), not as configuration.
- Trade-offs that were knowingly accepted, including known leaks and known-pessimistic behaviour. This is the highest-value part: it stops a future session from "fixing" something deliberate.
- Cross-references to the ADRs this one depends on or enables, by number.

### What must stay out

- Rationale longer than the rule it justifies. One clause of "why" per rule, at most, and only when the rule looks arbitrary without it.
- Anything already stated in another ADR. Reference it instead; never restate a price book or a task contract.
- Anything specific enough to belong to a price table or a catalog. Push those to `reference/unit-economics.md` and state the rule generically.

### Style

- English only. No emojis. No em-dash; use ";" or "." instead.
- Dense and declarative. Prefer nouns, values and imperatives over sentences about sentences.
- Bold only for the one or two load-bearing statements.
- Tables for per-provider or per-plan matrices.
- Target 60 to 110 lines. Over 120 means rationale or implementation detail crept in.

### Skeleton

````markdown
---
status: accepted
date: YYYY-MM-DD
deciders: EmilienxD
tags: [area, subject]
---

# ADR-NNNN: <Decision as a statement, not a topic>

<One or two lines of framing: the constraint that forces a decision. Optional.>

## Decision

**<The decision, with its defining value.>** <What it implies for every other
part of the system, in two or three sentences.>

## Rules

<Optional plain-words formula:>
```
result = <term in words> * <term in words>
       + <term in words>
```

- <Rule with its value.>
- <Rule, with a single clause of why only if needed.>
- <Refusal or limit behaviour, and what is returned.>

### <Sub-matrix, if any>

| Provider | X | Y |
|---|---|---|

## Trade-offs accepted

- <Known imprecision, leak, or cost, and why it is tolerated.>

## Related

ADR-000X (<subject>), ADR-000Y (<subject>).
````
