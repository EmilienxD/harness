# Logic prototype

A logic prototype is a **shareable demo** for driving a domain model through
cases that are difficult to judge on paper. Build one self-contained HTML file
with inline CSS and JavaScript so a non-developer can open it directly.

## Build the demo

1. Show the question at the top in plain language.
2. Express the model as a pure reducer, explicit state machine, or small set of
   pure functions. The page calls the model; the model has no UI concerns.
3. Render the full relevant state in domain language after every action.
4. Provide free-play controls for every meaningful action.
5. Add guided, resettable walkthroughs for the happy path and the cases most
   likely to challenge the model, including a rejected action when relevant.

Use restrained presentation that keeps the state, actions, and latest change
easy to inspect. A raw data view may supplement the explanation, but it does not
replace it.

The demo is complete when it opens directly, every meaningful action can be
driven, each decisive scenario starts from a known state, and the result of the
experiment is visible without reading the implementation.
