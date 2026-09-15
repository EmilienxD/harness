import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { spawnableCommand } from "./path.js";

const execFileAsync = promisify(execFile);
const MINIMUM_VERSION = [2, 1, 261] as const;
const REQUIRED_HELP = ["-p, --print", "--output-format <format>", "--verbose", "--tools <tools...>", "--allowedTools", "--permission-mode <mode>", "--permission-prompts <target>", "--session-id <uuid>"] as const;
const CLEARED_ENVIRONMENT = [
  "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS", "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
  "ANTHROPIC_BEDROCK_BASE_URL", "ANTHROPIC_VERTEX_BASE_URL", "ANTHROPIC_FOUNDRY_BASE_URL",
  "ANTHROPIC_VERTEX_PROJECT_ID", "CLOUD_ML_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN", "AWS_PROFILE", "AWS_REGION", "AWS_DEFAULT_REGION", "AZURE_CLIENT_ID", "AZURE_TENANT_ID", "AZURE_CLIENT_SECRET",
] as const;

export interface CapturedProcess {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export async function validateClaudeCli(): Promise<void> {
  const versionCommand = spawnableCommand("claude", ["--version"]);
  const versionOutput = (await execCaptured(versionCommand.file, versionCommand.args)).trim();
  parseClaudeVersion(versionOutput);
  const helpCommand = spawnableCommand("claude", ["--help"]);
  const help = await execCaptured(helpCommand.file, helpCommand.args);
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

export function isolatedClaudeEnvironment(parent: NodeJS.ProcessEnv, overlay: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const env = { ...parent };
  for (const name of CLEARED_ENVIRONMENT) delete env[name];
  delete env.CLAUDE_CODE_RETRY_WATCHDOG;
  delete env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY;
  return { ...env, ...overlay };
}

export async function runClaude(args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs = 120_000): Promise<CapturedProcess> {
  return new Promise((resolve, reject) => {
    const claude = spawnableCommand("claude", args);
    const child = spawn(claude.file, [...claude.args], { cwd, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
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

export async function execCaptured(file: string, args: readonly string[], cwd?: string): Promise<string> {
  const result = await execFileAsync(file, args, { ...(cwd ? { cwd } : {}), encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  return result.stdout;
}

function compareVersions(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}
