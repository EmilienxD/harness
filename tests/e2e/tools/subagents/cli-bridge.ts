import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const mode = process.argv[2];
const command = process.argv[3];
const args = process.argv.slice(4);

if (mode === "--spawn") {
  const child = spawn(process.execPath, [process.argv[1]!, "--drive", command ?? "", ...args], {
    cwd: process.cwd(), env: process.env, detached: true, windowsHide: true, stdio: "ignore",
  });
  child.unref();
} else if (mode === "--drive") {
  void drive(command, args);
} else {
  process.exitCode = 2;
}

async function drive(file: string | undefined, commandArgs: readonly string[]): Promise<void> {
  const role = process.env.HARNESS_REQUEST_ID ? "child" : "parent";
  const statusRoot = process.env.HARNESS_E2E_CLI_DIR;
  const marker = role === "child" ? process.env.HARNESS_E2E_CHILD_COMPLETE : process.env.HARNESS_E2E_PARENT_COMPLETE;
  if (!file || !statusRoot || !marker) {
    writeStatus(statusRoot, role, { status: "invalid-environment", markerSeen: false, timedOut: false, exitCode: null });
    return;
  }
  if (role === "child" && !await waitForCheckpoint()) {
    writeStatus(statusRoot, role, { status: "checkpoint-timeout", markerSeen: false, timedOut: true, exitCode: null });
    return;
  }

  const child = spawn(file, [...commandArgs], {
    cwd: process.cwd(), env: process.env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let tail = "";
  let markerSeen = false;
  let timedOut = false;
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk: Buffer) => {
    tail = `${tail}${chunk.toString("utf8")}`.slice(-128 * 1024);
    markerSeen ||= tail.includes(marker);
  });
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 120_000);
  let settled = false;
  child.once("error", () => {
    clearTimeout(timeout);
    settled = true;
    writeStatus(statusRoot, role, { status: "spawn-failed", markerSeen, timedOut, exitCode: null });
  });
  child.once("close", (exitCode) => {
    clearTimeout(timeout);
    if (settled) return;
    settled = true;
    writeStatus(statusRoot, role, {
      status: exitCode === 0 && markerSeen && !timedOut ? "completed" : "failed",
      markerSeen,
      timedOut,
      exitCode,
      executable: basename(file).toLowerCase().includes("node") ? "node-cli" : basename(file).toLowerCase(),
    });
  });
}

async function waitForCheckpoint(): Promise<boolean> {
  const diagnostics = process.env.HARNESS_E2E_DIAGNOSTICS;
  const checkpoint = process.env.HARNESS_E2E_CHILD_START_CHECKPOINT;
  if (!diagnostics || !checkpoint) return true;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const value = JSON.parse(readFileSync(diagnostics, "utf8")) as { observations?: readonly { checkpoint?: unknown }[] };
      if (value.observations?.some((item) => item.checkpoint === checkpoint)) return true;
    } catch { }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

function writeStatus(root: string | undefined, role: string, value: Record<string, unknown>): void {
  if (!root) return;
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, `${role}.json`), `${JSON.stringify({ schemaVersion: 1, role, ...value }, null, 2)}\n`, "utf8");
}
