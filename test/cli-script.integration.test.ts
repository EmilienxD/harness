import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import test from "node:test";

import { createCliHandler } from "../src/bridge/cli.js";
import { startBridge, type BridgeRuntime } from "../src/bridge/server.js";
import type { BridgeDiscoveryPersistence } from "../src/bridge/discovery.js";
import type { AgentId } from "../src/domain/contracts.js";

const CLI = join(process.cwd(), "assets", "scaffold", ".aboard", "scripts", "aboard_cli.py");
const MANAGER = "manager-1" as AgentId;
const persistence: BridgeDiscoveryPersistence = { write: async () => undefined, clear: async () => undefined };

interface Call { readonly type: string; readonly description: string; readonly prompt?: string }

interface Outcome { readonly status: number | null; readonly stdout: string; readonly stderr: string }

/**
 * The real script, in a real child process. It must be spawned asynchronously:
 * the bridge it talks to runs in *this* process, so a synchronous spawn would
 * block the event loop that has to answer the request and deadlock the test.
 */
function run(
  args: readonly string[],
  options: { readonly input?: string; readonly env?: Readonly<Record<string, string>> } = {},
): Promise<Outcome> {
  const child = spawn("uv", ["run", "--no-project", "python", CLI, ...args], {
    env: { ...process.env, ...options.env },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  child.stdin.end(options.input ?? "");
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });
}

/** Environment for a session aboard launched, as the terminal controller sets it. */
function launched(bridge: BridgeRuntime, agentId: string = MANAGER): Record<string, string> {
  return {
    ABOARD_BRIDGE_PORT: String(bridge.port),
    ABOARD_BRIDGE_TOKEN: bridge.token,
    ABOARD_AGENT_ID: agentId,
  };
}

async function bridgeWith(calls: Call[], todo: unknown[]): Promise<BridgeRuntime> {
  return startBridge({
    preferredPort: 0,
    persistence,
    tokenFactory: () => "integration-token",
    handler: createCliHandler(
      {
        run: async (input) => {
          calls.push({ type: input.type, description: input.description, ...(input.prompt === undefined ? {} : { prompt: input.prompt }) });
          return { agentId: "worker-1", result: "reviewed" };
        },
        spawn: () => { throw new Error("not used"); },
        // `brainstormer` is interactive-only, so a launch that omits
        // the flag is coerced onto this path rather than refused.
        spawnInteractive: async (input) => {
          calls.push({ type: input.type, description: input.description, ...(input.prompt === undefined ? {} : { prompt: input.prompt }) });
          return { agentId: "worker-1", handoff: "Terminal focused." };
        },
        releaseLease: () => ({ released: false }),
      },
      {
        managerAgentId: MANAGER,
        services: {
          github: {
            createRoadmapTasks: async (input: unknown) => { todo.push(["create", input]); return { issue: 4, ids: ["a3f9"], notices: [] }; },
            updateRoadmapTask: async (input: unknown) => { todo.push(["update", input]); return { issue: 4, task: "a3f9", notices: [] }; },
          } as never,
        },
      },
    ),
  });
}

test("the shipped CLI reaches the bridge, and only from the Manager", async (context) => {
  const calls: Call[] = [];
  const todo: unknown[] = [];
  const bridge = await bridgeWith(calls, todo);
  context.after(() => bridge.stop());

  // A session that aboard did not start has no bridge address at all, so the
  // script refuses before it can reach the network.
  const unlaunched = await run(["auto"], { env: { ABOARD_BRIDGE_PORT: "", ABOARD_BRIDGE_TOKEN: "", ABOARD_AGENT_ID: "" } });
  assert.equal(unlaunched.status, 1);
  assert.match(unlaunched.stderr, /not started by the aboard extension/);

  // A worker that found the script still cannot orchestrate with it.
  const worker = await run(["agent", "--type", "general-purpose", "--description", "open general purpose session", "--interactive"], { env: launched(bridge, "worker-9") });
  assert.equal(worker.status, 1);
  assert.match(worker.stderr, /Only the aboard Manager session/);
  assert.deepEqual(calls, []);

  // A refusal from the bridge is surfaced verbatim rather than as a status code.
  const invalid = await run(["agent", "--type", "Explore", "--description", "map the auth flow"], { env: launched(bridge) });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /--prompt is required unless --interactive/);

  const started = await run(
    ["agent", "--type", "brainstormer", "--description", "brainstorm the current changes", "--prompt", "The current changes"],
    { env: launched(bridge) },
  );
  assert.equal(started.status, 0, started.stderr);
  assert.match(started.stdout, /worker-1/);
  assert.deepEqual(calls, [{ type: "brainstormer", description: "brainstorm the current changes", prompt: "The current changes" }]);

  // Repeated `--subject` is what makes a bootstrap one spawn and one issue
  // revision instead of twenty of each, and subjects routinely carry the
  // backticks and apostrophes that make quoting worth pinning down.
  const written = await run(
    ["todo", "create", "--subject", "Replace the `ai:todo` locator", "--subject", "Don't lose the tail", "--after", "top"],
    { env: launched(bridge) },
  );
  assert.equal(written.status, 0, written.stderr);
  assert.match(written.stdout, /a3f9/);

  const edited = await run(["todo", "update", "--task", "a3f9", "--status", "completed"], { env: launched(bridge) });
  assert.equal(edited.status, 0, edited.stderr);
  assert.deepEqual(todo, [
    ["create", { subjects: ["Replace the `ai:todo` locator", "Don't lose the tail"], after: "top" }],
    ["update", { task: "a3f9", status: "completed" }],
  ]);

  // `todo` alone is not a command: the verb decides which route is called, so
  // omitting it must fail locally rather than post an ambiguous body.
  assert.notEqual((await run(["todo", "--subject", "no verb"], { env: launched(bridge) })).status, 0);
});

test("the CLI documents its own commands", async () => {
  const help = await run(["--help"]);
  assert.equal(help.status, 0);
  for (const command of ["agent", "todo", "auto", "review", "release-lease"]) {
    assert.match(help.stdout, new RegExp(command));
  }
  const todoHelp = await run(["todo", "--help"]);
  assert.equal(todoHelp.status, 0);
  for (const verb of ["create", "update"]) assert.match(todoHelp.stdout, new RegExp(verb));
  // A command the extension owns must not be reachable by guessing a name.
  assert.notEqual((await run(["implement"])).status, 0);
});
