import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { copyToClipboard, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { indexBlocks, installRenderer } from "./renderer.ts";
import type { Message } from "./renderer.ts";

const DEMO = [
  "### Code block preview", "", "```text", "test", "```", "",
  "```typescript", 'const greeting = (name: string) => `Hello, ${name}!`;',
  'console.log(greeting("Pi"));', "```", "",
  "```python", "def greet(name: str) -> str:", '    return f"Hello, {name}!"', "```", "",
  "```sh", "uv run harness install polished-code-blocks --platform pi --scope user", "```", "",
  "Press any key to close. This preview makes no model request.",
].join("\n");

export default function (pi: ExtensionAPI): void {
  let patch: ReturnType<typeof installRenderer>;
  try {
    patch = installRenderer();
  } catch (error) {
    console.error(`Polished code blocks disabled: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  const enable = (enabled: boolean) => {
    patch.enabled = enabled;
    patch.revision++;
  };
  const sync = (ctx: { sessionManager: { getBranch(): readonly { type: string; message?: unknown }[] } }, live?: Message) => {
    const messages = ctx.sessionManager.getBranch()
      .filter(entry => entry.type === "message")
      .map(entry => entry.message as Message);
    // Streaming updates may precede persistence in the session manager.
    if (live?.role === "assistant") {
      const last = messages.at(-1);
      if (last?.role === "assistant" && last.timestamp === live.timestamp) messages.pop();
      messages.push(live);
    }
    patch.sources = indexBlocks(messages);
    patch.revision++;
  };
  pi.on("session_start", (_event, ctx) => { sync(ctx); enable(true); });
  pi.on("session_tree", (_event, ctx) => sync(ctx));
  pi.on("message_start", (event, ctx) => sync(ctx, event.message as Message));
  pi.on("message_update", (event, ctx) => sync(ctx, event.message as Message));
  pi.on("message_end", (event, ctx) => sync(ctx, event.message as Message));
  pi.on("session_shutdown", () => { patch.sources = []; enable(false); });
  pi.registerCommand("copy-block", {
    description: "Copy a numbered code block, or the latest block (no model request)",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      const argument = args.trim();
      if (argument && !/^[1-9]\d*$/.test(argument)) {
        ctx.ui.notify("Usage: /copy-block [positive block number]", "warning");
        return;
      }
      sync(ctx);
      const blocks = patch.sources.flatMap(source => source.blocks);
      const number = argument ? Number(argument) : blocks.length;
      if (!blocks.length) {
        ctx.ui.notify("No assistant code blocks on the active session branch.", "warning");
        return;
      }
      if (!Number.isSafeInteger(number) || number > blocks.length) {
        ctx.ui.notify(`Block #${argument} not found. Available: 1–${blocks.length}.`, "warning");
        return;
      }
      try {
        await copyToClipboard(blocks[number - 1].text);
        ctx.ui.notify(`Copied code block #${number}.`, "info");
      } catch (error) {
        ctx.ui.notify(`Could not copy code block: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
  pi.registerCommand("code-blocks", {
    description: "Polished code blocks: on, off, or demo (no model request)",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      const action = args.trim() || "demo";
      if (action === "on" || action === "off") {
        enable(action === "on");
        ctx.ui.setStatus("polished-code-blocks", patch.enabled ? undefined : "Code blocks: plain");
        ctx.ui.notify(`Polished code blocks ${patch.enabled ? "enabled" : "disabled"}.`, "info");
        return;
      }
      if (action !== "demo") {
        ctx.ui.notify("Usage: /code-blocks [demo|on|off]", "warning");
        return;
      }
      await ctx.ui.custom<void>((_tui, _theme, _keys, done) => {
        const markdown = new Markdown(DEMO, 1, 1, getMarkdownTheme());
        return {
          render: (width: number) => markdown.render(width),
          invalidate: () => markdown.invalidate(),
          handleInput: () => done(),
        };
      });
    },
  });
}
