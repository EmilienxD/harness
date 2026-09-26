import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { access, readFile, readdir, rm } from "node:fs/promises";
import { delimiter, join } from "node:path";

import { commands, extensions, window, workspace } from "vscode";

import type { AgentId, AgentSession, IsoTimestamp, SessionId, TerminalId } from "../../../src/domain/contracts.js";
import { FleetRegistry } from "../../../src/domain/fleet.js";
import { WriteLease } from "../../../src/domain/lease.js";
import { FleetTreeModel } from "../../../src/vscode/fleet.js";
import { createVsCodeTerminalHost } from "../../../src/vscode/terminals.js";

interface CommandEndpoint { readonly port: number; readonly workspaceRoot: string; readonly commandToken: string; readonly pid: number }
interface AboardApi { readonly commandEndpointDirectory: string }

function onPath(command: string): boolean {
  const suffixes = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE").split(";") : [""];
  return (process.env.PATH ?? "").split(delimiter).some(
    (directory) => directory.length > 0 && suffixes.some((suffix) => existsSync(join(directory, `${command}${suffix}`))),
  );
}

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

  // Keep native UI integration focused on the new row contract. The model is
  // the registered TreeDataProvider's source; VS Code hosts this assertion so
  // bundling and extension-host execution are covered as well as pure mapping.
  const at = "2026-08-30T10:00:00.000Z" as IsoTimestamp;
  const agentId = "interactive-ui" as AgentId;
  const fleet = new FleetRegistry();
  const session: AgentSession = {
    platform: "claude",
    identity: { agentId, type: "interactive" },
    sessionId: "session-interactive-ui" as SessionId,
    sessionBinding: "bound",
    terminal: { terminalId: "terminal-interactive-ui" as TerminalId, name: "interactive" },
    lifecycle: { status: "starting", startedAt: at },
    resultDelivery: { mode: "none" },
    attended: true,
    telemetry: { totalTokens: 0, totalDurationMs: 0, totalToolUseCount: 0, compactionCount: 0 },
  };
  fleet.register(session, at);
  fleet.transition(agentId, { status: "running", startedAt: at }, at);
  const fleetModel = new FleetTreeModel(fleet, new WriteLease(), { refresh: () => {} }, () => true);
  const row = fleetModel.roots().find((node) => node.kind === "agent" && node.session.identity.agentId === agentId);
  assert.ok(row, "the interactive session has an Agents row");
  assert.equal(fleetModel.item(row).description, "Claude · running");
  assert.equal(fleetModel.item(row).icon, "eye");
  fleetModel.dispose();

  const available = await commands.getCommands(true);
  for (const command of [
    "aboard.focusFleet", "aboard.focusAgent", "aboard.watchAgent", "aboard.killAgent", "aboard.initializeProject", "aboard.updateProject", "aboard.reopenSession",
    "aboard.startAutoRun", "aboard.resumeAutoRun", "aboard.discardAutoRun", "aboard.autoRun.refresh",
    "aboard.autoRun.openCurrentIssue", "aboard.autoRun.openPullRequest", "aboard.openIssue", "aboard.openPullRequest",
    "aboard.activity.reopen", "aboard.activity.clear", "aboard.clearBranches",
  ]) {
    assert.ok(available.includes(command), `${command} is registered`);
  }
  for (const removed of ["aboard.removePausedSession", "aboard.restoreFleet"]) {
    assert.equal(available.includes(removed), false, `${removed} was removed`);
  }

  const root = workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert.ok(root, "integration workspace is open");

  // Exercise the actual VS Code title handling: a fake host accepting a
  // proposed option does not prove that packaged extensions can use it.
  const title = "Claude Code: aboard terminal test";
  const titleTerminals = new Set(window.terminals);
  const titleProbe = createVsCodeTerminalHost().createTerminal({
    cwd: root,
    env: {},
    provider: "claude",
    // pwsh is an optional install; Windows PowerShell ships with the OS and
    // writes the same OSC title sequence, so either one proves the API works.
    shellPath: process.platform === "win32" ? (onPath("pwsh") ? "pwsh" : "powershell.exe") : "/bin/sh",
    shellArgs: process.platform === "win32"
      ? ["-NoLogo", "-NoProfile", "-Command", `[Console]::Write([char]27 + ']0;${title}' + [char]7); Start-Sleep -Seconds 30`]
      : ["-c", `printf '\\033]0;${title}\\007'; sleep 30`],
  });
  try {
    titleProbe.show(true);
    await eventually(
      () => window.terminals.some((terminal) => !titleTerminals.has(terminal) && terminal.name === title),
      "VS Code did not display the process's title through the stable terminal API",
    );
  } finally {
    titleProbe.dispose();
  }

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

  await rm(join(root, ".abd"), { recursive: true, force: true });
  let recordSurvives = true;
  for (let attempt = 0; attempt < 100 && recordSurvives; attempt += 1) {
    const entries = await readdir(api.commandEndpointDirectory).catch(() => []);
    const records = await Promise.all(entries.map(async (entry) => JSON.parse(await readFile(join(api.commandEndpointDirectory, entry), "utf8")) as CommandEndpoint));
    recordSurvives = records.some((candidate) => candidate.workspaceRoot === root);
    if (recordSurvives) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(recordSurvives, false, "deleting .abd clears the published endpoint");
  await assert.rejects(fetch(`http://127.0.0.1:${endpoint.port}/commands`), "deleting .abd stops the bridge");
  await assert.rejects(access(join(root, ".abd")), "reset cannot recreate .abd after bridge shutdown");
}
