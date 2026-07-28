---
name: improve-codebase-architecture
description: Find deepening opportunities in a codebase and propose concrete refactors. Use when the user wants to improve architecture, find refactoring opportunities, consolidate tightly-coupled modules, or make a codebase more testable and navigable. Trigger on phrases like "improve my architecture", "refactor this", "make this more testable", "find architectural problems", "where is there friction in my code", or any request to review or clean up code structure.
disable-model-invocation: true
---

# Improve Codebase Architecture

Surface architectural friction and propose **deepening opportunities** — refactors that turn shallow modules into deep ones. The aim is testability and navigability.

## Domain vocabulary

Before exploring, read the `project-domain-glossary` skill if it exists. Use its terms when describing candidates — talk about the concepts *in the project's language*, not generic ones. If the file doesn't exist, infer vocabulary from the codebase itself and name things consistently.

## Architectural vocabulary

Read `LANGUAGE.md` (sibling file, in this skill folder) before exploring. It defines the full set of terms (Module, Interface, Depth, Seam, Adapter, Leverage, Locality) and the principles behind them. Use those terms exactly throughout — don't drift into "component," "service," "API," or "boundary."

Key heuristics (full definitions in `LANGUAGE.md`):

- **Deletion test**: imagine deleting the module. If complexity vanishes, it was a pass-through. If it reappears across N callers, it was earning its keep.
- **The interface is the test surface.** Callers and tests cross the same seam.
- **One adapter = hypothetical seam. Two adapters = real seam.**

## Process

### 1. Explore

Read `LANGUAGE.md` and `.dev/project-domain-glossary` (if it exists) before touching any code. Then walk the codebase organically and note where you experience friction:

- Where does understanding one concept require bouncing between many small modules?
- Where are modules **shallow** — interface nearly as complex as the implementation?
- Where have pure functions been extracted just for testability, but the real bugs hide in how they're called (no **locality**)?
- Where do tightly-coupled modules leak across their seams?
- Which parts are untested, or hard to test through their current interface?

Apply the **deletion test** to anything suspect. "Would deleting this concentrate complexity, or just move it?" — a "concentrates" answer is the signal you want.

### 2. Present candidates

Present a numbered list of deepening opportunities. For each:

- **Files** — which files/modules are involved
- **Problem** — why the current architecture causes friction
- **Solution** — plain English description of what would change
- **Benefits** — in terms of locality, leverage, and how tests would improve

Use the project's domain vocabulary for concepts; use the architectural glossary above for structure words.

Do NOT propose interfaces yet. Ask: "Which of these would you like to explore?"

### 3. Grilling loop

Once the user picks a candidate, walk the design tree with them: constraints, dependencies, the shape of the deepened module, what sits behind the seam, what tests survive.

Keep going until the design feels settled, then offer to help implement or write tests.