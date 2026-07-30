import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { commands, extensions, window, workspace } from "vscode";

interface Discovery { readonly port: number; readonly token: string }

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
  await extension.activate();
  assert.equal(extension.isActive, true);

  const available = await commands.getCommands(true);
  for (const command of ["aboard.focusFleet", "aboard.focusAgent", "aboard.killAgent", "aboard.scaffoldProject"]) {
    assert.ok(available.includes(command), `${command} is registered`);
  }

  const root = workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert.ok(root, "integration workspace is open");
  const discovery = JSON.parse(await readFile(join(root, ".aboard", "runtime", "bridge.json"), "utf8")) as Discovery;
  const response = await fetch(`http://127.0.0.1:${discovery.port}/terminals`, {
    method: "POST",
    headers: { authorization: `Bearer ${discovery.token}`, "content-type": "application/json" },
    body: JSON.stringify({ agentId: "integration-worker", sessionId: "4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee", agentType: "reviewer" }),
  });
  const responseBody = await response.text();
  assert.equal(response.status, 201, responseBody);
  await eventually(() => window.terminals.some((terminal) => terminal.name.includes("reviewer")), "terminal was not created");
  await commands.executeCommand("aboard.focusAgent", "integration-worker");
  assert.match(window.activeTerminal?.name ?? "", /reviewer/);
  window.activeTerminal?.dispose();
  await eventually(() => !window.terminals.some((terminal) => terminal.name.includes("reviewer")), "terminal was not closed");
}
