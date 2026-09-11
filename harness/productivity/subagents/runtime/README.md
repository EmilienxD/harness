# Harness subagents runtime

Persistent CLI, session storage, delegation protocol, and hook implementation for the `subagents`
catalogue package. It is installed automatically and is not a catalogue choice.

## Delegation schemas

The JSON files under `src/subagents_runtime/schemas/` are published contract descriptions for the two
protocol boundaries:

- `delegation-request.schema.json` describes YAML frontmatter written to a delegation inbox.
- `aboard-delegation.schema.json` describes the JSON request sent to Aboard's loopback bridge.

They are intentionally not the runtime authorization mechanism. The Python runtime must additionally
check the live grant policy, and Aboard must check the selected task's permitted execution modes before
launching anything. Those checks are policy, not just data-shape validation, and are kept at their
respective trust boundaries. `tests/unit/test_delegation_requests.py` checks that the published enums
remain aligned with the Python contract.
