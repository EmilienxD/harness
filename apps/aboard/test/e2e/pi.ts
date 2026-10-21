import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { access, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { runFixtureInstaller } from "../../../../tests/e2e/core/installer.js";
import { createPiFixture } from "../../../../tests/e2e/core/pi-fixture.js";
import { createPiToolScenario } from "../../../../tests/e2e/core/pi-scenario.js";
import { spawnableCommand } from "../../../../tests/e2e/core/path.js";
import { summarizePiRun } from "../../../../tests/e2e/core/pi.js";
import { PiAgentPlatform } from "../../src/pi/platform.js";
import { FileSystemPromptSpillStore } from "../../src/platform/spill.js";
import { parseLaunchFile } from "../../src/platform/launch-configuration.js";
import type { AgentId, SessionId } from "../../src/domain/contracts.js";
import type { PlatformLaunchPlan } from "../../src/platform/agent-platform.js";
import { createDelegationRoutes, type ManualDelegationLaunch } from "../../src/bridge/manual-delegation.js";
import type { BridgeRequestHandler } from "../../src/bridge/protocol.js";

/** Exercise the production adapter and assets with real Pi; only inference and the bridge are local fixtures. */
export async function runPiSmoke(): Promise<void> {
  const scenario = createPiToolScenario({ name: "aboard-pi", marker: "ABOARD_PI_JOURNEY", steps: [
    { checkpoint: "deny-owned-git", tool: "bash", input: { command: "git checkout -b forbidden-aboard-pi" }, verifyResult: (result) => assert.match(String(result), /blocked/u) },
    { checkpoint: "write-result", tool: "write", input: { path: "result.txt", content: "aboard Pi complete\n" } },
  ] });
  const nestedScenario = createPiToolScenario({ name: "aboard-pi-nested", marker: "ABOARD_PI_NESTED", steps: [{ checkpoint: "deny-nested-write", tool: "probe", input: {} }] });
  let spilledScenario: ReturnType<typeof createPiToolScenario> | undefined;
  const fixture = await createPiFixture({ scenarioCatalogHash: scenario.scenarioCatalogHash, transition: (request) => {
    if (request.input.some((item) => item.role === "user" && JSON.stringify(item.content).includes("ABOARD_PI_SPILLED_SKILL"))) return spilledScenario!.transition(request);
    if (request.input.some((item) => item.role === "user" && JSON.stringify(item.content).includes("ABOARD_PI_NESTED"))) return nestedScenario.transition(request);
    if (request.input.some((item) => item.role === "user" && JSON.stringify(item.content).includes("ABOARD_PI_FAILURE"))) throw new Error("Fixture semantic failure");
    return scenario.transition(request);
  } });
  const observations: { route: string; body: Record<string, unknown> }[] = [];
  let delegations: BridgeRequestHandler | undefined;
  const bridge = createServer(async (request, response) => {
    if (request.headers.authorization !== "Bearer fixture-bridge") { response.writeHead(401).end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
    observations.push({ route: request.url!, body });
    if (request.url === "/delegations" && delegations) {
      const result = await delegations({ method: "POST", url: new URL("http://localhost/delegations"), headers: {}, body, signal: new AbortController().signal });
      response.writeHead(result.status, { "Content-Type": "application/json" }).end(JSON.stringify(result.body));
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, accepted: true, message: "Aboard auto handled" }));
  });
  await new Promise<void>((done) => bridge.listen(0, "127.0.0.1", done));
  const assets = { settings: resolve("assets/runtime/abd_pi.ts"), script: resolve("assets/runtime/abd_hook.py") };
  const platform = new PiAgentPlatform({ lifecycleAssets: assets, commandRunner: async () => ({ code: 0, stdout: "1.2.0", stderr: "" }) });
  const runtime = join(fixture.root, "aboard-runtime");
  const promptRoot = join(fixture.root, "prompts");
  const spills = new FileSystemPromptSpillStore(fixture.workspace.projectRoot, runtime, new Map([["pi", assets]]), { promptRoot });
  const configurations = parseLaunchFile('{"version":1,"autoRun":{"provider":"pi"}}').value;
  const sessionId = randomUUID() as SessionId;
  const common = { agentId: "agent-1" as AgentId, sessionId, shell: "powershell" as const, cwd: fixture.workspace.projectRoot, runtimeDirectory: runtime, promptRoot };
  const execute = async (plan: PlatformLaunchPlan, extra: readonly string[] = [], environment: NodeJS.ProcessEnv = {}, wrapped = false) => {
    await spills.prepare(plan);
    if (plan.spill) await spills.write(plan.spill);
    const args = [...plan.command.slice(1), "--offline", "--approve", ...extra, ...plan.args];
    const native = wrapped
      ? spawnableCommand("uv", ["run", "--no-project", "--no-managed-python", resolve("assets/runtime/abd_wrapper.py"), join(plan.runtimeDirectory, "process.lock"), "--", plan.command[0]!, ...args])
      : spawnableCommand(plan.command[0]!, args);
    return new Promise<{ code: number | null; status: string; createWarning: boolean }>((done, reject) => {
      const child = spawn(native.file, [...native.args], { cwd: fixture.workspace.projectRoot, env: { ...fixture.workspace.env, ...environment, ...plan.providerEnvironment, ABOARD_SESSION_ID: plan.sessionId, ABOARD_AGENT_ID: plan.agentId, ABOARD_AGENT_TYPE: plan.agentType, ABOARD_BRIDGE_PORT: String((bridge.address() as AddressInfo).port), ABOARD_BRIDGE_TOKEN: "fixture-bridge" }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = ""; let stderr = ""; let size = 0;
      const timer = setTimeout(() => { child.kill(); reject(new Error("Aboard Pi journey timed out")); }, 45_000);
      child.stdout.on("data", (data: Buffer) => { size += data.length; if (size > 4 * 1024 * 1024) { child.kill(); reject(new Error("Aboard Pi output bound exceeded")); } else stdout += data.toString(); });
      child.stderr.on("data", (data: Buffer) => { size += data.length; if (size > 4 * 1024 * 1024) { child.kill(); reject(new Error("Aboard Pi output bound exceeded")); } else stderr += data.toString(); });
      child.once("error", () => { clearTimeout(timer); reject(new Error("Aboard Pi failed to start")); });
      child.once("close", (code) => { clearTimeout(timer); const events = stdout.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line)); done({ code, status: summarizePiRun(events).status, createWarning: stderr.includes("No project session found") }); });
    });
  };
  try {
    const plan = platform.planLaunch({ ...common, agentType: "general", executionMode: "auto", configuration: configurations.delegationConfigurationFor("pi", "general").settings, restrictions: { deniedCommands: ["git checkout *"] }, prompt: "ABOARD_PI_JOURNEY" });
    const result = await execute(plan);
    assert.equal(result.code, 0); assert.equal(result.status, "success");
    assert.equal(result.createWarning, false);
    assert.equal(await readFile(join(fixture.workspace.projectRoot, "result.txt"), "utf8"), "aboard Pi complete\n");
    assert.equal(observations.filter((e) => e.route === "/hooks/session-start").length, 1);
    assert.equal(observations.filter((e) => e.route === "/hooks/stop").length, 1);
    assert.equal(observations.filter((e) => e.route === "/hooks/stop-failure").length, 0);
    assert.equal(fixture.assertions().inferenceRequests, 3);
    const nativeSessionId = observations.find((e) => e.route === "/hooks/session-start")!.body.sessionId as SessionId;
    assert.notEqual(nativeSessionId, sessionId);
    const resumed = platform.planSessionResume({ ...common, sessionId: nativeSessionId, agentType: "general", executionMode: "auto", configuration: configurations.delegationConfigurationFor("pi", "general").settings, restrictions: { deniedCommands: ["git checkout *"] }, prompt: "ABOARD_PI_JOURNEY continue" });
    assert.equal((await execute(resumed)).status, "success");
    const forkId = randomUUID() as SessionId;
    const fork = platform.planLaunch({ ...common, sessionId: forkId, forkSessionId: nativeSessionId, agentType: "general", executionMode: "auto", configuration: configurations.delegationConfigurationFor("pi", "general").settings, prompt: "ABOARD_PI_JOURNEY fork" });
    assert.equal((await execute(fork)).status, "success");
    assert.equal(observations.filter((e) => e.route === "/hooks/session-start" && e.body.sessionId === forkId).length, 1);
    const failed = platform.planLaunch({ ...common, agentId: "agent-failed" as AgentId, sessionId: randomUUID() as SessionId, agentType: "general", executionMode: "auto", configuration: configurations.delegationConfigurationFor("pi", "general").settings, prompt: "ABOARD_PI_FAILURE" });
    assert.equal((await execute(failed)).status, "failed");
    assert.equal(observations.filter((e) => e.route === "/hooks/stop-failure" && e.body.agentId === "agent-failed").length, 1);
    assert.equal(observations.filter((e) => e.route === "/hooks/stop" && e.body.agentId === "agent-failed").length, 0);
    const skillRoot = join(fixture.workspace.agentDir, "skills", "aboard-spill");
    await mkdir(skillRoot, { recursive: true });
    await writeFile(join(skillRoot, "SKILL.md"), "---\nname: aboard-spill\ndescription: Fixture spill workflow\ndisable-model-invocation: true\n---\nABOARD_PI_SPILLED_SKILL\nRead the supplied task file before finishing.\n");
    const spilledPlan = platform.planLaunch({ ...common, agentId: "agent-spilled" as AgentId, sessionId: randomUUID() as SessionId, agentType: "general", executionMode: "auto", skill: "aboard-spill", maxInlinePromptChars: 100, configuration: configurations.delegationConfigurationFor("pi", "general").settings, prompt: "Inspect source and finish. ".repeat(400) });
    assert.equal(spilledPlan.promptDelivery, "spilled");
    spilledScenario = createPiToolScenario({ name: "aboard-pi-spilled-skill", marker: "ABOARD_PI_SPILLED_SKILL", steps: [{ checkpoint: "read-spilled-task", tool: "read", input: { path: spilledPlan.spill!.relativePath } }] });
    const beforeSpill = fixture.assertions().inferenceRequests;
    assert.equal((await execute(spilledPlan)).status, "success");
    assert.equal(fixture.assertions().inferenceRequests - beforeSpill, 2);
    const probe = join(fixture.root, "probe.ts");
    await writeFile(probe, `import { Type } from "typebox";\nexport default function(pi) { pi.registerTool({ name: "probe", label: "Probe", description: "Fixture nested tool", parameters: Type.Object({}), execute: async (_id, _input, _signal, _update, ctx) => ({ content: [{type: "text", text: JSON.stringify(await ctx.executeTool("write", {path: "nested-denied.txt", content: "forbidden"}))}], details: undefined }) }); }\n`);
    const nestedBase = platform.planLaunch({ ...common, agentId: "agent-nested" as AgentId, sessionId: randomUUID() as SessionId, agentType: "explore", executionMode: "auto", configuration: configurations.configurationFor("pi", "explore").settings, prompt: "ABOARD_PI_NESTED" });
    const nestedGuard = JSON.parse(nestedBase.guard!.contents) as Record<string, unknown>;
    nestedGuard.allowedTools = ["read", "probe"];
    nestedGuard.readOnly = false;
    const nested = { ...nestedBase, guard: { ...nestedBase.guard!, contents: JSON.stringify(nestedGuard) }, args: nestedBase.args.map((arg) => arg === "read,grep,find,ls" ? "read,probe" : arg) };
    const nestedResult = await execute(nested, ["--extension", probe]);
    assert.equal(nestedResult.status, "success", JSON.stringify({ code: nestedResult.code, assertions: { requests: fixture.assertions().inferenceRequests, checkpoints: fixture.assertions().checkpoints, unexpected: fixture.assertions().unexpectedRequests } }));
    await assert.rejects(access(join(fixture.workspace.projectRoot, "nested-denied.txt")));
    const beforeAuto = fixture.assertions().inferenceRequests;
    const catalogueRoot = join(fixture.root, "catalogue");
    const consumer = join(catalogueRoot, "harness", "fixture", "consumer");
    await mkdir(consumer, { recursive: true });
    await cp(resolve("../../harness/vscode/auto"), join(catalogueRoot, "harness", "vscode", "auto"), { recursive: true });
    await writeFile(join(consumer, "harness.toml"), 'name = "pi-auto-consumer"\nversion = "1.0.0"\ndescription = "Fixture consumer of internal auto"\ndependencies = ["auto>=1.3.0"]\n[platforms.pi]\nstatus = "supported"\n[[files]]\nsrc = "fixture.txt"\ndest = "fixture.txt"\nroot = "support"\n');
    await writeFile(join(consumer, "fixture.txt"), "fixture\n");
    await runFixtureInstaller(fixture.workspace, "install", ["pi-auto-consumer"], { catalogueRoot });
    await assert.rejects(access(join(fixture.workspace.projectRoot, ".pi", "hooks")));
    await assert.rejects(access(join(fixture.workspace.agentDir, "hooks")));
    const auto = platform.planLaunch({ ...common, agentId: "agent-auto" as AgentId, sessionId: randomUUID() as SessionId, agentType: "general", executionMode: "auto", configuration: configurations.delegationConfigurationFor("pi", "general").settings, prompt: "/auto --dry" });
    await execute(auto);
    assert.equal(fixture.assertions().inferenceRequests, beforeAuto);
    assert.equal(observations.filter((e) => e.route === "/hooks/auto").length, 1);
    assert.equal(observations.filter((e) => e.route === "/hooks/prompt-submit" && e.body.agentId === "agent-auto").length, 0);
    // A broken mandatory extension must stop before the first model request.
    const broken = join(fixture.root, "broken.ts");
    await writeFile(broken, "this is invalid TypeScript {");
    const bad = await execute({ ...plan, args: plan.args.map((value) => value.endsWith("abd_pi.ts") ? broken : value) });
    assert.notEqual(bad.code, 0);
    assert.equal(fixture.assertions().inferenceRequests, beforeAuto);
    const missing = await execute({ ...plan, args: plan.args.map((value) => value.endsWith("abd_pi.ts") ? join(fixture.root, "missing.ts") : value) });
    assert.notEqual(missing.code, 0);
    assert.equal(fixture.assertions().inferenceRequests, beforeAuto);
    const unreadable = await execute({ ...plan, guard: { ...plan.guard!, contents: "invalid JSON" } });
    assert.notEqual(unreadable.code, 0);
    assert.equal(fixture.assertions().inferenceRequests, beforeAuto);
    await runFixtureInstaller(fixture.workspace, "uninstall", ["pi-auto-consumer"], { catalogueRoot });
    // The actual Harness request core crosses Aboard's production bridge, then
    // the native extension and process wrapper settle its durable execution.
    const python = resolve("../../.venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
    const runtimeSource = resolve("../../harness/productivity/subagents/runtime/src");
    const parentId = randomUUID();
    const stateDirectory = join(fixture.root, "delegation-state");
    const environment = { ...fixture.workspace.env, PYTHONPATH: runtimeSource, HARNESS_STATE_DIR: stateDirectory,
      UV_PYTHON: python, ABOARD_BRIDGE_PORT: String((bridge.address() as AddressInfo).port), ABOARD_BRIDGE_TOKEN: "fixture-bridge" };
    const runPython = async (script: string) => {
      const result = await promisify(execFile)(python, ["-c", script], { cwd: fixture.workspace.projectRoot, env: environment, windowsHide: true, timeout: 60_000 });
      return JSON.parse(result.stdout) as Record<string, any>;
    };
    let launchedPlan: PlatformLaunchPlan | undefined;
    let launchedEnvironment: NodeJS.ProcessEnv | undefined;
    const launchDelegation = async (request: ManualDelegationLaunch) => {
      const launch = { ...common, agentId: "agent-durable" as AgentId, sessionId: (request.resumeSessionId ?? randomUUID()) as SessionId,
        agentType: "general", executionMode: "auto", configuration: configurations.delegationConfigurationFor("pi", "general").settings,
        restrictions: { deniedCommands: ["git checkout *"] }, prompt: request.prompt } as const;
      const plan = request.resumeSessionId === undefined ? platform.planLaunch(launch) : platform.planSessionResume(launch);
      launchedEnvironment = { ...environment, HARNESS_SESSION_ID: request.harnessSessionId, HARNESS_EXECUTION_ID: request.executionId, HARNESS_EXECUTION_MODE: request.executionMode };
      assert.equal((await execute(plan, [], launchedEnvironment, true)).status, "success");
      const canonical = observations.filter((event) => event.route === "/hooks/session-start" && event.body.agentId === plan.agentId).at(-1)!.body.sessionId as SessionId;
      launchedPlan = platform.planSessionResume({ ...launch, sessionId: canonical });
      return { agentId: plan.agentId, sessionId: canonical, terminalId: "durable-process" };
    };
    delegations = createDelegationRoutes({ launch: launchDelegation, resume: launchDelegation }, { workspaceRoot: fixture.workspace.projectRoot, stateDirectory: join(fixture.root, "bindings") });
    const beforeDelegation = fixture.assertions().inferenceRequests;
    const durable = await runPython([
      "import json", "from pathlib import Path", "from subagents_runtime import sessions",
      "from subagents_runtime.delegation import ensure_inbox,process_inbox,claim_parent_delivery,acknowledge_parent_delivery",
      `parent=${JSON.stringify(parentId)}`, "sessions.register_observed(parent,Path.cwd(),'pi')", "inbox=ensure_inbox(parent).inbox",
      "(inbox/'request.md').write_text('---\\ntask: general\\nprovider: pi\\nmode: auto\\n---\\nABOARD_PI_JOURNEY',encoding='utf-8')",
      "results=process_inbox(parent,launch=sessions.launch_delegated)",
      "with sessions._connect() as db:",
      " row=db.execute('SELECT r.state,r.child_session_id,s.provider_session_id,r.reply,e.state FROM requests r JOIN sessions s ON s.id=r.child_session_id JOIN executions e ON e.request_id=r.id').fetchone()",
      "delivery=claim_parent_delivery(parent,'Stop')", "assert delivery is not None", "acknowledge_parent_delivery(parent,delivery.delivery_id)",
      "assert claim_parent_delivery(parent,'Stop') is None",
      "print(json.dumps({'launches':[r.status for r in results],'request':list(row)}))",
    ].join("\n"));
    assert.deepEqual(durable.launches, ["launched"]);
    assert.equal(durable.request[0], "succeeded");
    assert.notEqual(durable.request[1], durable.request[2]);
    assert.equal(durable.request[2], launchedPlan!.sessionId);
    assert.equal(durable.request[4], "exited");
    assert.equal(fixture.assertions().inferenceRequests - beforeDelegation, 3);
    assert.equal(await readFile(join(fixture.workspace.projectRoot, "result.txt"), "utf8"), "aboard Pi complete\n");
    // A late duplicate native Stop cannot redeliver an acknowledged request.
    await execute(launchedPlan!, [], launchedEnvironment!, true);
    const replay = await runPython([
      "import json", "from subagents_runtime.delegation import claim_parent_delivery",
      `assert claim_parent_delivery(${JSON.stringify(parentId)},'Stop') is None`, "print(json.dumps({'redelivered':False}))",
    ].join("\n"));
    assert.equal(replay.redelivered, false);
    const beforeResume = fixture.assertions().inferenceRequests;
    const resumedDelegation = await runPython([
      "import json,os", "from subagents_runtime import sessions", "from subagents_runtime.delegation import claim_parent_delivery,acknowledge_parent_delivery",
      `child=${JSON.stringify(durable.request[1])}`, "os.environ['HARNESS_SESSION_ID']='unrelated-parent'",
      "try:", " sessions.resume(child,'ABOARD_PI_JOURNEY continue')", " raise AssertionError('foreign parent resumed a child')",
      "except sessions.SessionError:", " pass",
      `os.environ['HARNESS_SESSION_ID']=${JSON.stringify(parentId)}`, "sessions.resume(child,'ABOARD_PI_JOURNEY continue')",
      "with sessions._connect() as db:",
      " rows=db.execute('SELECT r.state,r.child_session_id,s.provider_session_id FROM requests r JOIN sessions s ON s.id=r.child_session_id ORDER BY r.rowid').fetchall()",
      `delivery=claim_parent_delivery(${JSON.stringify(parentId)},'Stop')`, "assert delivery is not None",
      `acknowledge_parent_delivery(${JSON.stringify(parentId)},delivery.delivery_id)`,
      "print(json.dumps({'requests':[list(r) for r in rows]}))",
    ].join("\n"));
    assert.deepEqual(resumedDelegation.requests, [["succeeded", durable.request[1], durable.request[2]], ["succeeded", durable.request[1], durable.request[2]]]);
    assert.equal(fixture.assertions().inferenceRequests - beforeResume, 1);
    // A one-shot process closes the interactive child after its first unarmed
    // answer, exercising wrapper cancellation through the same native events.
    const unarmed = await runPython([
      "import json", "from subagents_runtime import sessions", "from subagents_runtime.delegation import ensure_inbox,process_inbox",
      `parent=${JSON.stringify(parentId)}`, "inbox=ensure_inbox(parent).inbox",
      "(inbox/'interactive.md').write_text('---\\ntask: general\\nprovider: pi\\nmode: interactive\\n---\\nABOARD_PI_JOURNEY',encoding='utf-8')",
      "results=process_inbox(parent,launch=sessions.launch_delegated)",
      "with sessions._connect() as db:", " state=db.execute(\"SELECT state FROM requests WHERE mode='interactive'\").fetchone()[0]",
      "print(json.dumps({'state':state}))",
    ].join("\n"));
    assert.equal(unarmed.state, "cancelled");
  } finally {
    await new Promise<void>((done, reject) => bridge.close((error) => error ? reject(error) : done()));
    await fixture.close();
  }
}
