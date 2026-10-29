// node tests/unit/turn_timer_host.mjs <installed Pi package directory>
// Real loader and session event dispatch; no provider requests or terminal rendering.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const sdk = await import(pathToFileURL(path.join(process.argv[2], "dist/index.js")));
const dir = await mkdtemp(path.join(tmpdir(), "turn-timer-"));
const settings = sdk.SettingsManager.inMemory({});
const loader = new sdk.DefaultResourceLoader({
  cwd: dir, agentDir: dir, settingsManager: settings,
  additionalExtensionPaths: [path.resolve("harness/productivity/turn-timer/pi/extension.ts")],
  noSkills: true, noPromptTemplates: true, noThemes: true,
});
let session;
try {
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  ({ session } = await sdk.createAgentSession({
    cwd: dir, agentDir: dir, settingsManager: settings, resourceLoader: loader,
    sessionManager: sdk.SessionManager.inMemory(dir),
  }));
  const labels = [];
  const errors = [];
  await session.bindExtensions({
    mode: "interactive",
    uiContext: { setWorkingMessage: (message) => labels.push(message) },
    onError: (error) => errors.push(error),
  });
  const runner = session.extensionRunner;
  await runner.emitInput("hello", undefined, "interactive");
  await runner.emit({ type: "agent_start" });
  assert.equal(labels.at(-1), "Working · 0m 00s");
  await new Promise((resolve) => setTimeout(resolve, 1150));
  assert.match(labels.at(-1), /^Working · 0m 0[1-9]s$/);
  await runner.emitInput("steering", undefined, "interactive", "steer");
  assert.equal(labels.at(-1), "Working · 0m 00s");
  await runner.emit({ type: "agent_settled", outcome: "completed" });
  assert.equal(labels.at(-1), undefined);
  const count = labels.length;
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(labels.length, count);
  assert.deepEqual(errors, []);
  console.log("Pi loader/session timer lifecycle passed (no inference).");
} finally {
  await session?.extensionRunner?.emit({ type: "session_shutdown" });
  session?.dispose();
  await rm(dir, { recursive: true, force: true });
}
