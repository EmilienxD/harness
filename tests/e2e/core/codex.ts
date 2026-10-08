import { execFile, spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnableCommand } from "./path.js";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface CodexHomeOptions {
  readonly root: string;
  readonly baseUrl: string;
  readonly model?: string;
  readonly providerName?: string;
  readonly envKey?: string;
  readonly trustedProjects?: readonly string[];
  readonly extraConfig?: readonly string[];
  /** Codex model catalog JSON declaring the fake model's native tool shapes. */
  readonly modelCatalog?: string;
}

export interface CodexProcessResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export async function prepareCodexHome(options: CodexHomeOptions): Promise<string> {
  const home = join(options.root, "codex-home");
  const provider = options.providerName ?? "harness-e2e";
  const envKey = options.envKey ?? "HARNESS_E2E_OPENAI_KEY";
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "config.toml"), [
    `model = ${JSON.stringify(options.model ?? "codex-e2e")}`,
    `model_provider = ${JSON.stringify(provider)}`,
    'sandbox_mode = "danger-full-access"',
    'approval_policy = "never"',
    'windows.sandbox = "unelevated"',
    ...(options.modelCatalog ? [`model_catalog_json = ${JSON.stringify(resolve(options.modelCatalog))}`] : []),
    `[model_providers.${provider}]`,
    'name = "Harness deterministic E2E"',
    `base_url = ${JSON.stringify(options.baseUrl)}`,
    `env_key = ${JSON.stringify(envKey)}`,
    'wire_api = "responses"',
    "request_max_retries = 0",
    "stream_max_retries = 0",
    "stream_idle_timeout_ms = 30000",
    "[notice]",
    "hide_full_access_warning = true",
    "hide_world_writable_warning = true",
    ...(options.trustedProjects ?? []).flatMap((project) => [
      `[projects.${JSON.stringify(resolve(project).toLowerCase())}]`,
      'trust_level = "trusted"',
    ]),
    ...(options.extraConfig ?? []),
    "",
  ].join("\n"), "utf8");
  return home;
}

export async function validateCodexCli(): Promise<void> {
  const versionCommand = spawnableCommand("codex", ["--version"]);
  const version = (await execFileAsync(versionCommand.file, [...versionCommand.args], { windowsHide: true })).stdout.trim();
  if (!/^codex-cli 0\.(?:15[3-9]|1[6-9]\d|[2-9]\d\d)\./u.test(version)) throw new Error(`Codex CLI >= 0.153 is required; found ${JSON.stringify(version)}`);
  const helpCommand = spawnableCommand("codex", ["exec", "--help"]);
  const help = (await execFileAsync(helpCommand.file, [...helpCommand.args], { windowsHide: true })).stdout;
  const required = ["--json", "--output-last-message", "--dangerously-bypass-hook-trust", "--sandbox <SANDBOX_MODE>"];
  const missing = required.filter((item) => !help.includes(item));
  if (missing.length > 0) throw new Error(`Codex CLI protocol mismatch; missing required help structures: ${missing.join(", ")}`);
}

export function runCodex(args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs = 120_000): Promise<CodexProcessResult> {
  return new Promise((resolvePromise, reject) => {
    const codex = spawnableCommand("codex", args);
    const child = spawn(codex.file, [...codex.args], { cwd, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const timeout = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolvePromise({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), timedOut });
    });
  });
}

export function redactCodexProcessError(stderr: string): string {
  return stderr.replace(/Bearer\s+\S+/giu, "Bearer [redacted]").replace(/(?:aboard|harness)-e2e-[a-f0-9]+/giu, "[redacted]").slice(0, 1000).trim() || "no stderr";
}
