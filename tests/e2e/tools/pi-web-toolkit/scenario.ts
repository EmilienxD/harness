import assert from "node:assert/strict";
import { createPiToolScenario } from "../../core/pi-scenario.js";
import { OpenAiProtocolError, type OpenAiResponsesRequest } from "../../core/openai-server.js";
import { PAGE } from "./web-fixture.js";

export const marker = (route: string) => `[E2E:pi-web-toolkit:${route}]`;
export const SEARCH_QUERY = '-literal toolkit café 雪 "quoted" $(touch injected) & echo nope';
export const ENGINE_QUERIES = [
  `${SEARCH_QUERY} site:127.0.0.1 -site:excluded.invalid`,
  "toolkit domains (site:docs.example.test OR site:other.example.test) -site:blocked.docs.example.test -site:excluded.invalid",
  "toolkit blocked -site:docs.example.test -site:excluded.invalid",
  "toolkit",
];
function text(output: unknown): string {
  assert.equal(typeof output, "string");
  return (output as string).replace(/\r\n/gu, "\n");
}
export function webToolkitScenario(origin: () => string) {
  // The origin is assigned after the external Pi fixture and local web server are ready.
  function routes() {
    const base = origin();
    return {
      main: [
        { checkpoint: "search", tool: "web_search", input: { query: SEARCH_QUERY, allowed_domains: ["127.0.0.1"], blocked_domains: ["excluded.invalid"] }, verifyResult(output: unknown) {
          const value = text(output);
          assert.ok(value.includes(`${base}/page`)); assert.ok(value.includes("Toolkit café 雪 guide"));
          assert.ok(value.includes("Toolkit source snippet.")); assert.ok(!value.includes("excluded.invalid"));
        } },
        { checkpoint: "domain-allow-block", tool: "web_search", input: { query: "toolkit domains", allowed_domains: ["DOCS.EXAMPLE.TEST", "other.example.test"], blocked_domains: ["blocked.docs.example.test", "excluded.invalid"] }, verifyResult(output: unknown) {
          const value = text(output);
          for (const host of ["docs.example.test", "sub.docs.example.test", "other.example.test"]) assert.ok(value.includes(`https://${host}/page`));
          assert.ok(!value.includes(base)); assert.ok(!value.includes("blocked.docs.example.test")); assert.ok(!value.includes("excluded.invalid"));
          assert.equal((value.match(/^\d+\. /gmu) ?? []).length, 3);
        } },
        { checkpoint: "domain-block", tool: "web_search", input: { query: "toolkit blocked", blocked_domains: ["docs.example.test", "excluded.invalid"] }, verifyResult(output: unknown) {
          const value = text(output);
          assert.ok(value.includes(`${base}/page`)); assert.ok(value.includes("https://other.example.test/page"));
          assert.ok(!value.includes("docs.example.test")); assert.ok(!value.includes("excluded.invalid"));
          assert.equal((value.match(/^\d+\. /gmu) ?? []).length, 2);
        } },
        { checkpoint: "unfiltered-search", tool: "web_search", input: { query: "toolkit" }, verifyResult(output: unknown) {
          assert.equal((text(output).match(/^\d+\. /gmu) ?? []).length, 6);
        } },
        { checkpoint: "fetch", tool: "web_fetch", input: { url: `${base}/page` }, verifyResult(output: unknown) { assert.ok(text(output).includes(PAGE.trim())); } },
        { checkpoint: "redirect", tool: "web_fetch", input: { url: `${base}/redirect` }, verifyResult(output: unknown) { assert.ok(text(output).includes(`URL: ${base}/page`)); } },
        { checkpoint: "long-page", tool: "web_fetch", input: { url: `${base}/long` }, verifyResult(output: unknown) { assert.ok(text(output).includes("Full text:")); assert.ok(text(output).includes("[Truncated.")); } },
        { checkpoint: "http-error", tool: "web_fetch", input: { url: `${base}/missing` }, verifyResult(output: unknown) { assert.ok(text(output).includes("Status: 404")); assert.ok(text(output).includes("Missing fixture page.")); } },
        { checkpoint: "empty-input", tool: "web_search", input: { query: "   " }, verifyResult(output: unknown) { assert.ok(text(output).includes("nonempty")); } },
        { checkpoint: "invalid-schema", tool: "web_fetch", input: { url: 12 }, verifyResult(output: unknown) { assert.ok(!text(output).includes("URL:")); } },
        { checkpoint: "invalid-domain", tool: "web_search", input: { query: "toolkit", allowed_domains: ["https://example.test/path"] }, verifyResult(output: unknown) { assert.ok(!text(output).includes("Toolkit source snippet.")); } },
        { checkpoint: "mixed-domain-syntax", tool: "web_search", input: { query: "toolkit site:excluded.invalid", allowed_domains: ["127.0.0.1"] }, verifyResult(output: unknown) { assert.ok(text(output).includes("website restrictions")); } },
      ],
      missing: [{ checkpoint: "missing-cli", tool: "web_fetch", input: { url: `${base}/page` }, verifyResult(output: unknown) { assert.ok(text(output).includes("CLI unavailable")); } }],
      abort: [{ checkpoint: "cancel-fetch", tool: "web_fetch", input: { url: `${base}/slow` } }],
    };
  }
  return {
    scenarioCatalogHash: "pi-web-toolkit-v1",
    transition(request: OpenAiResponsesRequest) {
      const index = request.input.reduce((last, item, current) => item.role === "user" && JSON.stringify(item.content).includes("[E2E:pi-web-toolkit:") ? current : last, -1);
      const route = Object.entries(routes()).find(([name]) => JSON.stringify(request.input[index]?.content).includes(marker(name)));
      if (!route) throw new OpenAiProtocolError("$.input", "unknown web toolkit fixture route", "pi-web-toolkit");
      for (const [name, key] of [["web_search", "query"], ["web_fetch", "url"]]) {
        const tool = request.tools.find((item) => item.name === name);
        assert.ok(tool);
        const schema = tool.parameters as { properties: Record<string, { type: string; items?: { type: string; pattern: string } }>; required: string[]; additionalProperties: boolean };
        assert.deepEqual(Object.keys(schema.properties), name === "web_search" ? ["query", "allowed_domains", "blocked_domains"] : [key]);
        assert.equal(schema.properties[key!]!.type, "string");
        if (name === "web_search") for (const field of ["allowed_domains", "blocked_domains"]) {
          assert.equal(schema.properties[field]!.type, "array"); assert.equal(schema.properties[field]!.items?.type, "string");
          assert.equal(typeof schema.properties[field]!.items?.pattern, "string");
        }
        assert.deepEqual(schema.required, [key]); assert.equal(schema.additionalProperties, false);
      }
      return createPiToolScenario({ name: `pi-web-toolkit-${route[0]}`, marker: marker(route[0]), steps: route[1] }).transition({ ...request, input: request.input.slice(index) });
    },
  };
}
