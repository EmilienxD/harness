import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FileCommandEndpointRegistry,
  commandEndpointDirectory,
  type CommandEndpointRecord,
} from "../src/bridge/command-endpoint.js";

function record(overrides: Partial<CommandEndpointRecord> = {}): CommandEndpointRecord {
  return {
    version: 1,
    host: "127.0.0.1",
    port: 4823,
    workspaceRoot: "C:\\work\\project",
    commandToken: "command-token",
    pid: 4242,
    activatedAt: "2026-08-22T09:00:00.000Z",
    ...overrides,
  };
}

async function directory(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "aboard-endpoint-")), "endpoints");
}

test("resolves one deterministic per-user directory per platform", () => {
  assert.equal(
    commandEndpointDirectory("win32", { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" }, "C:\\Users\\me"),
    join("C:\\Users\\me\\AppData\\Local", "abd", "endpoints"),
  );
  assert.equal(
    commandEndpointDirectory("win32", {}, "C:\\Users\\me"),
    join("C:\\Users\\me", "AppData", "Local", "abd", "endpoints"),
  );
  assert.equal(
    commandEndpointDirectory("darwin", {}, "/Users/me"),
    join("/Users/me", "Library", "Application Support", "abd", "endpoints"),
  );
  assert.equal(
    commandEndpointDirectory("linux", { XDG_STATE_HOME: "/run/user/1000/state" }, "/home/me"),
    join("/run/user/1000/state", "abd", "endpoints"),
  );
  assert.equal(
    commandEndpointDirectory("linux", { XDG_STATE_HOME: "" }, "/home/me"),
    join("/home/me", ".local", "state", "abd", "endpoints"),
  );
});

test("publishes a readable record outside any workspace and clears it again", async () => {
  const registry = new FileCommandEndpointRegistry({ directory: await directory() });

  const path = await registry.publish(record());

  assert.equal(path.startsWith(registry.directory), true);
  assert.equal(path.includes("C:\\work\\project"), false, "the file name does not disclose the project path");
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")) as CommandEndpointRecord, record());
  assert.deepEqual(await readdir(registry.directory), [path.slice(registry.directory.length + 1)]);

  await registry.clear();
  assert.deepEqual(await readdir(registry.directory), []);
  // Clearing twice is how deactivation and disposal both run without racing.
  await registry.clear();
});

test("a window that reopens replaces its own record rather than adding one", async () => {
  const registry = new FileCommandEndpointRegistry({ directory: await directory() });

  await registry.publish(record({ port: 4823 }));
  const second = await registry.publish(record({ port: 5100, activatedAt: "2026-08-22T10:00:00.000Z" }));

  assert.deepEqual(await readdir(registry.directory), [second.slice(registry.directory.length + 1)]);
  assert.equal((JSON.parse(await readFile(second, "utf8")) as CommandEndpointRecord).port, 5100);
});

test("records from other live windows survive; abandoned and unreadable ones are pruned", async () => {
  const target = await directory();
  const alive = new FileCommandEndpointRegistry({ directory: target, isProcessAlive: (pid) => pid === 111 });
  await alive.publish(record({ workspaceRoot: "C:\\work\\other", pid: 111 }));
  const dead = new FileCommandEndpointRegistry({ directory: target, isProcessAlive: () => true });
  await dead.publish(record({ workspaceRoot: "C:\\work\\crashed", pid: 999 }));
  await writeFile(join(target, "litter.json"), "{ not json", "utf8");

  const registry = new FileCommandEndpointRegistry({ directory: target, isProcessAlive: (pid) => pid === 111 });
  const path = await registry.publish(record({ pid: 4242 }));

  const remaining = await readdir(target);
  assert.equal(remaining.length, 2, remaining.join(", "));
  assert.equal(remaining.includes(path.slice(target.length + 1)), true);
  assert.equal(remaining.includes("litter.json"), false);
  const survivors = await Promise.all(remaining.map(async (entry) =>
    JSON.parse(await readFile(join(target, entry), "utf8")) as CommandEndpointRecord));
  assert.deepEqual(survivors.map((survivor) => survivor.workspaceRoot).sort(), ["C:\\work\\other", "C:\\work\\project"]);
});

test("a script can pick its own project out of the directory", async () => {
  const target = await directory();
  const home = new FileCommandEndpointRegistry({ directory: target, isProcessAlive: () => true });
  await home.publish(record({ workspaceRoot: join(tmpdir(), "aboard-app"), port: 4823, pid: 111 }));
  const other = new FileCommandEndpointRegistry({ directory: target, isProcessAlive: () => true });
  await other.publish(record({ workspaceRoot: join(tmpdir(), "aboard-elsewhere"), port: 5100, pid: 111 }));

  // The whole reader-side contract: read every record, keep the one whose
  // workspaceRoot contains me. No path hashing, no filename parsing.
  const cwd = join(tmpdir(), "aboard-app", "packages", "backend");
  const entries = await readdir(target);
  const records = await Promise.all(entries.map(async (entry) =>
    JSON.parse(await readFile(join(target, entry), "utf8")) as CommandEndpointRecord));
  const mine = records.find((candidate) => cwd.startsWith(candidate.workspaceRoot));

  assert.equal(mine?.port, 4823);
});
