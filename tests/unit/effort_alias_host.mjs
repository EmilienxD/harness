// node tests/unit/effort_alias_host.mjs <installed Pi package directory> [extension path]
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
const sdk = await import(pathToFileURL(path.join(process.argv[2], "dist/index.js")));
const dir = await mkdtemp(path.join(tmpdir(), "effort-alias-"));
let session;
try {
  const settingsManager = sdk.SettingsManager.inMemory({ defaultThinkingLevel: "low" });
  const loader = new sdk.DefaultResourceLoader({
    cwd: dir, agentDir: dir, settingsManager,
    additionalExtensionPaths: [path.resolve(process.argv[3] ?? "harness/productivity/effort-alias/pi/extension.ts")],
    noSkills: true, noPromptTemplates: true, noThemes: true,
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  ({ session } = await sdk.createAgentSession({ cwd: dir, agentDir: dir, settingsManager,
    resourceLoader: loader, sessionManager: sdk.SessionManager.inMemory(dir) }));
  session.agent.state.model = { ...session.model, id: "test-model", provider: "openai", reasoning: true };
  let requests = 0;
  session.subscribe((e) => { if (e.type === "agent_start") requests++; });
  let selection;
  let choices;
  const notifications = [];
  await session.bindExtensions({ mode: "interactive", uiContext: {
    select: async (_title, items) => { choices = items; return selection; },
    notify: (message, type) => notifications.push({ message, type }),
  }, onError: (error) => { throw error; } });
  await session.prompt("/effort HIGH");
  assert.equal(session.thinkingLevel, "high");
  await session.prompt("/effort invalid");
  assert.equal(session.thinkingLevel, "high");
  assert.equal(notifications.at(-1).type, "error");
  selection = "low";
  await session.prompt("/effort");
  assert(choices.includes("low"));
  assert.equal(session.thinkingLevel, "low");
  selection = undefined;
  await session.prompt("/effort");
  assert.equal(session.thinkingLevel, "low");
  session.agent.state.model = { ...session.model, reasoning: false };
  await session.prompt("/effort high");
  assert.equal(notifications.at(-1).type, "error");
  await session.prompt("/effort off");
  assert.equal(session.thinkingLevel, "off");
  assert.equal(settingsManager.getDefaultThinkingLevel(), "low");
  assert.equal(requests, 0);
  console.log("PASS: real Pi loader/session: direct levels, picker, cancellation, invalid and unsupported levels, unchanged defaults, zero inference");
} finally {
  session?.dispose();
  await rm(dir, { recursive: true, force: true });
}
