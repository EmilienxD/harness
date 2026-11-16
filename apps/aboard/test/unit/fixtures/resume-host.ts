// Isolated real HTTP host for the Python-to-Aboard continuation acceptance test.
import { mkdir, writeFile } from "node:fs/promises";
import { startBridge } from "../../../src/bridge/server.js";
import { createDelegationRoutes, resolveResumeBinding, providerSession } from "../../../src/bridge/manual-delegation.js";

async function main(): Promise<void> {
  const [primary, child, stateDirectory, endpointPath] = process.argv.slice(2) as [string, string, string, string];
  let number = 0;
  const bridge = await startBridge({ preferredPort: 0, handler: createDelegationRoutes({
    launch: async () => { throw new Error("This fixture accepts continuations only"); },
    resume: async (request) => {
      const binding = await resolveResumeBinding(request, undefined, () => `new-host-${++number}`);
      if (binding.resumeAction !== "reopen") throw new Error("Only ended conversations may be adopted");
      const parentNativeSession = await providerSession(stateDirectory, request.parentSessionId!, request);
      await mkdir(stateDirectory, { recursive: true });
      await writeFile(`${stateDirectory}/navigation.json`, JSON.stringify({ parentNativeSession }));
      return { agentId: binding.agentId, sessionId: binding.sessionId, terminalId: `terminal-${number}` };
    },
  }, { workspaceRoot: primary, workspaceRoots: [primary, child], stateDirectory }) });
  await writeFile(endpointPath, JSON.stringify({ version: 2, host: bridge.host, port: bridge.port,
    delegationToken: bridge.delegationToken, workspaceRoot: primary, workspaceRoots: [primary, child], pid: process.pid }), { mode: 0o600 });
}
void main().catch(() => { process.exitCode = 1; });
