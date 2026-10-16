import { createPiToolScenario } from "../../core/pi-scenario.js";

export const marker = "[E2E:pi-calm]";
export const contents = "Calm preserves native tool execution.\n";
export const scenario = createPiToolScenario({
  name: "pi-calm", marker,
  steps: [
    { checkpoint: "write", tool: "write", input: { path: "calm-result.txt", content: contents } },
    { checkpoint: "read", tool: "read", input: { path: "calm-result.txt" } },
  ],
});
