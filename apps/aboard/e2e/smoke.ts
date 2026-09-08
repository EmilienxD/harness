import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { HarnessConfig } from "./config.js";
import { resetLocal } from "./repository.js";
import { AFTER_CONTENT, BEFORE_CONTENT, FINAL_RESPONSE, SCENARIO_MARKER } from "./scenario.js";
import { startFakeAnthropicServer } from "./server.js";

const execFileAsync = promisify(execFile);
const MINIMUM_VERSION = [2, 1, 261] as const;
const REQUIRED_HELP = ["-p, --print", "--output-format <format>", "--verbose", "--tools <tools...>", "--allowedTools", "--permission-mode <mode>", "--permission-prompts <target>", "--session-id <uuid>"] as const;
const INITIAL_SKILL_NAME = "aboard-e2e-initial-skill";
const CLEARED_ENVIRONMENT = [
  "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS", "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
  "ANTHROPIC_BEDROCK_BASE_URL", "ANTHROPIC_VERTEX_BASE_URL", "ANTHROPIC_FOUNDRY_BASE_URL",
  "ANTHROPIC_VERTEX_PROJECT_ID", "CLOUD_ML_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN", "AWS_PROFILE", "AWS_REGION", "AWS_DEFAULT_REGION", "AZURE_CLIENT_ID", "AZURE_TENANT_ID", "AZURE_CLIENT_SECRET",
] as const;

export async function runSmoke(config: HarnessConfig): Promise<void> {
  await validateClaudeCli();
  await resetLocal(config);
  const fixturePath = join(config.cloneRoot, "deterministic.txt");
  const baseline = await readFile(fixturePath, "utf8");
  if (baseline !== BEFORE_CONTENT) throw new Error("Runtime clone does not contain the exact canonical fixture baseline");
  const skillDirectory = join(config.claudeConfigRoot, "skills", INITIAL_SKILL_NAME);
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(join(config.claudeConfigRoot, "settings.json"), "{}\n", { encoding: "utf8", flag: "wx" }).catch((error: unknown) => {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  });
  await writeFile(join(skillDirectory, "SKILL.md"), [
    "---",
    `name: ${INITIAL_SKILL_NAME}`,
    "description: Proves that Claude expands a user-only skill passed as its initial CLI prompt.",
    "disable-model-invocation: true",
    "---",
    `${SCENARIO_MARKER} Perform the deterministic fixture update using the available tools, then report completion.`,
    "",
  ].join("\n"), "utf8");

  const server = await startFakeAnthropicServer({ repoRoot: config.cloneRoot, diagnosticsPath: config.diagnosticsPath, readinessPath: config.readinessPath });
  try {
    const sessionId = randomUUID();
    const args = [
      "-p", "--output-format", "stream-json", "--verbose", "--tools", "Read,Edit", "--allowedTools", "Read,Edit",
      "--permission-mode", "acceptEdits", "--permission-prompts", "none", "--session-id", sessionId,
      `/${INITIAL_SKILL_NAME} Perform the deterministic fixture update.`,
    ];
    const env = childEnvironment(process.env, {
      ANTHROPIC_BASE_URL: server.baseUrl,
      ANTHROPIC_AUTH_TOKEN: server.authToken,
      CLAUDE_CONFIG_DIR: config.claudeConfigRoot,
      CLAUDE_CODE_PROJECT_DIR_NAME: "aboard-e2e",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_MAX_RETRIES: "0",
      DISABLE_UPDATES: "1",
      DISABLE_AUTOUPDATER: "1",
      NO_PROXY: "127.0.0.1,localhost",
    });
    const result = await spawnCaptured("claude", args, config.cloneRoot, env);
    if (result.timedOut) throw new Error("Claude Code did not finish the deterministic smoke exchange within 120 seconds");
    if (result.code !== 0) throw new Error(`Claude Code exited ${result.code}; stderr: ${redactProcessError(result.stderr)}`);
    const events = parseStreamJson(result.stdout);
    const finalText = findFinalText(events, result.stdout);
    if (!finalText.includes(FINAL_RESPONSE)) throw new Error("Claude Code stream did not contain the deterministic final response");

    const assertions = server.assertions();
    const reached = new Set(assertions.checkpoints);
    for (const checkpoint of ["read-target", "edit-target", "complete"]) {
      if (!reached.has(checkpoint)) throw new Error(`Fake inference scenario did not reach ${checkpoint}`);
    }
    if (assertions.inferenceRequests !== 3 || assertions.unexpectedRequests !== 0) {
      throw new Error(`Unexpected inference activity: ${assertions.inferenceRequests} inference requests, ${assertions.unexpectedRequests} rejected requests`);
    }
    const content = await readFile(fixturePath, "utf8");
    if (content !== AFTER_CONTENT) throw new Error("Claude Code did not produce the exact expected fixture content");
    const status = await exec("git", ["status", "--porcelain=v1", "--untracked-files=all"], config.cloneRoot);
    if (status.trim() !== "M deterministic.txt") throw new Error(`Expected deterministic.txt to be the only changed file; observed ${JSON.stringify(status.trim())}`);
  } finally {
    await server.close();
  }
}

export async function validateClaudeCli(): Promise<void> {
  const versionOutput = (await exec("claude", ["--version"])).trim();
  parseClaudeVersion(versionOutput);
  const help = await exec("claude", ["--help"]);
  const missing = missingClaudeHelpStructures(help);
  if (missing.length > 0) throw new Error(`Claude Code protocol mismatch; missing required help structures: ${missing.join(", ")}`);
}

export function parseClaudeVersion(output: string): readonly [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\D|$)/.exec(output.trim());
  if (!match) throw new Error(`Could not parse Claude Code version from ${JSON.stringify(output.trim())}`);
  const version = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  if (compareVersions(version, MINIMUM_VERSION) < 0) throw new Error(`Claude Code >= ${MINIMUM_VERSION.join(".")} is required; found ${version.join(".")}`);
  return version;
}

export function missingClaudeHelpStructures(help: string): readonly string[] {
  return REQUIRED_HELP.filter((flag) => !help.includes(flag));
}

export function childEnvironment(parent: NodeJS.ProcessEnv, overlay: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const env = { ...parent };
  for (const name of CLEARED_ENVIRONMENT) delete env[name];
  delete env.CLAUDE_CODE_RETRY_WATCHDOG;
  delete env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY;
  return { ...env, ...overlay };
}

function compareVersions(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

async function spawnCaptured(file: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; child.kill(); }, 120_000);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), timedOut });
    });
  });
}

export function parseStreamJson(output: string): readonly unknown[] {
  const lines = output.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) throw new Error("Claude Code emitted no stream-json records");
  return lines.map((line, index) => {
    try { return JSON.parse(line) as unknown; }
    catch { throw new Error(`Claude Code emitted invalid stream-json at line ${index + 1}`); }
  });
}

export function findFinalText(events: readonly unknown[], raw: string): string {
  const strings: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === "string") strings.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (typeof value === "object" && value !== null) Object.values(value).forEach(visit);
  };
  events.forEach(visit);
  return strings.join("\n") || raw;
}

export function redactProcessError(stderr: string): string {
  return stderr.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 1000).trim() || "no stderr";
}

async function exec(file: string, args: readonly string[], cwd?: string): Promise<string> {
  const result = await execFileAsync(file, args, { ...(cwd ? { cwd } : {}), encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  return result.stdout;
}
