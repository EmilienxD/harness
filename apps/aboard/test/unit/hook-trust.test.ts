import assert from "node:assert/strict";
import test from "node:test";

import { AutoRunHookTrust } from "../../src/chatgpt/hook-trust.js";

test("workspace hook consent is remembered across activations", async () => {
  let allowed = false;
  const host = {
    isAllowed: () => allowed,
    remember: async () => { allowed = true; },
    ask: async () => true,
  };
  assert.equal(await new AutoRunHookTrust(host).approve(), true);
  const restored = new AutoRunHookTrust({ ...host, ask: async () => { throw new Error("Unexpected prompt"); } });
  assert.equal(await restored.approve(), true);
});

test("concurrent requests share consent and cancellation can be retried", async () => {
  const prompt: { answer?: (allowed: boolean) => void } = {};
  const answer = (allowed: boolean) => { prompt.answer?.(allowed); };
  let allowed = false;
  const consent = new AutoRunHookTrust({
    isAllowed: () => allowed,
    remember: async () => { allowed = true; },
    ask: () => new Promise<boolean>((resolve) => {
      if (prompt.answer !== undefined) throw new Error("Duplicate consent prompt");
      prompt.answer = resolve;
    }),
  });
  const first = consent.approve();
  const second = consent.approve();
  answer(false);
  assert.deepEqual(await Promise.all([first, second]), [false, false]);
  assert.equal(allowed, false);
  delete prompt.answer;
  const retry = consent.approve();
  answer(true);
  assert.equal(await retry, true);
  assert.equal(allowed, true);
});
