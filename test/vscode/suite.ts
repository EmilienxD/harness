import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { commands, extensions, window, workspace } from "vscode";

interface Discovery { readonly port: number; readonly token: string }
interface CommandEndpoint { readonly port: number; readonly workspaceRoot: string; readonly commandToken: string; readonly pid: number }
interface AboardApi { readonly bridgeDiscoveryPath: string; readonly commandEndpointDirectory: string }

async function eventually(check: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

export async function run(): Promise<void> {
  const extension = extensions.getExtension("aboard.aboard");
  assert.ok(extension, "aboard extension is discoverable");
  const api = await extension.activate() as AboardApi | undefined;
  assert.equal(extension.isActive, true);
  assert.ok(api?.bridgeDiscoveryPath, "activation exposes the bridge discovery path");

  const available = await commands.getCommands(true);
  for (const command of ["aboard.focusFleet", "aboard.focusAgent", "aboard.killAgent", "aboard.removePausedSession", "aboard.initializeProject", "aboard.updateProject", "aboard.restoreFleet", "aboard.reopenSession"]) {
    assert.ok(available.includes(command), `${command} is registered`);
  }

  const root = workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert.ok(root, "integration workspace is open");
  // The discovery file carries the bearer token and must stay out of the project.
  assert.equal(api.bridgeDiscoveryPath.startsWith(root), false, "discovery file is written outside the workspace");
  await assert.rejects(readFile(join(root, ".aboard", "runtime", "bridge.json")), "no bridge file is written into the project");
  const discovery = JSON.parse(await readFile(api.bridgeDiscoveryPath, "utf8")) as Discovery;
  const existingTerminals = new Set(window.terminals);
  const response = await fetch(`http://127.0.0.1:${discovery.port}/terminals`, {
    method: "POST",
    headers: { authorization: `Bearer ${discovery.token}`, "content-type": "application/json" },
    body: JSON.stringify({ agentId: "integration-worker", sessionId: "4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee", agentType: "brainstormer" }),
  });
  const responseBody = await response.text();
  assert.equal(response.status, 201, responseBody);
  let createdTerminal = window.terminals.find((terminal) => !existingTerminals.has(terminal));
  await eventually(() => {
    createdTerminal = window.terminals.find((terminal) => !existingTerminals.has(terminal));
    return createdTerminal !== undefined;
  }, "terminal was not created");
  await commands.executeCommand("aboard.focusAgent", "integration-worker");
  assert.equal(window.activeTerminal, createdTerminal);
  createdTerminal?.dispose();
  await eventually(() => createdTerminal !== undefined && !window.terminals.includes(createdTerminal), "terminal was not closed");

  // The whole path a standalone setup script takes: find the published record
  // for this project, then run a command in a visible terminal with it.
  assert.equal(api.commandEndpointDirectory.startsWith(root), false, "the command endpoint is published outside the workspace");
  const published = await Promise.all((await readdir(api.commandEndpointDirectory))
    .map(async (entry) => JSON.parse(await readFile(join(api.commandEndpointDirectory, entry), "utf8")) as CommandEndpoint));
  const endpoint = published.find((candidate) => root.startsWith(candidate.workspaceRoot));
  assert.ok(endpoint, "this window published a command endpoint record");
  assert.equal(endpoint.port, discovery.port);
  assert.notEqual(endpoint.commandToken, discovery.token, "the published token is the scoped one");

  const beforeCommand = new Set(window.terminals);
  const commandResponse = await fetch(`http://127.0.0.1:${endpoint.port}/commands`, {
    method: "POST",
    headers: { authorization: `Bearer ${endpoint.commandToken}`, "content-type": "application/json" },
    body: JSON.stringify({ command: "echo aboard", name: "integration setup" }),
  });
  assert.equal(commandResponse.status, 201, await commandResponse.text());
  let commandTerminal: typeof window.terminals[number] | undefined;
  await eventually(() => {
    commandTerminal = window.terminals.find((terminal) => !beforeCommand.has(terminal));
    return commandTerminal !== undefined;
  }, "command terminal was not created");
  assert.equal(commandTerminal?.name, "integration setup");
  commandTerminal?.dispose();

  // The published token stops at the command endpoint.
  const refused = await fetch(`http://127.0.0.1:${endpoint.port}/terminals`, {
    headers: { authorization: `Bearer ${endpoint.commandToken}` },
  });
  assert.equal(refused.status, 403);
}
