import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { commands, extensions, window, workspace } from "vscode";

const execFileAsync = promisify(execFile);

interface CommandEndpoint { readonly port: number; readonly workspaceRoot: string; readonly commandToken: string }
interface AboardApi { readonly commandEndpointDirectory: string }
interface Observation { readonly scenario: string | null; readonly checkpoint: string | null; readonly sessionHash: string | null; readonly toolNamesOffered: readonly string[]; readonly result: string }
interface Diagnostics { readonly upstreamMode: string; readonly observations: readonly Observation[] }

async function eventually<T>(read: () => Promise<T | undefined> | T | undefined, message: string, attempts = 240): Promise<T> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(message);
}

async function diagnostics(): Promise<Diagnostics | undefined> {
  const path = process.env.ABOARD_E2E_DIAGNOSTICS;
  assert.ok(path, "diagnostics path is configured");
  try { return JSON.parse(await readFile(path, "utf8")) as Diagnostics; }
  catch { return undefined; }
}

async function endpoint(directory: string, root: string): Promise<CommandEndpoint | undefined> {
  const entries = await readdir(directory).catch(() => []);
  for (const entry of entries) {
    const value = JSON.parse(await readFile(join(directory, entry), "utf8")) as CommandEndpoint;
    if (value.workspaceRoot === root) return value;
  }
  return undefined;
}

export async function run(): Promise<void> {
  const root = workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert.equal(root?.toLowerCase(), process.env.ABOARD_E2E_REPOSITORY_ROOT?.toLowerCase());
  if (!root) throw new Error("E2E repository workspace is not open");
  const extension = extensions.getExtension("aboard.aboard");
  assert.ok(extension, "aboard extension is discoverable");
  const api = await extension.activate() as AboardApi;
  const phase = process.env.ABOARD_E2E_PHASE;

  if (phase === "initialize") {
    assert.equal(window.terminals.some((terminal) => terminal.name.startsWith("aboard:")), false);
    assert.equal(await endpoint(api.commandEndpointDirectory, root), undefined);
    await commands.executeCommand("aboard.newManager");
    assert.equal(window.terminals.some((terminal) => terminal.name.startsWith("aboard:")), false);
    await commands.executeCommand("aboard.initializeProject");
    const published = await eventually(() => endpoint(api.commandEndpointDirectory, root), "initialization did not publish the command endpoint");
    assert.ok(published.port > 0);
    await assert.rejects(access(join(root, ".claude")));
    await assert.rejects(access(join(root, ".mcp.json")));
    await assert.rejects(access(join(root, ".gitignore")));
    return;
  }
  if (phase !== "delegation") throw new Error(`Unknown extension E2E phase ${String(phase)}`);
  const published = await eventually(() => endpoint(api.commandEndpointDirectory, root), "initialized project did not publish the command endpoint");
  const before = new Set(window.terminals);
  await commands.executeCommand("aboard.newManager");
  const manager = await eventually(() => window.terminals.find((terminal) => !before.has(terminal)), "Manager terminal was not created");
  await eventually(async () => await manager.processId ? manager : undefined, "Manager terminal process did not start");

  const completed = await eventually(async () => {
    const value = await diagnostics();
    return value?.observations.some((item) => item.checkpoint === "manager-complete") ? value : undefined;
  }, "Manager and Explore journey did not complete", 480);
  assert.equal(completed.upstreamMode, "forbidden");
  const successes = completed.observations.filter((item) => item.result === "success");
  const managerRows = successes.filter((item) => item.scenario === "manager-foreground-explore");
  const exploreRows = successes.filter((item) => item.scenario === "explore-read-report");
  assert.deepEqual(managerRows.map((item) => item.checkpoint), ["delegate-explore", "manager-complete"]);
  assert.deepEqual(exploreRows.map((item) => item.checkpoint), ["explore-read", "explore-complete"]);
  assert.ok(managerRows[0]?.toolNamesOffered.includes("mcp__aboard__run_agent"));
  assert.equal(managerRows[0]?.toolNamesOffered.includes("Edit"), false);
  assert.ok(exploreRows[0]?.toolNamesOffered.includes("Read"));
  assert.equal(exploreRows[0]?.toolNamesOffered.some((name) => name.startsWith("mcp__aboard__")), false);
  assert.equal(new Set(successes.map((item) => item.sessionHash).filter(Boolean)).size, 2);

  const journeyTerminals = window.terminals.filter((terminal) => !before.has(terminal));
  assert.ok(journeyTerminals.length >= 2, "Manager and Explore terminals stay visible for inspection");
  const statusBeforeReset = (await execFileAsync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: root, encoding: "utf8" })).stdout;
  assert.doesNotMatch(statusBeforeReset, /deterministic\.txt/u);

  await rm(join(root, ".abd"), { recursive: true, force: true });
  await eventually(() => journeyTerminals.some((terminal) => window.terminals.includes(terminal)) ? undefined : true, "deleting .abd did not close aboard terminals");
  await eventually(async () => await endpoint(api.commandEndpointDirectory, root) === undefined ? true : undefined, "deleting .abd did not remove the command endpoint");
  await assert.rejects(fetch(`http://127.0.0.1:${published.port}/commands`));
  const finalStatus = (await execFileAsync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: root, encoding: "utf8" })).stdout;
  assert.equal(finalStatus, "");
}
