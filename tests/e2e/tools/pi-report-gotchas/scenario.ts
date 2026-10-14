import { createHash } from "node:crypto";
import { createPiToolScenario } from "../../core/pi-scenario.js";
import { OpenAiProtocolError, type OpenAiResponsesRequest } from "../../core/openai-server.js";

export const REPORT = '**Unverified Unicode 雪 result**\n\n## Caveats\n\n- A concrete acceptance check still needs human review. @everyone';
export const LONG_REPORT = '**Partial delivery recovery**\n\n## Caveats\n\n' + 'A consequential Unicode 雪 caveat remains. '.repeat(110);
export const marker = (route: string) => `[E2E:pi-gotchas:${route}]`;
export const scenarios = {
  submit: [{ tool: "report_gotchas", input: { message: REPORT } }, { tool: "report_gotchas", input: { message: REPORT } }],
  long: [{ tool: "report_gotchas", input: { message: LONG_REPORT } }],
  empty: [{ tool: "report_gotchas", input: { message: " \n " } }],
  nested: [{ tool: "gotchas_nested", input: {} }],
  none: [],
} as const;
const routes = Object.entries(scenarios).map(([name, steps]) => ({ name, scenario: createPiToolScenario({ name: `pi-gotchas-${name}`, marker: marker(name), steps: steps.map((step, index) => ({ ...step, checkpoint: `${name}-${index}` })) }) }));
export const scenario = {
  scenarioCatalogHash: createHash("sha256").update(routes.map(({ scenario }) => scenario.scenarioCatalogHash).join()).digest("hex"),
  transition(request: OpenAiResponsesRequest) {
    const index = request.input.reduce((last, item, current) => item.role === "user" && JSON.stringify(item.content).includes("[E2E:pi-gotchas:") ? current : last, -1);
    const route = routes.find(({ name }) => JSON.stringify(request.input[index]?.content).includes(marker(name)));
    if (!route) throw new OpenAiProtocolError("$.input", "unknown gotcha fixture route", "pi-gotchas");
    return route.scenario.transition({ ...request, input: request.input.slice(index) });
  },
};
