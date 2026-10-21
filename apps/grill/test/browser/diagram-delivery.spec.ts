import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";

test("installed Claude, Codex and Pi receive authenticated snapshot images with and without Aboard", async ({
  request,
}, info) => {
  expect((await request.get("/api/v1/capabilities", { headers: { Authorization: "Bearer 1234" } })).status()).toBe(200);
  test.skip(info.project.name !== "desktop", "CLI receipt effects are viewport independent");
  test.setTimeout(360_000);
  const run = await promisify(execFile)("npm.cmd", ["run", "e2e:grill-images"], {
    cwd: resolve("../../tests/e2e"),
    windowsHide: true,
    timeout: 330_000,
    shell: process.platform === "win32",
    maxBuffer: 1024 * 1024,
  });
  const results = run.stdout
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line));
  expect(results).toHaveLength(6);
  expect(
    results.map((result) => [result.platform, result.route, result.verifiedImages, result.unexpectedRequests]),
  ).toEqual([
    ["claude", "copy", 1, 0],
    ["claude", "aboard", 1, 0],
    ["chatgpt", "copy", 1, 0],
    ["chatgpt", "aboard", 1, 0],
    ["pi", "copy", 1, 0],
    ["pi", "aboard", 1, 0],
  ]);
});
