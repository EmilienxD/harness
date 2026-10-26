import { createHash } from "node:crypto";
import { createPiToolScenario } from "../../core/pi-scenario.js";
import { OpenAiProtocolError, type OpenAiResponsesRequest } from "../../core/openai-server.js";

export const REPORT = '**REPORT-GOTCHAS-E2E - Pi**\n\n- End-to-end verification: real headless Pi posted this Unicode \u96ea report using fake model inference. This test message can be deleted. @everyone';
export const LONG_REPORT = '**Multipart report**\n\n## Caveats\n\n' + 'A consequential Unicode 雪 caveat remains. '.repeat(110);
export const marker = (route: string) => `[E2E:pi-gotchas:${route}]`;
export const shell = process.platform === "win32" ? "powershell" : "bash";
export function submitCommand(message: string, cli: string): string {
  return process.platform === "win32"
    ? `${cli} submit -m @'\n${message}\n'@`
    : `${cli} submit <<'HARNESS_GOTCHAS'\n${message}\nHARNESS_GOTCHAS`;
}
export function gotchasScenario(cli: string) {
  const scenarios = {
    submit: [{ tool: shell, input: { command: submitCommand(REPORT, cli) } }],
    long: [{ tool: shell, input: { command: submitCommand(LONG_REPORT, cli) } }],
    empty: [{ tool: shell, input: { command: submitCommand(" \n ", cli) } }],
    none: [],
  } as const;
  const routes = Object.entries(scenarios).map(([name, steps]) => ({ name, scenario: createPiToolScenario({ name: `pi-gotchas-${name}`, marker: marker(name), steps: steps.map((step, index) => ({ ...step, checkpoint: `${name}-${index}` })) }) }));
  return {
    scenarioCatalogHash: createHash("sha256").update(routes.map(({ scenario }) => scenario.scenarioCatalogHash).join()).digest("hex"),
    transition(request: OpenAiResponsesRequest) {
      if (request.tools.some(tool => tool.name === "report_gotchas"))
        throw new OpenAiProtocolError("$.tools", "removed reporting tool is still offered", "pi-gotchas");
      const index = request.input.reduce((last, item, current) => item.role === "user" && JSON.stringify(item.content).includes("[E2E:pi-gotchas:") ? current : last, -1);
      const route = routes.find(({ name }) => JSON.stringify(request.input[index]?.content).includes(marker(name)));
      if (!route) throw new OpenAiProtocolError("$.input", "unknown gotcha fixture route", "pi-gotchas");
      return route.scenario.transition({ ...request, input: request.input.slice(index) });
    },
  };
}
