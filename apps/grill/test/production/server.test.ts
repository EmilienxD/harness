import assert from "node:assert/strict";
import test from "node:test";

const entryUrl = new URL("../../.vercel/output/functions/__server.func/_ssr/ssr.mjs", import.meta.url);

test("the production server starts without browser globals and serves the board and API", async (t) => {
  const previousCode = process.env["HARNESS_GRILL_CODE"];
  process.env["HARNESS_GRILL_CODE"] = "1234";
  t.after(() => {
    if (previousCode === undefined) delete process.env["HARNESS_GRILL_CODE"];
    else process.env["HARNESS_GRILL_CODE"] = previousCode;
  });
  const { default: server } = await import(entryUrl.href);

  const board = await server.fetch(new Request("http://localhost/"), {}, {});
  assert.equal(board.status, 200);
  assert.match(board.headers.get("content-type") ?? "", /text\/html/u);
  assert.match(await board.text(), /<!DOCTYPE html>/iu);

  const unauthorized = await server.fetch(new Request("http://localhost/api/v1/capabilities"), {}, {});
  assert.equal(unauthorized.status, 401);
  assert.equal((await unauthorized.json()).error.code, "unauthorized");

  const capabilities = await server.fetch(
    new Request("http://localhost/api/v1/capabilities", { headers: { Authorization: "Bearer 1234" } }),
    {},
    {},
  );
  assert.equal(capabilities.status, 200);
  assert.deepEqual((await capabilities.json()).providers, ["claude", "chatgpt", "pi"]);
});
