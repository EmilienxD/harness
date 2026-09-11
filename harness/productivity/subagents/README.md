# subagents

Installs the complete visible-subagent workflow: the ask and reply skills, their standalone task
skills, provider hooks, and the persistent runtime CLI. The hooks and runtime are internal parts of
this package and are not independent catalogue choices.

The `issue-readers` dependency supplies the user-owned `address-issue` and `review-issue` worker
prompts and their context hooks. `ask-agent-to-implement` launches `address-issue`, while
`ask-agent-to-review` launches `review-issue` in a visible child session.
