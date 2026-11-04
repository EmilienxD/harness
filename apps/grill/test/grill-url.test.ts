import assert from "node:assert/strict";
import test from "node:test";
import { canonicalSessionUrl, DEFAULT_GRILL_URL } from "../src/lib/grill-url.ts";

test("publication links accept a configured origin with a trailing slash", (t) => {
  const previous = process.env["HARNESS_GRILL_URL"];
  t.after(() => {
    if (previous === undefined) delete process.env["HARNESS_GRILL_URL"];
    else process.env["HARNESS_GRILL_URL"] = previous;
  });
  process.env["HARNESS_GRILL_URL"] = "https://harness-green-gamma.vercel.app/";
  assert.equal(
    canonicalSessionUrl("pi", "session", "https://preview.example"),
    "https://harness-green-gamma.vercel.app/?session=pi%3Asession",
  );

  process.env["HARNESS_GRILL_URL"] = "https://harness-green-gamma.vercel.app";
  assert.equal(canonicalSessionUrl("pi", "session"), "https://harness-green-gamma.vercel.app/?session=pi%3Asession");

  for (const invalid of ["https://example.com/path", "https://example.com/?query=1", "https://example.com/#fragment"]) {
    process.env["HARNESS_GRILL_URL"] = invalid;
    assert.throws(() => canonicalSessionUrl("pi", "session"));
  }

  delete process.env["HARNESS_GRILL_URL"];
  assert.equal(
    canonicalSessionUrl("pi", "a/b", "https://request.example"),
    "https://request.example/?session=pi%3Aa%2Fb",
  );
  assert.equal(canonicalSessionUrl("pi", "session"), `${DEFAULT_GRILL_URL}/?session=pi%3Asession`);
});
