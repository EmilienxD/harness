import assert from "node:assert/strict";
import { access, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { commands, extensions, window, workspace } from "vscode";

interface CommandEndpoint { readonly port: number; readonly workspaceRoot: string; readonly commandToken: string; readonly pid: number }
interface AboardApi { readonly commandEndpointDirectory: string }

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
  assert.ok(api?.commandEndpointDirectory, "activation exposes the command endpoint directory");

  const available = await commands.getCommands(true);
  for (const command of [
    "aboard.focusFleet", "aboard.focusAgent", "aboard.killAgent", "aboard.initializeProject", "aboard.updateProject", "aboard.reopenSession",
    "aboard.startAutoRun", "aboard.previewAutoRun", "aboard.resumeAutoRun", "aboard.discardAutoRun", "aboard.autoRun.refresh",
    "aboard.autoRun.openCurrentIssue", "aboard.autoRun.openPullRequest", "aboard.openIssue", "aboard.openPullRequest",
    "aboard.activity.reopen", "aboard.activity.clear",
  ]) {
    assert.ok(available.includes(command), `${command} is registered`);
  }
  for (const removed of ["aboard.removePausedSession", "aboard.restoreFleet"]) {
    assert.equal(available.includes(removed), false, `${removed} was removed`);
  }

  const root = workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert.ok(root, "integration workspace is open");
  // Activation is inert before initialization: no bridge or command
  // endpoint is published. Initialize through the same command the UI uses,
  // then wait for the lazily started runtime.
  await commands.executeCommand("aboard.initializeProject");
  await eventually(() => workspace.workspaceFolders !== undefined, "workspace stayed available");

  // The whole path a standalone setup script takes: find the published record
  // for this project, then run a command in a visible terminal with it.
  assert.equal(api.commandEndpointDirectory.startsWith(root), false, "the command endpoint is published outside the workspace");
  let endpoint: CommandEndpoint | undefined;
  for (let attempt = 0; attempt < 100 && endpoint === undefined; attempt += 1) {
    const entries = await readdir(api.commandEndpointDirectory).catch(() => []);
    const published = await Promise.all(entries.map(async (entry) => JSON.parse(await readFile(join(api.commandEndpointDirectory, entry), "utf8")) as CommandEndpoint));
    endpoint = published.find((candidate) => root.startsWith(candidate.workspaceRoot));
    if (endpoint === undefined) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(endpoint, "this window published a command endpoint record");

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

  await rm(join(root, ".aboard"), { recursive: true, force: true });
  let recordSurvives = true;
  for (let attempt = 0; attempt < 100 && recordSurvives; attempt += 1) {
    const entries = await readdir(api.commandEndpointDirectory).catch(() => []);
    const records = await Promise.all(entries.map(async (entry) => JSON.parse(await readFile(join(api.commandEndpointDirectory, entry), "utf8")) as CommandEndpoint));
    recordSurvives = records.some((candidate) => candidate.workspaceRoot === root);
    if (recordSurvives) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(recordSurvives, false, "deleting .aboard clears the published endpoint");
  await assert.rejects(fetch(`http://127.0.0.1:${endpoint.port}/commands`), "deleting .aboard stops the bridge");
  await assert.rejects(access(join(root, ".aboard")), "reset cannot recreate .aboard after bridge shutdown");
}
