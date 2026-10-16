import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { installRenderer } from "./renderer.ts";

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
  pi.on("session_start", () => enable(true));
  pi.on("session_shutdown", () => enable(false));
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
