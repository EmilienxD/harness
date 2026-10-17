import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { access, readFile, readdir, rm } from "node:fs/promises";
import { delimiter, join } from "node:path";

import { TabInputTerminal, TabInputText, TerminalLocation, ThemeIcon, Uri, commands, extensions, window, workspace, type TabGroup, type Terminal } from "vscode";

import type { AgentId, AgentSession, IsoTimestamp, SessionId, TerminalId } from "../../../src/domain/contracts.js";
import { FleetRegistry } from "../../../src/domain/fleet.js";
import { WriteLease } from "../../../src/domain/lease.js";
import { FleetTreeModel } from "../../../src/vscode/fleet.js";
import { initializeAgentLayout, captureEditorPanes, createVsCodeTerminalHost } from "../../../src/vscode/terminals.js";
import { AgentWorkspaceFiles } from "../../../src/runtime/agent-workspace-owner.js";
import { WorkspaceStartup } from "../../../src/runtime/workspace-startup.js";
import { WorkspaceBatchLauncher } from "../../../src/platform/workspace-launcher.js";

interface CommandEndpoint { readonly port: number; readonly workspaceRoot: string; readonly commandToken: string; readonly pid: number }
interface AboardApi { readonly commandEndpointDirectory: string; readonly agentWorkspaceStorageRoot: string }

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

  // VS Code also invokes this suite in the window opened by the handoff below.
  // Observe its startup instead of running source-window layout probes again.
  const childRoot = workspace.workspaceFolders?.[0]?.uri.fsPath;
  const handoff = workspace.workspaceFile && childRoot
    ? await new AgentWorkspaceFiles(api.agentWorkspaceStorageRoot).read(workspace.workspaceFile.fsPath, childRoot)
    : undefined;
  if (handoff) {
    assert.deepEqual(await new WorkspaceStartup(api.agentWorkspaceStorageRoot, handoff).wait(), { started: 2, failed: [], cancelled: 0 });
    await eventually(() => window.tabGroups.all.length === 2 && window.tabGroups.all.every((group) => group.tabs.filter((tab) => tab.input instanceof TabInputTerminal).length === 1), "new workspace must have a shell terminal in each assigned pane");
    return;
  }

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
  for (const removed of ["aboard.removePausedSession", "aboard.restoreFleet", "aboard.runAgentInActivePane", "aboard.resumeRemoteAgent", "aboard.revealRemoteAgent", "aboard.closeRemoteAgent"]) {
    assert.equal(available.includes(removed), false, `${removed} was removed`);
  }

  const root = workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert.ok(root, "integration workspace is open");

  // Native editor groups are the contract: keep open content, preserve user
  // geometry after initialization, and never resurrect a removed preset pane.
  const document = await workspace.openTextDocument({ content: "Keep this editor open", language: "plaintext" });
  await window.showTextDocument(document);
  for (const [columns, rows] of [[1, 2], [2, 1], [4, 2], [2, 2], [1, 1]]) {
    await initializeAgentLayout(columns!, rows!);
    await eventually(() => window.tabGroups.all.length === columns! * rows!, "initial agent layout did not create the requested pane count");
    assert.ok(window.tabGroups.all.some((group) => group.tabs.some((tab) => tab.input instanceof TabInputText && tab.input.uri.toString() === document.uri.toString())), "layout preserves the existing editor");
  }
  const nativeHost = createVsCodeTerminalHost();
  const placementOptions = { cwd: root, env: {}, provider: "claude" as const };
  const placementProbes: ReturnType<typeof nativeHost.createTerminal>[] = [];
  const terminalCount = (group: typeof window.tabGroups.all[number]) => group.tabs.filter((tab) => tab.input instanceof TabInputTerminal).length;

  // Current-window layout launches must apply the grid and distribute tabs,
  // preserving existing content and leaving later user rearrangements alone.
  const terminalsBeforeProbe = new Set(window.terminals);
  const layoutTerminals: ReturnType<typeof nativeHost.createTerminal>[] = [];
  const existingTerminal = nativeHost.createTerminal({ cwd: root, env: {}, editorPane: window.tabGroups.activeTabGroup });
  await existingTerminal.processId;
  await eventually(() => window.tabGroups.all.some((group) => terminalCount(group) === 1), "the existing terminal did not open");
  const terminalsBeforeLayout = new Set(window.terminals);
  const currentLauncher = new WorkspaceBatchLauncher({
    providers: [], initialized: () => true,
    markInitialized: async () => assert.fail("a current-window launch does not replay startup"),
    initializeLayout: initializeAgentLayout,
    launch: async (_provider, editorPane, onCreated) => {
      const terminal = nativeHost.createTerminal({ cwd: root, env: {}, editorPane: editorPane! });
      layoutTerminals.push(terminal); onCreated();
      return { terminalId: String(layoutTerminals.length) };
    },
    focus: () => {},
  });
  try {
    assert.deepEqual(await currentLauncher.launchCurrent({ preset: { id: "current-grid", name: "Current grid", columns: 2, rows: 2, panes: [{ providers: ["", ""] }, { providers: [""] }, { providers: [""] }, { providers: [""] }] }, empty: false }), { started: 5, failed: [], cancelled: 0 });
    await eventually(() => window.tabGroups.all.length === 4 && window.tabGroups.all.every((group) => terminalCount(group) > 0), "Current window did not put terminals in all four preset panes");
    const totalTerminals = window.tabGroups.all.reduce((count, group) => count + terminalCount(group), 0);
    assert.equal(totalTerminals, 6, "five preset tabs are added while the existing terminal stays open");
    assert.ok([...terminalsBeforeLayout].every((terminal) => window.terminals.includes(terminal)), "existing terminals stay open");
    assert.ok(window.tabGroups.all.some((group) => group.tabs.some((tab) => tab.input instanceof TabInputText && tab.input.uri.toString() === document.uri.toString())), "current-window layout keeps the existing editor open");
    assert.ok(terminalCount(window.tabGroups.all[0]!) >= 2, "the two tabs assigned to pane 1 share that pane");
  } finally {
    for (const terminal of window.terminals) if (!terminalsBeforeProbe.has(terminal)) {
      terminal.dispose();
      await eventually(() => !window.terminals.includes(terminal), "a layout terminal did not close");
    }
  }
  await eventually(() => window.tabGroups.all.every((group) => terminalCount(group) === 0), "layout probes did not close");

  // A delegated child joins its parent's group as a tab while the user works elsewhere.
  await initializeAgentLayout(2, 1);
  await eventually(() => window.tabGroups.all.length === 2, "the family layout did not create two panes");
  const [workPane, parentPane] = captureEditorPanes() as [TabGroup, TabGroup];
  const familyTerminals: Terminal[] = [];
  try {
    const parent = nativeHost.createTerminal({ ...placementOptions, editorPane: parentPane }) as Terminal;
    const sibling = nativeHost.createTerminal({ ...placementOptions, editorPane: parentPane }) as Terminal;
    familyTerminals.push(parent, sibling);
    const other = nativeHost.createTerminal({ ...placementOptions, editorPane: workPane }) as Terminal;
    familyTerminals.push(other);
    await eventually(() => terminalCount(parentPane) === 2 && terminalCount(workPane) === 1, `family terminals did not open in their panes: ${window.tabGroups.all.map(terminalCount).join("/")}`);
    other.show(false);
    await eventually(() => window.activeTerminal === other && window.tabGroups.activeTabGroup === workPane, "the user's terminal did not take focus");
    const located = await nativeHost.editorPaneOf!(parent);
    assert.equal(located, parentPane, "a background parent tab in another group is located");
    familyTerminals.push(nativeHost.createTerminal({ ...placementOptions, editorPane: located }) as Terminal);
    await eventually(() => terminalCount(parentPane) === 3, "the child did not open as a tab in its parent's group");
    assert.equal(terminalCount(workPane), 1, "the group the user worked in gains no child");
    assert.equal(window.tabGroups.all.length, 2, "the child does not split a new group");

    await window.showTextDocument(document, { viewColumn: workPane.viewColumn });
    await eventually(() => window.tabGroups.activeTabGroup === workPane && window.tabGroups.activeTabGroup.activeTab?.input instanceof TabInputText, "the user's editor did not take focus");
    assert.equal(await nativeHost.editorPaneOf!(parent), parentPane, "the parent is located while a text editor has focus");
    assert.equal(await nativeHost.editorPaneOf!(parent), parentPane, "an already focused parent is located immediately");

    // Within the user's own group no other group activates; the active-group fallback is the parent's.
    sibling.show(false);
    await eventually(() => window.activeTerminal === sibling && window.tabGroups.activeTabGroup === parentPane, "the sibling did not take focus");
    assert.equal(await nativeHost.editorPaneOf!(parent), undefined, "a parent in the active group activates no other group");
    assert.equal(window.tabGroups.activeTabGroup, parentPane, "the fallback group is the parent's");

    const panel = window.createTerminal({ cwd: root, location: TerminalLocation.Panel });
    familyTerminals.push(panel);
    await panel.processId;
    assert.equal(await nativeHost.editorPaneOf!(panel), undefined, "a panel parent has no editor group");
  } finally {
    for (const terminal of familyTerminals) {
      terminal.dispose();
      await eventually(() => !window.terminals.includes(terminal), "a family terminal did not close");
    }
  }
  await eventually(() => window.tabGroups.all.every((group) => terminalCount(group) === 0), "family terminals did not close");

  await initializeAgentLayout(1, 2);
  await commands.executeCommand("vscode.setEditorLayout", { orientation: 1, groups: [{ size: 0.25 }, { size: 0.75 }] });
  const placementLayout = await commands.executeCommand("vscode.getEditorLayout");
  const placementPanes = captureEditorPanes();
  try {
    placementProbes.push(nativeHost.createTerminal({ ...placementOptions, editorPane: placementPanes[1]! }));
    await eventually(() => window.tabGroups.all.some((group) => group.tabs.length === 1 && terminalCount(group) === 1), "initial preset assignment did not use its specified pane");
    placementProbes[0]!.show(false);
    await eventually(() => window.tabGroups.activeTabGroup === placementPanes[1], "terminal pane did not become active");
    placementProbes.push(nativeHost.createTerminal(placementOptions));
    await eventually(() => terminalCount(window.tabGroups.activeTabGroup) === 2, "Run Agent did not use the occupied active group while another group had no terminals");
    assert.equal(terminalCount(window.tabGroups.all[0]!), 0, "Run Agent leaves other panes untouched");
    assert.deepEqual(await commands.executeCommand("vscode.getEditorLayout"), placementLayout, "later agents preserve the user's pane proportions");
    await commands.executeCommand("vscode.setEditorLayout", { groups: [{}] });
    await eventually(() => window.tabGroups.all.length === 1, "user merge did not settle");
    placementProbes.push(nativeHost.createTerminal({ ...placementOptions, editorPane: placementPanes[1]! }));
    await eventually(() => terminalCount(window.tabGroups.all[0]!) === 3, "remaining assignments did not fall back to the surviving group");
    assert.equal(window.tabGroups.all.length, 1, "launch does not restore a removed group");
    placementProbes.push(nativeHost.createTerminal(placementOptions));
    await eventually(() => terminalCount(window.tabGroups.activeTabGroup) === 4, "Run Agent did not add an editor tab to the active group");
    const shell = nativeHost.createTerminal({ cwd: root, env: {}, editorPane: window.tabGroups.activeTabGroup });
    placementProbes.push(shell);
    await eventually(() => terminalCount(window.tabGroups.activeTabGroup) === 5, "Empty did not open a regular terminal in the assigned editor group");
    assert.ok(await shell.processId, "the Empty terminal starts the default shell");
  } finally {
    for (const terminal of placementProbes) terminal.dispose();
  }

  // Real VS Code must keep process OSC titles from replacing our label,
  // and still accept session titles through the stable rename command.
  const title = "Fix terminal naming";
  const titleTerminals = new Set(window.terminals);
  const titleHost = createVsCodeTerminalHost();
  const titleRegistration = titleHost.onDidCloseTerminal(() => undefined);
  const titleProbe = titleHost.createTerminal({
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
    titleProbe.show(false);
    await eventually(() => window.activeTerminal === titleProbe, "Title probe did not become active");
    await eventually(
      () => window.terminals.some((terminal) => !titleTerminals.has(terminal) && terminal.name === "Claude Code"),
      "VS Code did not preserve the provider label against the process title",
    );
    titleHost.setTitle?.(titleProbe, title);
    await eventually(
      () => window.terminals.some((terminal) => !titleTerminals.has(terminal) && terminal.name === title),
      "VS Code did not display the session title through the stable rename command",
    );
    for (const [provider, initialName] of [["chatgpt", "Codex"], ["pi", "Pi Agent"]] as const) {
      const background = titleHost.createTerminal({ cwd: root, env: {}, provider });
      try {
        await background.processId;
        const native = window.terminals.find((terminal) => terminal === background);
        assert.ok(native);
        const icon = "iconPath" in native.creationOptions ? native.creationOptions.iconPath : undefined;
        assert.ok(icon instanceof ThemeIcon, `${provider} must use a product icon for editor tabs`);
        assert.equal(icon.id, provider === "pi" ? "aboard-pi" : "openai");
        if (provider === "pi") {
          const contribution = extension.packageJSON.contributes.icons[icon.id].default as { fontPath: string; fontCharacter: string };
          assert.equal(contribution.fontCharacter, "\\E001");
          await access(join(extension.extensionPath, contribution.fontPath));
        }
        await eventually(() => window.terminals.some((terminal) => terminal === background && terminal.name === initialName), `${provider} initial label was not preserved`);
        titleProbe.show(false);
        await eventually(() => window.activeTerminal === titleProbe, "Background probe did not release focus");
        titleHost.setTitle?.(background, `${initialName} task`);
        assert.equal(window.activeTerminal, titleProbe, "Background title updates must not steal focus");
        background.show(false);
        await eventually(() => window.terminals.some((terminal) => terminal === background && terminal.name === `${initialName} task`), `${provider} pending task title was not applied on selection`);
      } finally { background.dispose(); }
      titleProbe.show(false);
      await eventually(() => window.activeTerminal === titleProbe, "Title probe did not regain focus");
    }
  } finally {
    titleProbe.dispose();
    titleRegistration.dispose();
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
  await eventually(() => !window.terminals.includes(commandTerminal!), "command terminal closed before the cross-window check");

  // The published token stops at the command endpoint.
  const refused = await fetch(`http://127.0.0.1:${endpoint.port}/terminals`, {
    headers: { authorization: `Bearer ${endpoint.commandToken}` },
  });
  assert.equal(refused.status, 403);

  // A real second extension host must claim the handoff and acknowledge it.
  // Regular shell assignments check the full launch path without requiring a provider.
  const files = new AgentWorkspaceFiles(api.agentWorkspaceStorageRoot);
  const emptyPlan = { preset: { id: "integration-pair", name: "Integration pair", columns: 1, rows: 2, panes: [{ providers: [""] }, { providers: [] }] }, empty: false, manual: false };
  const launchHandoff = await files.create(root, emptyPlan);
  const beforeGroups = captureEditorPanes();
  const beforeTerminals = new Set(window.terminals);
  await commands.executeCommand("vscode.openFolder", Uri.file(launchHandoff.workspaceFile), { forceNewWindow: true });
  assert.deepEqual(await new WorkspaceStartup(api.agentWorkspaceStorageRoot, launchHandoff).wait({ activationTimeoutMs: 30_000, timeoutMs: 30_000 }), { started: 2, failed: [], cancelled: 0 }, "the new workspace starts its regular shell terminals");
  assert.deepEqual(captureEditorPanes(), beforeGroups, "new window preserves source editor groups");
  assert.ok(window.terminals.every((terminal) => beforeTerminals.has(terminal)), "new window does not create terminals in the source");
  let replayed = false;
  const duplicate = await new WorkspaceStartup(api.agentWorkspaceStorageRoot, launchHandoff).execute(async () => {
    replayed = true;
    return { started: 1, cancelled: 0, failed: [] };
  });
  assert.equal(replayed, false, "completed startup cannot recreate agents");
  assert.equal(duplicate.started, 2);

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
