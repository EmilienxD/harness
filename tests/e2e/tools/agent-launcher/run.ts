import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { startFakeAnthropicServer } from "../../core/anthropic-server.js";
import { parseAnthropicMessagesRequest } from "../../core/anthropic-protocol.js";
import {
  isolatedClaudeEnvironment,
  parseStreamJson,
  redactProcessError,
  validateClaudeCli,
  type CapturedProcess,
} from "../../core/claude.js";
import { prepareCodexHome, redactCodexProcessError, validateCodexCli } from "../../core/codex.js";
import { startFakeOpenAiServer } from "../../core/openai-server.js";
import { spawnableCommand } from "../../core/path.js";
import {
  CLAUDE_MODEL,
  CODEX_MODEL,
  MARKER,
  claudeTransition,
  codexTransition,
  scenarioCatalogHash,
} from "./scenario.js";

const execFileAsync = promisify(execFile);
type Platform = "claude" | "chatgpt";

export interface AgentLauncherJourneyResult {
  readonly checkpoints: readonly string[];
  readonly unexpectedRequests: number;
}

export async function runAgentLauncherJourney(platform: Platform): Promise<AgentLauncherJourneyResult> {
  if (platform === "claude") await validateClaudeCli(); else await validateCodexCli();
  const root = await mkdtemp(join(tmpdir(), `harness-agent-launcher-${platform}-e2e-`));
  const projectRoot = join(root, "project");
  const diagnosticsPath = join(root, "structural-diagnostics.json");
  let server: Awaited<ReturnType<typeof startFakeAnthropicServer>> | Awaited<ReturnType<typeof startFakeOpenAiServer>> | undefined;
  try {
    const harnessRoot = await findHarnessRoot(process.cwd());
    const packageRoot = join(harnessRoot, "harness", "productivity", "agent-launcher");
    const runtimeSource = join(packageRoot, "runtime", "src");
    const launcherRoot = join(projectRoot, ".harness", "agent-launcher");
    await mkdir(projectRoot, { recursive: true });
    await cp(join(runtimeSource, "agent_launcher", "templates"), launcherRoot, { recursive: true });
    await configureNativeCommands(join(launcherRoot, "config.py"));
    await writeFile(join(launcherRoot, "claude", "settings.json"), `${JSON.stringify({ model: CLAUDE_MODEL }, null, 2)}\n`, "utf8");
    await writeFile(join(launcherRoot, "chatgpt", "config.toml"), `model = ${JSON.stringify(CODEX_MODEL)}\n`, "utf8");
    const python = await pythonCommand(runtimeSource);
    let result: CapturedProcess;

    if (platform === "claude") {
      const configRoot = join(root, "claude-config");
      await mkdir(configRoot, { recursive: true });
      await writeFile(join(configRoot, "settings.json"), "{}\n", "utf8");
      server = await startFakeAnthropicServer({
        repoRoot: projectRoot,
        diagnosticsPath,
        scenarioCatalogHash,
        parseRequest: parseAnthropicMessagesRequest,
        transition: claudeTransition,
      });
      const env = isolatedClaudeEnvironment(withRuntime(process.env, runtimeSource), {
        ANTHROPIC_BASE_URL: server.baseUrl,
        ANTHROPIC_AUTH_TOKEN: server.authToken,
        CLAUDE_CONFIG_DIR: configRoot,
        CLAUDE_PROJECT_DIR: projectRoot,
        CLAUDE_CODE_PROJECT_DIR_NAME: "harness-agent-launcher-e2e",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        CLAUDE_CODE_MAX_RETRIES: "0",
        DISABLE_UPDATES: "1",
        DISABLE_AUTOUPDATER: "1",
        NO_PROXY: "127.0.0.1,localhost",
      });
      result = await runLauncher(python, "claude_entrypoint", [
        "-p", "--output-format", "stream-json", "--verbose", "--tools", "",
        "--session-id", randomUUID(), MARKER,
      ], projectRoot, env);
      if (result.timedOut) throw new Error("cch timed out during agent-launcher E2E");
      if (result.code !== 0) throw new Error(`cch exited ${result.code}: ${redactProcessError(result.stderr)}`);
      parseStreamJson(result.stdout);
    } else {
      const codexServer = await startFakeOpenAiServer({ diagnosticsPath, scenarioCatalogHash, transition: codexTransition });
      server = codexServer;
      const codexHome = await prepareCodexHome({ root, baseUrl: codexServer.baseUrl, trustedProjects: [projectRoot] });
      const env = isolatedCodexEnvironment(withRuntime(process.env, runtimeSource), codexHome, codexServer.authToken);
      result = await runLauncher(python, "chatgpt_entrypoint", [
        "exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only", MARKER,
      ], projectRoot, env);
      if (result.timedOut) throw new Error("cxh timed out during agent-launcher E2E");
      if (result.code !== 0) {
        const structure = codexServer.assertions().observations.map((item) => `${String(item.httpStatus)}:${String(item.checkpoint ?? item.diagnostic ?? "unknown")}`).join(", ");
        throw new Error(`cxh exited ${result.code}: ${redactCodexProcessError(result.stderr)}; endpoint: ${structure}`);
      }
    }
    const assertions = server.assertions();
    if (!assertions.checkpoints.includes("configuration-observed")) {
      throw new Error(`agent-launcher checkpoint missing: ${assertions.checkpoints.join(", ")}`);
    }
    return { checkpoints: ["configuration-observed"], unexpectedRequests: assertions.unexpectedRequests };
  } finally {
    await server?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function configureNativeCommands(path: string): Promise<void> {
  const claude = spawnableCommand("claude", []);
  const codex = spawnableCommand("codex", []);
  const original = await readFile(path, "utf8");
  const configured = `${original.trimEnd()}\n\nCOMMANDS = {\n` +
    `    "claude": ${pythonTuple([claude.file, ...claude.args])},\n` +
    `    "chatgpt": ${pythonTuple([codex.file, ...codex.args])},\n` +
    "}\n";
  await writeFile(path, configured, "utf8");
}

function pythonTuple(values: readonly string[]): string {
  return `(${values.map((value) => JSON.stringify(value)).join(", ")},)`;
}

async function runLauncher(
  python: string,
  entrypoint: "claude_entrypoint" | "chatgpt_entrypoint",
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = 120_000,
): Promise<CapturedProcess> {
  return new Promise((resolvePromise, reject) => {
    const command = spawnableCommand(python, ["-c", `from agent_launcher.cli import ${entrypoint}; ${entrypoint}()`, ...args]);
    const child = spawn(command.file, [...command.args], { cwd, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
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

function withRuntime(parent: NodeJS.ProcessEnv, runtimeSource: string): NodeJS.ProcessEnv {
  return { ...parent, PYTHONPATH: `${runtimeSource}${delimiter}${parent.PYTHONPATH ?? ""}` };
}

function isolatedCodexEnvironment(parent: NodeJS.ProcessEnv, codexHome: string, token: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...parent,
    CODEX_HOME: codexHome,
    HARNESS_E2E_OPENAI_KEY: token,
    NO_PROXY: "127.0.0.1,localhost",
  };
  for (const key of ["OPENAI_API_KEY", "OPENAI_BASE_URL", "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_ENDPOINT"]) delete env[key];
  return env;
}

async function pythonCommand(runtimeSource: string): Promise<string> {
  for (const candidate of ["python3", "python", "py"]) {
    try {
      await execFileAsync(candidate, ["-c", "import agent_launcher, sys; assert sys.version_info >= (3, 11)"], {
        env: withRuntime(process.env, runtimeSource),
        windowsHide: true,
      });
      return candidate;
    } catch { }
  }
  throw new Error("agent-launcher E2E requires Python 3.11 or newer");
}

async function findHarnessRoot(start: string): Promise<string> {
  let candidate = resolve(start);
  while (true) {
    try {
      await readFile(join(candidate, "harness", "productivity", "agent-launcher", "harness.toml"));
      return candidate;
    } catch { }
    const parent = dirname(candidate);
    if (parent === candidate) throw new Error("could not locate the Harness checkout");
    candidate = parent;
  }
}
