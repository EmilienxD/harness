// Run with node tests/unit/exclude_unwanted_tools_host.mjs <installed pi package directory>.
// Isolated real Pi loader/session registry; no inference or personal configuration.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const root = process.argv[2];
const sdk = await import(pathToFileURL(path.join(root, "dist/index.js")));
const require = createRequire(path.join(root, "package.json"));
const { Type } = await import(pathToFileURL(require.resolve("typebox")));
const dir = await mkdtemp(path.join(tmpdir(), "exclude-unwanted-tools-"));
const agentDir = path.join(dir, "agent");
await mkdir(agentDir);
const settings = sdk.SettingsManager.inMemory({});
const loader = new sdk.DefaultResourceLoader({
  cwd: dir, agentDir, settingsManager: settings,
  additionalExtensionPaths: [path.resolve("harness/guards/exclude-unwanted-tools/pi/extension.ts")],
  noSkills: true, noPromptTemplates: true, noThemes: true,
});
const excluded = ["powershell", "codemode", "find", "grep", "ls"];
const probe = (name) => ({
  name, label: name, description: "Registry probe, never executed.", parameters: Type.Object({}),
  execute: async () => { throw new Error("Registry checks must not execute tools"); },
});
let session;
try {
  const original = sdk.AgentSession.prototype._isAllowedTool;
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const patched = sdk.AgentSession.prototype._isAllowedTool;
  assert.notEqual(patched, original);
  // The wrapper preserves the original receiver and CLI restrictions on other tools.
  const restricted = { _excludedTools: (name) => name === "write" };
  assert.equal(patched.call(restricted, "write"), false);
  assert.equal(patched.call(restricted, "read"), true);
  ({ session } = await sdk.createAgentSession({
    cwd: dir, agentDir, settingsManager: settings, resourceLoader: loader,
    sessionManager: sdk.SessionManager.inMemory(dir),
    customTools: [...excluded, "allowed_probe"].map(probe),
  }));
  await session.bindExtensions({ mode: "rpc" });
  let requests = 0;
  session.subscribe((event) => { if (event.type === "agent_start") requests++; });
  const verify = () => {
    const registered = session.getAllTools().map((tool) => tool.name);
    for (const name of excluded) {
      assert(!registered.includes(name), `${name} must not be registered`);
      assert(!session.getActiveToolNames().includes(name), `${name} must not be active`);
    }
    assert(registered.includes("allowed_probe"));
    for (const name of ["read", "bash", "edit", "write"]) assert(registered.includes(name));
  };
  verify();
  session.setActiveToolsByName([...excluded, "read", "allowed_probe"]);
  verify();
  await session.reload();
  await session.bindExtensions({ mode: "rpc" });
  assert.equal(sdk.AgentSession.prototype._isAllowedTool, patched, "Reload must not stack patches");
  verify();
  assert.equal(requests, 0);
  console.log("PASS: real Pi registry exclusions, extension tools, preserved defaults/CLI restrictions, reactivation, reload, zero inference");
} finally {
  session?.dispose();
  await rm(dir, { recursive: true, force: true });
}
