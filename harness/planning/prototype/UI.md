# UI prototype

A UI prototype is a **variant gallery** for comparing materially different
answers to one interface question.

## Build the gallery

1. Inspect the real host surface, then reproduce only the chrome, dimensions,
   representative data, and constraints needed for an honest comparison.
2. Default to three variants. Each must differ in structure, information
   hierarchy, density, or primary affordance—not merely color or copy.
3. Put every variant behind one entry point selected by a `?variant=` URL
   parameter. Give each variant a concise name and its own rendering structure.
4. Add a visually distinct, fixed bottom-center switcher with previous and next
   controls. Wrap at both ends, preserve other URL parameters, and support Left
   and Right arrow keys except while the user is editing a field.
5. Use representative fixtures and in-memory interactions. Include only the
   responsive sizes and interface states that could change the decision.

Show the design question and what to compare inside the gallery. Match the
product's visual language closely enough to make the comparison credible while
keeping the gallery self-contained.

The gallery is complete when every variant is reload-stable, structurally
distinct, usable at the relevant dimensions, and reachable through one obvious
open/run instruction.
