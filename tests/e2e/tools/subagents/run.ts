import { execFile } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { parseAnthropicMessagesRequest } from "../../core/anthropic-protocol.js";
import { startFakeAnthropicServer } from "../../core/anthropic-server.js";
import { isolatedClaudeEnvironment, validateClaudeCli } from "../../core/claude.js";
import { prepareCodexHome, validateCodexCli } from "../../core/codex.js";
import { startFakeOpenAiServer } from "../../core/openai-server.js";
import { spawnableCommand } from "../../core/path.js";
import { canonicalMkdtemp } from "../../core/temp.js";
import {
  CHILD_REPLY,
  PARENT_MARKER,
  PARENT_REPLY,
  NEXT_MARKER,
  NEXT_REPLY,
  claudeTransition,
  codexTransition,
  scenarioCatalogHash,
} from "./scenario.js";

const execFileAsync = promisify(execFile);
type Platform = "claude" | "chatgpt";

interface CliStatus {
  readonly role: "parent" | "child";
  readonly status: string;
  readonly markerSeen: boolean;
  readonly timedOut: boolean;
  readonly exitCode: number | null;
}

export interface SubagentsJourneyResult {
  readonly checkpoints: readonly string[];
  readonly completedClis: readonly string[];
  readonly requestFilesRemaining: number;
  readonly unexpectedRequests: number;
}

