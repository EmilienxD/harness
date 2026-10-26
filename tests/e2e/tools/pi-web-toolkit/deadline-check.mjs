// The installed extension and real uvx child run unchanged; only the deadline clock is controlled.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [packageRoot, extensionPath] = process.argv.slice(2);
const { loadExtensions } = await import(pathToFileURL(join(packageRoot, "dist/core/extensions/loader.js")).href);
const loaded = await loadExtensions([extensionPath], process.cwd());
assert.deepEqual(loaded.errors, []);
const tool = loaded.extensions[0].tools.get("web_fetch").definition;
let started;
let disconnected;
const requestStarted = new Promise(resolve => { started = resolve; });
const requestClosed = new Promise(resolve => { disconnected = resolve; });
const server = createServer((req, res) => {
  if (req.url === "/output") {
    res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
    res.end("# Large fixture\n\n" + Array.from({ length: 20 }, () => `## ${"雪".repeat(20_000)}\n\n`).join(""));
    return;
  }
  res.on("close", disconnected); started();
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const timeout = globalThis.setTimeout;
const controller = new AbortController();
let pending;
let fireDeadline;
globalThis.setTimeout = (callback, delay, ...args) => {
  if (delay === 120_000) fireDeadline = () => callback(...args);
  return timeout(callback, delay, ...args);
};
try {
  pending = tool.execute("deadline-check", { url: `http://127.0.0.1:${server.address().port}/slow` }, controller.signal, undefined, { cwd: process.cwd() });
  const failure = assert.rejects(pending, /120-second deadline/u);
  await Promise.race([requestStarted, new Promise((_, reject) => timeout(() => reject(new Error("Deadline fixture request did not start")), 15_000).unref())]);
  assert.equal(typeof fireDeadline, "function");
  fireDeadline();
  await failure;
  await Promise.race([requestClosed, new Promise((_, reject) => timeout(() => reject(new Error("Deadline left the HTTP child alive")), 5_000).unref())]);
  await assert.rejects(tool.execute("output-check", { url: `http://127.0.0.1:${server.address().port}/output` }, controller.signal, undefined, { cwd: process.cwd() }), /256 KiB/u);
} finally {
  globalThis.setTimeout = timeout;
  controller.abort();
  await pending?.catch(() => {});
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
