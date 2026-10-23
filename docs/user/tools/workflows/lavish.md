# Lavish

Platforms: **Claude Code, ChatGPT, Pi**. Install with `harness install lavish`; see [installation and scope](../../getting-started.md).

## When to use

Use `lavish` when a plan, comparison, diagram, code view, report, or other agent output will be easier to review as an annotated browser page.

## Invocation

Use `/lavish [artifact request]` in Claude Code or `$lavish [artifact request]` in ChatGPT. With no argument, the agent infers a useful artifact from the conversation.

## What happens

The skill asks the `lavish-axi` CLI for its current workflow, design guidance, and relevant playbook rather than relying on possibly stale installed instructions. The agent creates an HTML artifact and opens it with `npx -y lavish-axi <html-file>`. You can annotate the page and send feedback back to the agent.

## Files and prerequisites

Claude Code, ChatGPT, and Pi are supported and `npx` is required. The HTML output path is chosen during the task; the package does not install a fixed project configuration or global CLI binary. The CLI is invoked through `npx -y`.

## Example

`/lavish Make the migration trade-offs reviewable` asks for an annotated comparison artifact.

## Pi usage

Use `/skill:lavish [artifact request]`. Pi appends the request as skill arguments. The shared skill uses `npx -y lavish-axi`; browser review and annotations require the external browser workflow.
