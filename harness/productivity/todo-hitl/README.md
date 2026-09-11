# todo-hitl

Installs two user-invocable skills for deferring code work behind an explicit human decision:

- `mark-as-todo-hitl` leaves a concise `TODO(HITL)` comment at the relevant code location.
- `address-todo-hitl` investigates the highest-priority comment using repository evidence, agrees on a
  recommendation with the user, implements it, and then offers the next comment.