export async function runSubagentsJourney(platform: Platform, mode: "interactive" | "auto" = "interactive"): Promise<SubagentsJourneyResult> {
  if (platform === "claude") await validateClaudeCli(); else await validateCodexCli();
  const root = await canonicalMkdtemp(join(tmpdir(), `harness-subagents-${platform}-e2e-`));
  const projectRoot = join(root, "project");
  const stateRoot = join(root, "state");
  const cliStatusRoot = join(root, "cli-status");
  const diagnosticsPath = join(root, "structural-diagnostics.json");
  let server: Awaited<ReturnType<typeof startFakeAnthropicServer>> | Awaited<ReturnType<typeof startFakeOpenAiServer>> | undefined;
  try {
    const harnessRoot = await findHarnessRoot(process.cwd());
    const packageRoot = join(harnessRoot, "harness", "productivity", "subagents");
    const runtimeSource = join(root, "runtime", "src");
    await mkdir(projectRoot, { recursive: true });
    await cp(join(packageRoot, "runtime", "src"), runtimeSource, { recursive: true });
    const python = await pythonCommand(runtimeSource);
    const binRoot = await createRuntimeShim(root, python);
    await stagePayload(platform, packageRoot, projectRoot, python);
    await initializeRepository(projectRoot);

    const bridge = join(harnessRoot, "tests", "e2e", "dist", "tools", "subagents", "cli-bridge.js");
    await readFile(bridge, "utf8");
    const providerCommand = spawnableCommand(platform === "claude" ? "claude" : "codex", []);
    const configuredCommand = [process.execPath,bridge,"--provider",platform,providerCommand.file,...providerCommand.args];
    await mkdir(join(projectRoot, ".harness"), { recursive: true });
    await mkdir(stateRoot, { recursive: true });
    await writeFile(join(stateRoot, "config.json"), `${JSON.stringify({
      terminalCommand: [process.execPath, bridge, "--spawn"],
    }, null, 2)}\n`, "utf8");
    await writeFile(join(projectRoot, ".harness", "launch.json"), `${JSON.stringify({
      version: 1,
      autoRun: { provider: "claude" },
      providers: {
        claude: platform === "claude" ? { command: configuredCommand } : {},
        chatgpt: platform === "chatgpt" ? { command: configuredCommand } : {},
      },
      session: { stopWaitHours: 0.025 },
    }, null, 2)}\n`, "utf8");

    const commonEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${binRoot}${delimiter}${process.env.PATH ?? ""}`,
      PYTHONPATH: `${runtimeSource}${delimiter}${process.env.PYTHONPATH ?? ""}`,
      PYTHONIOENCODING: "utf-8",
      HARNESS_STATE_DIR: stateRoot,
      HARNESS_E2E_CLI_DIR: cliStatusRoot,
      HARNESS_E2E_DIAGNOSTICS: diagnosticsPath,
      HARNESS_E2E_CHILD_START_CHECKPOINT: "parent-waiting",
      HARNESS_E2E_CHILD_COMPLETE: CHILD_REPLY.split(":", 1)[0]!,
      HARNESS_E2E_PARENT_COMPLETE: PARENT_REPLY.split(":", 1)[0]!,
      NO_PROXY: "127.0.0.1,localhost",
    };

    let environment: NodeJS.ProcessEnv;
    if (platform === "claude") {
      const home = join(root, "home");
      const configRoot = join(home, ".claude");
      await mkdir(configRoot, { recursive: true });
      await writeFile(join(configRoot, "settings.json"), `${JSON.stringify({ theme: "dark" }, null, 2)}\n`, "utf8");
      await writeFile(join(home, ".claude.json"), `${JSON.stringify({
        hasCompletedOnboarding: true,
        projects: { [projectRoot]: { hasTrustDialogAccepted: true } },
      }, null, 2)}\n`, "utf8");
      server = await startFakeAnthropicServer({
        repoRoot: projectRoot,
        diagnosticsPath,
        scenarioCatalogHash,
        parseRequest: parseAnthropicMessagesRequest,
        transition: (request,repoRoot) => claudeTransition(request,repoRoot,mode),
      });
      environment = isolatedClaudeEnvironment(commonEnvironment, {
        HOME: home,
        USERPROFILE: home,
        ANTHROPIC_BASE_URL: server.baseUrl,
        ANTHROPIC_AUTH_TOKEN: server.authToken,
        CLAUDE_CONFIG_DIR: configRoot,
        CLAUDE_PROJECT_DIR: projectRoot,
        CLAUDE_CODE_PROJECT_DIR_NAME: "harness-subagents-e2e",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: "false",
        CLAUDE_CODE_MAX_RETRIES: "0",
        DISABLE_UPDATES: "1",
        DISABLE_AUTOUPDATER: "1",
        NO_PROXY: "127.0.0.1,localhost",
      });
    } else {
      const codexServer = await startFakeOpenAiServer({
        diagnosticsPath,
        scenarioCatalogHash,
        transition: (request) => codexTransition(request, projectRoot,mode),
      });
      server = codexServer;
      const codexHome = await prepareCodexHome({
        root,
        baseUrl: codexServer.baseUrl,
        trustedProjects: [projectRoot],
        extraConfig: ["[features]", "hooks = true"],
      });
      environment = isolatedCodexEnvironment(commonEnvironment, codexHome, codexServer.authToken);
    }

    const prompt = `${platform === "claude" ? "/" : "$"}work-with-agent ${PARENT_MARKER} Delegate the deterministic inspection to one ${mode} child.`;
    const launch = await execFileAsync(python, [
      "-c", "from subagents_runtime.cli import main; raise SystemExit(main())",
      "run", "--provider", platform, prompt,
    ], { cwd: projectRoot, env: environment, encoding: "utf8", windowsHide: true, timeout: 30_000 });
    if (!launch.stdout.includes("Started visible session")) throw new Error("subagents runtime did not report the visible parent launch");

    let statuses: readonly [CliStatus, CliStatus];
    try {
      statuses = await waitForStatuses(cliStatusRoot);
    } catch (error) {
      const structure = server.assertions().observations
        .map((item) => `${String(item.httpStatus)}:${String(item.checkpoint ?? item.diagnostic ?? "unknown")}`)
        .join(", ");
      throw new Error(`${error instanceof Error ? error.message : String(error)}; endpoint: ${structure}`);
    }
    const [childStatus, parentStatus] = statuses;
    requireCompleted(childStatus);
    requireCompleted(parentStatus);

    const parentId = /Started visible session ([0-9a-f-]+)/u.exec(launch.stdout)?.[1];
    if (!parentId) throw new Error('Parent launch did not expose its stable identity');
    await rm(join(cliStatusRoot,'child.json'),{force:true});
    const nextEnvironment = { ...environment, HARNESS_SESSION_ID: parentId, HARNESS_E2E_CHILD_COMPLETE: NEXT_REPLY.split(':',1)[0]! };
    // The original child process has exited. Continue the same provider transcript.
    await execFileAsync(python,["-c","from subagents_runtime.cli import main; raise SystemExit(main())","resume","agent-1",NEXT_MARKER],{cwd:projectRoot,env:nextEnvironment,encoding:"utf8",windowsHide:true,timeout:30_000});
    const [resumedChild] = await waitForStatuses(cliStatusRoot);
    requireCompleted(resumedChild);
    const visible = JSON.parse(await readFile(join(cliStatusRoot,'visible.json'),'utf8')) as { parent: number; child: number };
    if (visible.parent !== 1 || visible.child !== (mode === 'interactive' ? 2 : 0)) throw new Error('Execution mode did not preserve visible-terminal behavior');
    const assertions = server.assertions();
    const expectedCheckpoints = ["parent-request-write", "parent-waiting", ...(mode === "interactive" ? ["child-reply-armed"] : []), "child-complete", "parent-received-reply", ...(mode === "interactive" ? ["child-resume-reply-armed"] : []), "child-resume-complete"];
    const checkpoints = assertions.observations.flatMap((item) => typeof item.checkpoint === "string" ? [item.checkpoint] : []);
    const required = expectedCheckpoints.filter((item) => item !== "parent-waiting");
    if (checkpoints.some((item) => !expectedCheckpoints.includes(item)) || required.some((item) => !checkpoints.includes(item)) || checkpoints[0] !== "parent-request-write" || checkpoints.at(-1) !== "child-resume-complete") {
      throw new Error(`subagents checkpoint contract changed: ${checkpoints.join(", ")}`);
    }
    return {
      checkpoints,
      completedClis: [childStatus.role, parentStatus.role],
      requestFilesRemaining: await countRequestFiles(join(stateRoot, "runtime", "sessions")),
      unexpectedRequests: assertions.unexpectedRequests,
    };
  } finally {
    await server?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

interface HookSettings {
  readonly hooks: Record<string, Array<{ readonly hooks: Array<{ command: string; args?: string[] }> }>>;
}

async function stagePayload(platform: Platform, packageRoot: string, projectRoot: string, python: string): Promise<void> {
  if (platform === "claude") {
    await cp(join(packageRoot, "work-with-agent"), join(projectRoot, ".claude", "skills", "work-with-agent"), { recursive: true });
    await mkdir(join(projectRoot, ".claude"), { recursive: true });
    const settings = JSON.parse(await readFile(join(packageRoot, "claude", "settings.fragment.json"), "utf8")) as HookSettings;
    for (const groups of Object.values(settings.hooks)) {
      for (const group of groups) {
        for (const hook of group.hooks) {
          hook.command = python;
          hook.args = ["-m", "subagents_runtime.hooks", "--claude"];
        }
      }
    }
    await writeFile(join(projectRoot, ".claude", "settings.json"), `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    return;
  }
  const skillRoot = join(projectRoot, ".agents", "skills", "work-with-agent");
  await cp(join(packageRoot, "work-with-agent"), skillRoot, { recursive: true });
  await mkdir(join(skillRoot, "agents"), { recursive: true });
  await cp(join(packageRoot, "chatgpt", "agents", "work-with-agent.yaml"), join(skillRoot, "agents", "openai.yaml"));
  await mkdir(join(projectRoot, ".codex"), { recursive: true });
  const settings = JSON.parse(await readFile(join(packageRoot, "chatgpt", "hooks.fragment.json"), "utf8")) as HookSettings;
  for (const groups of Object.values(settings.hooks)) {
    for (const group of groups) {
      for (const hook of group.hooks) hook.command = `${python} -m subagents_runtime.hooks --chatgpt`;
    }
  }
  await writeFile(join(projectRoot, ".codex", "hooks.json"), `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

async function createRuntimeShim(root: string, python: string): Promise<string> {
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  const helper = join(bin, "request.cjs");
  await writeFile(helper, [
    'const { spawnSync } = require("node:child_process");',
    'const { writeFileSync } = require("node:fs");',
    'const request = Buffer.from(process.argv[2], "base64").toString();',
    'const content = Buffer.from(process.argv[3], "base64");',
    'writeFileSync(request, content);',
    `const result = spawnSync(${JSON.stringify(python)}, ["-c", "from subagents_runtime.cli import main; raise SystemExit(main())", "ask", process.argv[4]], { cwd: process.cwd(), env: process.env, stdio: "inherit", windowsHide: true });`,
    'process.exit(result.status ?? 1);',
    '',
  ].join("\n"), "utf8");
  await writeFile(join(bin, "harness"), `#!/bin/sh\nexec ${shellQuote(python)} -c 'from subagents_runtime.cli import main; raise SystemExit(main())' "$@"\n`, { encoding: "utf8", mode: 0o755 });
  if (process.platform === "win32") {
    await writeFile(join(bin, "harness-subagents-hook.cmd"), `@echo off\r\n"${python}" -m subagents_runtime.hooks %*\r\n`, "utf8");
    await writeFile(join(bin, "harness.cmd"), `@echo off\r\n"${python}" -c "from subagents_runtime.cli import main; raise SystemExit(main())" %*\r\n`, "utf8");
    await writeFile(join(bin, "harness-e2e-request.cmd"), `@echo off\r\n"${process.execPath}" "${helper}" %*\r\n`, "utf8");
  } else {
    await writeFile(join(bin, "harness-subagents-hook"), `#!/bin/sh\nexec ${shellQuote(python)} -m subagents_runtime.hooks "$@"\n`, { encoding: "utf8", mode: 0o755 });
    await writeFile(join(bin, "harness-e2e-request"), `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(helper)} "$@"\n`, { encoding: "utf8", mode: 0o755 });
  }
  return bin;
}

async function pythonCommand(runtimeSource: string): Promise<string> {
  for (const candidate of ["python3", "python", "py"]) {
    try {
      const result = await execFileAsync(candidate, ["-c", "import sys, yaml, subagents_runtime; assert sys.version_info >= (3, 11); print(sys.executable)"], {
        env: { ...process.env, PYTHONPATH: `${runtimeSource}${delimiter}${process.env.PYTHONPATH ?? ""}` },
        encoding: "utf8", windowsHide: true,
      });
      return result.stdout.trim();
    } catch { }
  }
  throw new Error("subagents E2E requires Python 3.11 or newer with PyYAML");
}

async function initializeRepository(projectRoot: string): Promise<void> {
  await execFileAsync("git", ["init", "--quiet"], { cwd: projectRoot, windowsHide: true });
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

async function waitForStatuses(root: string): Promise<readonly [CliStatus, CliStatus]> {
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    const child = await readStatus(join(root, "child.json"));
    const parent = await readStatus(join(root, "parent.json"));
    if (child !== undefined && child.status !== "completed" || parent !== undefined && parent.status !== "completed") {
      throw new Error(`real CLI failed before delegation completed: ${JSON.stringify({ child, parent })}`);
    }
    if (child !== undefined && parent !== undefined) return [child, parent];
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error("timed out waiting for structural child and parent CLI statuses");
}

async function readStatus(path: string): Promise<CliStatus | undefined> {
  try { return JSON.parse(await readFile(path, "utf8")) as CliStatus; }
  catch { return undefined; }
}

function requireCompleted(status: CliStatus): void {
  if (status.status !== "completed" || !status.markerSeen || status.timedOut) {
    throw new Error(`real ${status.role} CLI failed: ${JSON.stringify(status)}`);
  }
}

async function countRequestFiles(root: string): Promise<number> {
  try {
    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && /\.md(?:\.running)?$/u.test(entry.name)).length;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return 0;
    throw error;
  }
}

async function findHarnessRoot(start: string): Promise<string> {
  let candidate = resolve(start);
  while (true) {
    try {
      await readFile(join(candidate, "harness", "productivity", "subagents", "harness.toml"));
      return candidate;
    } catch { }
    const parent = dirname(candidate);
    if (parent === candidate) throw new Error("could not locate the Harness checkout");
    candidate = parent;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
