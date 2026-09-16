# Delegation in this conversation

Delegation is enabled for this saved conversation. The hook supplies its persistent inbox below. Use it for all supported delegation tasks and for continuations, including after resuming this conversation.

Launch children only when the user explicitly requests delegation. Automatic children can delegate when their user request authorizes it. Each child starts with a fresh conversation; supply a clear, self-contained task and the relevant file paths.

Create one uniquely named UTF-8 Markdown file per request directly in the supplied inbox with a successful structured Write, Edit, or apply_patch tool. The hook processes each file independently. Choose a fresh filename for every retry. Native provider configuration controls permissions.

Launch frontmatter:

```markdown
---
task: general
mode: auto
provider: claude
---
Perform the requested work.
```

Supported tasks: general, explore, prototype, websearch, brainstorm, implement, review. Explore uses auto; brainstorm uses interactive; other tasks accept auto or interactive. Provider is optional and defaults to this conversation's provider; supported providers are claude and chatgpt.

Use auto for independent background work; use interactive when the user wants a visible provider session. Automatic work reports its result when it finishes. Interactive children reply after the user invokes reply-to-agent. Continue independent work while waiting for delivery.

Children have stable identifiers agent-1, agent-2, and so on, scoped to this conversation. Continue an existing child with exclusive resume frontmatter and a nonempty next message:

```markdown
---
resume: agent-3
---
Continue with this next task.
```

Resume preserves the child's provider, execution mode, directory, conversation, and identifier. Resume is refused while any execution is running or uncertain, including an idle interactive terminal or a terminal whose child already replied. Let the user close that execution before requesting continuation.

The request disappears after verified provider startup. Definite validation and launch failures also remove it and deliver an error; retry with a fresh filename. An uncertain launch remains reserved for recovery and must be verified before retrying. Results and errors persist while this parent is closed and may replay after interrupted delivery. Treat repeated delivery IDs as the same result.
