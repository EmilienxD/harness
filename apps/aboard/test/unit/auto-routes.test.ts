import assert from "node:assert/strict";
import test from "node:test";

import { createAutoRoutes } from "../../src/bridge/auto.js";
import type { AuthenticatedBridgeRequest } from "../../src/bridge/protocol.js";

function request(prompt: string): AuthenticatedBridgeRequest {
  return {
    method: "POST",
    url: new URL("http://127.0.0.1/hooks/auto"),
    headers: {},
    body: { sessionId: "session-1", prompt },
    signal: new AbortController().signal,
  };
}

test("the /auto --dry hook returns Aboard's forecast without starting a run", async () => {
  let starts = 0;
  const forecast = { dryRun: true as const, inspected: false as const, reason: "nothing labelled" };
  const route = createAutoRoutes({
    dryRun: async () => forecast,
    start: async () => { starts += 1; return { started: false as const, reason: "unused" }; },
  });

  const response = await route(request("/auto --dry"));

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { message: JSON.stringify(forecast, null, 2) });
  assert.equal(starts, 0);
});

test("the /auto hook starts a run and passes its trailing guidance", async () => {
  let options: { readonly additionalGuideline?: string } | undefined;
  const result = { started: false as const, reason: "a run is already active" };
  const route = createAutoRoutes({
    dryRun: async () => ({ dryRun: true, inspected: false, reason: "unused" }),
    start: async (received) => { options = received; return result; },
  });

  const response = await route(request("/auto keep the public API stable"));

  assert.deepEqual(options, { additionalGuideline: "keep the public API stable" });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { message: JSON.stringify(result, null, 2) });
});
