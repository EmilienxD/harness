import { OpenAiProtocolError, type OpenAiResponsesRequest } from "../../core/openai-server.js";
import { createPiToolScenario } from "../../core/pi-scenario.js";

export function sharedSkillScenario(name: string, files: readonly { path: string; bytes: string }[]) {
  return createPiToolScenario({
    name: `pi-shared-${name}`, marker: `[E2E:pi-shared-${name}]`,
    steps: [
      ...files.map(({ path, bytes }, index) => ({
        checkpoint: `read-${index}`, tool: "read", input: { path },
        verifyResult(output: unknown) {
          // Compare file content, never instructions as a prompt contract.
          const result = strings(output);
          if (!result.includes(bytes.trim())) throw new OpenAiProtocolError("$.input", "native read did not return the installed file", `pi-shared-${name}`);
        },
      })),
      { checkpoint: "write", tool: "write", input: { path: `${name}-result.txt`, content: `${name}\n` } },
    ],
  });
}

function strings(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(strings).join("\n");
  if (typeof value === "object" && value !== null) return Object.values(value).map(strings).join("\n");
  return "";
}

export function routeSharedSkills(scenarios: ReadonlyMap<string, ReturnType<typeof sharedSkillScenario>>, request: OpenAiResponsesRequest) {
  const selected = [...scenarios.entries()].filter(([name]) => request.input.some((item) => item.role === "user" && JSON.stringify(item.content).includes(`[E2E:pi-shared-${name}]`)));
  if (selected.length !== 1) throw new OpenAiProtocolError("$.input", "unknown or ambiguous shared skill scenario", "pi-shared-skills");
  return selected[0]![1].transition(request);
}
