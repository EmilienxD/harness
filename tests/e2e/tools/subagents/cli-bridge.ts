import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const mode = process.argv[2];
const command = process.argv[3];
const args = process.argv.slice(4);

if (mode === "--spawn") {
  const root = process.env.HARNESS_E2E_CLI_DIR!;
  mkdirSync(root,{recursive:true});
  const path = join(root,"visible.json");
  let counts = { parent:0,child:0 };
  try { counts = JSON.parse(readFileSync(path,"utf8")) as typeof counts; } catch { }
  counts[process.env.HARNESS_REQUEST_ID ? "child" : "parent"] += 1;
  writeFileSync(path,JSON.stringify(counts));
  const child = spawn(process.execPath, [process.argv[1]!, "--drive", command ?? "", ...args], {
    cwd: process.cwd(), env: process.env, detached: true, windowsHide: true, stdio: "ignore",
  });
  child.unref();
} else if (mode === "--provider") {
  const platform = command;
  const file = args[0];
  const baseArgs = /\.[cm]?js$/u.test(args[1] ?? "") ? [args[1]!] : [];
  const providerArgs = args.slice(1 + baseArgs.length);
  const interactive = ["interactive", "loop"].includes(process.env.HARNESS_EXECUTION_MODE ?? "");
  const prefix = interactive
    ? platform === "claude" ? ["-p","--output-format","stream-json","--verbose"] : ["exec","--json"]
    : [];
  const native = platform === "claude"
    ? ["--permission-prompts","none","--dangerously-skip-permissions","--prompt-suggestions","false","--tools","Read,Write,Bash","--allowedTools","Read,Write,Bash"]
    : ["--dangerously-bypass-hook-trust","--dangerously-bypass-approvals-and-sandbox","--skip-git-repo-check"];
  const automaticCodex = !interactive && platform === "chatgpt" && providerArgs[0] === "exec";
  void drive(file,automaticCodex ? [...baseArgs,"exec",...native,...providerArgs.slice(1)] : [...baseArgs,...prefix,...native,...providerArgs],true);
} else if (mode === "--drive") {
  void drive(command, args);
} else {
  process.exitCode = 2;
}

async function drive(file: string | undefined, commandArgs: readonly string[], provider = false): Promise<void> {
  const role = process.env.HARNESS_REQUEST_ID ? "child" : "parent";
  const statusRoot = process.env.HARNESS_E2E_CLI_DIR;
  const marker = role === "child" ? process.env.HARNESS_E2E_CHILD_COMPLETE : process.env.HARNESS_E2E_PARENT_COMPLETE;
  if (!file || !statusRoot || !marker) {
    writeStatus(statusRoot, role, { status: "invalid-environment", markerSeen: false, timedOut: false, exitCode: null });
    return;
  }


  const child = spawn(file, [...commandArgs], {
    cwd: process.cwd(), env: process.env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let tail = "";
  let markerSeen = false;
  let timedOut = false;
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk: Buffer) => {
    if (provider) (stream === child.stdout ? process.stdout : process.stderr).write(chunk);
    tail = `${tail}${chunk.toString("utf8")}`.slice(-128 * 1024);
    markerSeen ||= tail.includes(marker);
  });
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, Number(process.env.HARNESS_E2E_CLI_TIMEOUT_MS ?? 120_000));
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


function writeStatus(root: string | undefined, role: string, value: Record<string, unknown>): void {
  if (!root) return;
  mkdirSync(root, { recursive: true });
  const content = `${JSON.stringify({ schemaVersion: 1, role, cwd: process.cwd(), ...value }, null, 2)}\n`;
  writeFileSync(join(root, `${role}.json`), content, "utf8");
  // Journeys with several launches of one role need every process's outcome.
  writeFileSync(join(root, `${role}-${process.pid}.json`), content, "utf8");
}
