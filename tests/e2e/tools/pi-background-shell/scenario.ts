import assert from "node:assert/strict";
import { createPiToolScenario, type PiScenarioStep } from "../../core/pi-scenario.js";
import { OpenAiProtocolError, type OpenAiResponsesRequest, type OpenAiScenarioResponse } from "../../core/openai-server.js";

export const marker = (name: string) => `[E2E:pi-background-shell:${name}]`;
export function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(text).join("\n");
  if (value && typeof value === "object" && "text" in value) return text(value.text);
  return "";
}
export function backgroundScenario(steps: (route: string, request: OpenAiResponsesRequest) => readonly PiScenarioStep[]) {
  return {
    scenarioCatalogHash: "pi-background-shell-v1",
    transition(request: OpenAiResponsesRequest): OpenAiScenarioResponse {
      let route = ""; let start = -1;
      request.input.forEach((item, index) => {
        if (item.role !== "user") return;
        const match = /\[E2E:pi-background-shell:([a-z-]+)\]/u.exec(text(item.content));
        if (match) { route = match[1]!; start = index; }
      });
      if (start < 0) throw new OpenAiProtocolError("$.input", "unknown background-shell route");
      const scoped = { ...request, input: request.input.slice(start) };
      const launch = createPiToolScenario({ name: `background-shell-${route}`, marker: marker(route), steps: steps(route, request) });
      const notification = scoped.input.flatMap((item) => text(item.content).split("\n")).map((line) => {
        try { return JSON.parse(line) as { type?: string; jobs?: Record<string, unknown>[] }; } catch { return {}; }
      }).find((value) => value.type === "shell_job_completion");
      if (!notification) return launch.transition(scoped);
      const jobs = notification.jobs!;
      assert.equal(jobs.length, 1);
      assert.ok(typeof jobs[0]!.id === "string");
      const launched = request.input.find((item) => {
        if (item.type !== "function_call_output") return false;
        try { return JSON.parse(String(item.output)).id === jobs[0]!.id; } catch { return false; }
      });
      assert.ok(launched, "Notification must reference a previously launched job");
      const callIndex = request.input.findIndex((item) => item.type === "function_call" && item.call_id === launched.call_id);
      let origin = ""; let originIndex = -1;
      request.input.slice(0, callIndex).forEach((item, index) => {
        if (item.role !== "user") return;
        const match = /\[E2E:pi-background-shell:([a-z-]+)\]/u.exec(text(item.content));
        if (match) { origin = match[1]!; originIndex = index; }
      });
      assert.ok(originIndex >= 0);
      const receipt = `completion-${origin}.json`;
      const completion: PiScenarioStep[] = [{
        checkpoint: "completion-received", tool: "write", input: { path: receipt, content: JSON.stringify(jobs[0]) },
      }];
      const removed = new Set(request.input.slice(originIndex).filter((item) => item.type === "function_call" && item.name !== "write").map((item) => item.call_id));
      const completionHistory = request.input.slice(originIndex).filter((item) => !(
        (item.type === "function_call" || item.type === "function_call_output") && removed.has(item.call_id)
      ));
      return createPiToolScenario({ name: `background-shell-${origin}-completion`, marker: marker(origin), steps: completion }).transition({ ...request, input: completionHistory });
    },
  };
}
