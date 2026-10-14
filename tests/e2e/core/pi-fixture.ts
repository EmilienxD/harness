import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startFakeOpenAiServer } from "./openai-server.js";
import { containsPath } from "./path.js";
import { PiRpcClient, preparePiWorkspace, runPiJson, validatePiCli } from "./pi.js";

/** Each journey owns an external project, agent directory, home, server, and sessions. */
export async function createPiFixture(options: Parameters<typeof startFakeOpenAiServer>[0]) {
  const root = await mkdtemp(join(tmpdir(), "harness-pi-e2e-"));
  let server: Awaited<ReturnType<typeof startFakeOpenAiServer>> | undefined;
  const clients = new Set<PiRpcClient>();
  try {
    server = await startFakeOpenAiServer({ ...options, diagnosticsPath: join(root, "structural-diagnostics.json") });
    const workspace = await preparePiWorkspace(root, server.baseUrl, server.authToken);
    const version = await validatePiCli(workspace);
    const endpoint = server;
    return {
      root, workspace, version,
      assertions: endpoint.assertions,
      runJson: (input: Parameters<typeof runPiJson>[1]) => runPiJson(workspace, input),
      rpc: (input: ConstructorParameters<typeof PiRpcClient>[1] = {}) => { const client = new PiRpcClient(workspace, input); clients.add(client); return client; },
      close: async () => {
        try { await Promise.all([...clients].map((client) => client.close())); }
        finally {
          try { await endpoint.close(); }
          finally {
            await removeFixture(root);
          }
        }
      },
    };
  } catch (error) {
    await server?.close();
    await removeFixture(root);
    throw error;
  }
}

async function removeFixture(root: string): Promise<void> {
  if (!containsPath(tmpdir(), root) || root === tmpdir()) throw new Error("Pi fixture cleanup escaped its temporary root");
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
