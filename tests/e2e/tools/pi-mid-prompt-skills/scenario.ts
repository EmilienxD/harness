import { OpenAiProtocolError, type OpenAiResponsesRequest } from "../../core/openai-server.js";
import { createPiToolScenario } from "../../core/pi-scenario.js";

export interface SkillResource { name: string; path: string; reference: string }
export interface InvocationCase { name: string; prompt: string; skills: string[] }
export const marker = (name: string) => `[E2E:pi-mid-prompt:${name}]`;
export const resourceMarker = (name: string) => `[E2E:resource:${name}]`;

/** Check structured skill identities/locations, not the wording of any instructions. */
export function invocationScenario(entry: InvocationCase, resources: readonly SkillResource[]) {
  const selected = entry.skills.map((name) => resources.find((skill) => skill.name === name)!);
  const scenario = createPiToolScenario({
    name: `pi-mid-prompt-${entry.name}`, marker: marker(entry.name),
    steps: [
      ...selected.map((skill) => ({
        checkpoint: `read-${skill.name}`, tool: "read", input: { path: skill.reference },
        verifyResult(output: unknown) {
          if (!JSON.stringify(output).includes(`reference:${skill.name}`)) throw new OpenAiProtocolError("$.input", "skill reference read failed", "pi-mid-prompt-skills");
        },
      })),
      { checkpoint: "write-receipt", tool: "write", input: { path: `${entry.name}.json`, content: JSON.stringify(entry.skills) } },
    ],
  });
  return (request: OpenAiResponsesRequest) => {
    const user = request.input.filter((item) => item.role === "user").map((item) => text(item.content)).join("\n");
    // Fixture-only routing keys live in the loaded bodies, never in invocation text.
    // This proves bodies arrived without asserting any agent instruction wording.
    const routed = [...user.matchAll(/\[E2E:resource:([^\]]+)\]/g)].map((match) => match[1]).sort();
    if (JSON.stringify(routed) !== JSON.stringify([...entry.skills].sort())) throw new OpenAiProtocolError("$.input", "skill body routing keys differ", "pi-mid-prompt-skills");
    const blocks = [...user.matchAll(/<skill\s+name="([^"]+)"\s+location="([^"]*)">/g)];
    const actual = blocks.map((match) => ({ name: match[1], path: match[2] })).sort((a, b) => a.name!.localeCompare(b.name!));
    const expected = selected.map(({ name, path }) => ({ name, path })).sort((a, b) => a.name.localeCompare(b.name));
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new OpenAiProtocolError("$.input", "expanded skill resource identities/counts differ", "pi-mid-prompt-skills");
    return scenario.transition(request);
  };
}

export function routeInvocations(routes: ReadonlyMap<string, ReturnType<typeof invocationScenario>>, request: OpenAiResponsesRequest) {
  const user = request.input.filter((item) => item.role === "user").map((item) => text(item.content)).join("\n");
  const selected = [...routes].filter(([name]) => user.includes(marker(name)));
  if (selected.length !== 1) throw new OpenAiProtocolError("$.input", "unknown or ambiguous invocation case", "pi-mid-prompt-skills");
  return selected[0]![1](request);
}

export function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(text).join("\n");
  if (typeof value === "object" && value !== null && "text" in value) return text(value.text);
  return "";
}
