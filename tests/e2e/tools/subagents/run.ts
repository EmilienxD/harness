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
  SKILL_RESOURCE,
  SKILL_RECEIPT,
  type SkillSelection,
  PARENT_MARKER,
  PARENT_REPLY,
  NEXT_MARKER,
  NEXT_REPLY,
  RECOVERY_MARKER,
  RECOVERY_PARENT_REPLY,
  CHILD_PROGRESS,
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
  readonly cwd: string;
}

export interface SubagentsJourneyResult {
  readonly checkpoints: readonly string[];
  readonly completedClis: readonly string[];
  readonly requestFilesRemaining: number;
  readonly unexpectedRequests: number;
  readonly recoveredSessions: number;
  readonly inferenceRequests?: number;
  readonly shutdownsBeforeResult?: number;
}

export async function runSubagentsRecoveryJourney(platform: Platform): Promise<SubagentsJourneyResult> {
  return runSubagentsJourney(platform, "auto", true);
}

export async function runSubagentsRootJourney(platform: Platform): Promise<SubagentsJourneyResult> {
  return runSubagentsJourney(platform, "auto", false, true);
}

export async function runSubagentsJourney(platform: Platform, mode: "interactive" | "auto" = "interactive", recovery = false, alternateRoot = false, options: { shutdownBeforeResult?: boolean; stopFallback?: boolean; failedWrite?: boolean; skill?: SkillSelection } = {}): Promise<SubagentsJourneyResult> {
  const shutdownBeforeResult = options.shutdownBeforeResult ?? false;
  if (platform === "claude") await validateClaudeCli(); else await validateCodexCli();
  const root = await canonicalMkdtemp(join(tmpdir(), `harness-subagents-${platform}-e2e-`));
  const projectRoot = join(root, "project");
  const worktreeRoot = join(root, "worktree");
  const stateRoot = join(root, "state");
  const cliStatusRoot = join(root, "cli-status");
  const diagnosticsPath = join(root, "structural-diagnostics.json");
  let server: Awaited<ReturnType<typeof startFakeAnthropicServer>> | Awaited<ReturnType<typeof startFakeOpenAiServer>> | undefined;
  let releaseParentWait: (() => void) | undefined;
  const parentWaiting = new Promise<void>((resolve) => { releaseParentWait = resolve; });
  let interruptionReady = false;
  let cleanupExecutions: (() => Promise<void>) | undefined;
  let releaseInterruption: (() => void) | undefined;
  const interruption = new Promise<void>((resolvePromise) => { releaseInterruption = resolvePromise; });
  try {
    const harnessRoot = await findHarnessRoot(process.cwd());
    const packageRoot = join(harnessRoot, "harness", "productivity", "subagents");
    const runtimeSource = join(root, "runtime", "src");
    await mkdir(projectRoot, { recursive: true });
    await cp(join(packageRoot, "runtime", "src"), runtimeSource, { recursive: true });
    await cp(join(packageRoot, "subagents-toolkit"), join(root, "subagents-toolkit"), { recursive: true });
    const python = await pythonCommand(runtimeSource);
    const binRoot = await createRuntimeShim(root, python);
    await stagePayload(platform, packageRoot, projectRoot, python);
    const selectedRoot = join(projectRoot, platform === "claude" ? ".claude" : ".agents", "skills", "e2e-selected");
    await mkdir(selectedRoot, { recursive: true });
    await writeFile(join(selectedRoot, "SKILL.md"), `---\nname: e2e-selected\ndescription: Fixture explicit skill.\ndisable-model-invocation: true\n---\n${SKILL_RESOURCE}\nWrite the selection receipt.\n`);
    if (platform === "chatgpt") {
      await mkdir(join(selectedRoot, "agents"));
      await writeFile(join(selectedRoot, "agents", "openai.yaml"), "policy:\n  allow_implicit_invocation: false\n");
    }

    if (options.stopFallback) {
      const path = join(projectRoot, platform === "claude" ? ".claude/settings.json" : ".codex/hooks.json");
      const settings = JSON.parse(await readFile(path, "utf8")) as HookSettings;
      delete settings.hooks.PostToolUse;
      delete settings.hooks.PostToolUseFailure;
      await writeFile(path, JSON.stringify(settings));
    }
    if (shutdownBeforeResult) {
      if (platform !== "chatgpt" || mode !== "auto" || recovery || alternateRoot) throw new Error("Shutdown regression requires automatic Codex delegation");
      const hooksPath = join(projectRoot, ".codex", "hooks.json");
      const settings = JSON.parse(await readFile(hooksPath, "utf8")) as HookSettings;
      const hook = join(harnessRoot, "tests", "e2e", "tools", "subagents", "shutdown-hook.py");
      for (const groups of Object.values(settings.hooks)) {
        for (const group of groups) {
          for (const entry of group.hooks) entry.command = `${python} ${hook}`;
        }
      }
      await writeFile(hooksPath, JSON.stringify(settings));
    }
    await initializeRepository(projectRoot);
    if (alternateRoot) {
      await execFileAsync("git", ["-c", "user.name=Harness E2E", "-c", "user.email=harness-e2e@example.invalid", "commit", "--quiet", "--allow-empty", "-m", "fixture"], { cwd: projectRoot, windowsHide: true });
      await execFileAsync("git", ["worktree", "add", "--quiet", "--detach", worktreeRoot, "HEAD"], { cwd: projectRoot, windowsHide: true });
      await stagePayload(platform, packageRoot, worktreeRoot, python);
    }

    const bridge = join(harnessRoot, "tests", "e2e", "dist", "tools", "subagents", "cli-bridge.js");
    await readFile(bridge, "utf8");
    const providerCommand = spawnableCommand(platform === "claude" ? "claude" : "codex", []);
    const configuredCommand = [process.execPath,bridge,"--provider",platform,providerCommand.file,...providerCommand.args];
    await mkdir(join(projectRoot, ".harness"), { recursive: true });
    await mkdir(stateRoot, { recursive: true });
    await writeFile(join(stateRoot, "config.json"), `${JSON.stringify({
      terminalCommand: [process.execPath, bridge, "--spawn"],
    }, null, 2)}\n`, "utf8");
    await writeFile(join(projectRoot, ".harness", "config.json"), `${JSON.stringify({
      version: 1,
      autoRun: { provider: "claude" },
      providers: {
        claude: platform === "claude" ? { command: configuredCommand } : {},
        chatgpt: platform === "chatgpt" ? { command: configuredCommand } : {},
      },
      session: { stopWaitHours: 0.025 },
    }, null, 2)}\n`, "utf8");
    if (alternateRoot) {
      await mkdir(join(worktreeRoot, ".harness"), { recursive: true });
      await cp(join(projectRoot, ".harness", "config.json"), join(worktreeRoot, ".harness", "config.json"));
    }

    const commonEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${binRoot}${delimiter}${process.env.PATH ?? ""}`,
      PYTHONPATH: `${runtimeSource}${delimiter}${process.env.PYTHONPATH ?? ""}`,
      PYTHONIOENCODING: "utf-8",
      HARNESS_STATE_DIR: stateRoot,
      HARNESS_E2E_CLI_DIR: cliStatusRoot,
      HARNESS_E2E_CHILD_COMPLETE: CHILD_REPLY.split(":", 1)[0]!,
      HARNESS_E2E_PARENT_COMPLETE: PARENT_REPLY.split(":", 1)[0]!,
      HARNESS_E2E_FAIL_REQUEST: options.failedWrite ? "1" : "0",
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
        projects: { [projectRoot]: { hasTrustDialogAccepted: true }, ...(alternateRoot ? { [worktreeRoot]: { hasTrustDialogAccepted: true } } : {}) },
      }, null, 2)}\n`, "utf8");
      server = await startFakeAnthropicServer({
        repoRoot: projectRoot,
        diagnosticsPath,
        scenarioCatalogHash,
        parseRequest: parseAnthropicMessagesRequest,
        transition: async (request,repoRoot) => {
          const response = claudeTransition(request,repoRoot,mode,recovery,alternateRoot,options.stopFallback,options.skill);
          if (response.checkpoint === "parent-waiting") releaseParentWait?.();
          if (options.skill && options.skill !== "missing" && response.checkpoint.startsWith("child-")) await parentWaiting;
          if (response.checkpoint === "child-interruption-ready") {
            interruptionReady = true;
            await interruption;
          }
          return response;
        },
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
        transition: async (request) => {
          const response = codexTransition(request,projectRoot,mode,recovery,alternateRoot,options.stopFallback,options.skill);
          if (response.checkpoint === "parent-waiting") releaseParentWait?.();
          if (options.skill && options.skill !== "missing" && response.checkpoint.startsWith("child-")) await parentWaiting;
          if (response.checkpoint === "child-interruption-ready") {
            interruptionReady = true;
            await interruption;
          }
          return response;
        },
      });
      server = codexServer;
      const codexHome = await prepareCodexHome({
        root,
        baseUrl: codexServer.baseUrl,
        trustedProjects: alternateRoot ? [projectRoot, worktreeRoot] : [projectRoot],
        extraConfig: ["[features]", "hooks = true"],
      });
      environment = isolatedCodexEnvironment(commonEnvironment, codexHome, codexServer.authToken);
    }

    cleanupExecutions = async () => {
      const remaining = await executionSnapshot(python, projectRoot, environment);
      for (const item of remaining.filter((execution) => !execution.dead)) {
        for (const pid of [item.supervisor_pid,item.provider_pid]) {
          if (pid) await killProcessTree(pid, true);
        }
      }
    };
    const prompt = `${platform === "claude" ? "/" : "$"}subagents-toolkit ${PARENT_MARKER} Delegate the deterministic inspection to one ${mode} child${alternateRoot ? " in the ../worktree worktree" : ""}.`;
    const launch = await execFileAsync(python, [
      "-c", "from subagents_runtime.cli import main; raise SystemExit(main())",
      "run", "--provider", platform, prompt,
    ], { cwd: projectRoot, env: environment, encoding: "utf8", windowsHide: true, timeout: 30_000 });
    if (!launch.stdout.includes("Started visible session")) throw new Error("subagents runtime did not report the visible parent launch");

    const parentId = /Started visible session ([0-9a-f-]+)/u.exec(launch.stdout)?.[1];
    if (!parentId) throw new Error('Parent launch did not expose its stable identity');
    if (options.skill === "missing") {
      await waitForCheckpoint(async () => (await readStatus(join(cliStatusRoot, "parent.json"))) !== undefined);
      requireCompleted((await readStatus(join(cliStatusRoot, "parent.json")))!);
      if (await readStatus(join(cliStatusRoot, "child.json"))) throw new Error("Missing skill started a child CLI");
      const result = await execFileAsync(python, ["-c", "import json; from subagents_runtime.storage import connect; db=connect(); print(json.dumps(db.execute('SELECT state,reason FROM requests').fetchall()))"], { cwd: projectRoot, env: environment, windowsHide: true, timeout: 10_000 });
      const rows = JSON.parse(result.stdout) as [string, string][];
      if (rows.length !== 1 || rows[0]![0] !== "failed" || !rows[0]![1].includes("missing-e2e")) throw new Error("Missing skill failure was not persisted");
      const assertions = server.assertions();
      if (assertions.inferenceRequests !== 3 || assertions.unexpectedRequests !== 0 || await countRequestFiles(join(stateRoot, "inboxes")) !== 0) throw new Error("Missing skill request count or cleanup differed");
      return { checkpoints: ["parent-inbox-enable", "parent-request-write", "parent-received-failure"], completedClis: ["parent"], requestFilesRemaining: 0, unexpectedRequests: 0, recoveredSessions: 0, inferenceRequests: 3 };
    }
    if (recovery) {
      try {
        await waitForCheckpoint(async () => {
          const child = await readStatus(join(cliStatusRoot, "child.json"));
          if (child) throw new Error(`Child exited before interruption: ${JSON.stringify(child)}`);
          return interruptionReady && server!.assertions().observations.some((item) => item.checkpoint === "parent-waiting");
        });
      } catch (error) { throw structuralFailure(error, server); }
      if (await readFile(join(projectRoot, "child-progress.txt"), "utf8") !== CHILD_PROGRESS) throw new Error("Child checkpoint did not execute through the real CLI");
      const before = await executionSnapshot(python, projectRoot, environment);
      if (before.length !== 2 || before.some((item) => !item.provider_session_id || !item.supervisor_pid)) throw new Error("Both saved sessions must be running before interruption");
      // Kill whole owned trees, including supervisors and hooks, so no graceful
      // exit callback can settle the child's pending request for the runtime.
      for (const item of before) await killProcessTree(item.supervisor_pid!);
      releaseInterruption!();
      await waitForCheckpoint(async () => {
        const snapshot = await executionSnapshot(python, projectRoot, environment);
        return snapshot.every((item) => item.dead);
      });
      // The visible-terminal driver is outside the killed supervisor tree.
      await waitForCheckpoint(async () => (await readStatus(join(cliStatusRoot, "parent.json"))) !== undefined);
      await rm(join(cliStatusRoot, "parent.json"), { force: true });
      await rm(join(cliStatusRoot, "child.json"), { force: true });
      await execFileAsync(python, ["-c", "from subagents_runtime.cli import main; raise SystemExit(main())", "resume", parentId, RECOVERY_MARKER], {
        cwd: projectRoot,
        env: { ...environment, HARNESS_E2E_CHILD_COMPLETE: NEXT_REPLY.split(":",1)[0]!, HARNESS_E2E_PARENT_COMPLETE: RECOVERY_PARENT_REPLY.split(":",1)[0]! },
        encoding: "utf8", windowsHide: true, timeout: 30_000,
      });
      let statuses: readonly [CliStatus, CliStatus];
      try { statuses = await waitForStatuses(cliStatusRoot); }
      catch (error) { throw structuralFailure(error, server); }
      statuses.forEach(requireCompleted);
      const after = await executionSnapshot(python, projectRoot, environment);
      if (after.length !== 2 || before.some((original) => !after.some((item) => item.session_id === original.session_id && item.provider_session_id === original.provider_session_id && item.parent_session_id === original.parent_session_id))) {
        throw new Error("Recovery changed the stable identities or saved provider conversations");
      }
      const assertions = server.assertions();
      const checkpoints = assertions.observations.flatMap((item) => typeof item.checkpoint === "string" ? [item.checkpoint] : []);
      for (const required of ["parent-request-write", "child-progress-write", "parent-waiting", "child-interruption-ready", "parent-resume-request-write", "child-resume-complete", "parent-received-resumed-reply"]) {
        if (!checkpoints.includes(required)) throw new Error(`Missing recovery checkpoint: ${required}`);
      }
      const requestFilesRemaining = await countRequestFiles(join(stateRoot,"inboxes"));
      if (requestFilesRemaining !== 0 || assertions.unexpectedRequests !== 0) throw new Error("Recovery left request files or unexpected inference requests");
      return { checkpoints, completedClis: statuses.map((item) => item.role), requestFilesRemaining, unexpectedRequests: assertions.unexpectedRequests, recoveredSessions: 2 };
    }

    if (shutdownBeforeResult) {
      await waitForCheckpoint(async () => (await readdir(cliStatusRoot).catch(() => [])).some((name) => name.startsWith("shutdown-")));
      const receipt = (await readdir(cliStatusRoot)).find((name) => name.startsWith("shutdown-"))!;
      const shutdown = JSON.parse(await readFile(join(cliStatusRoot, receipt), "utf8"));
      if (shutdown.state !== "pending" || shutdown.hasReply) throw new Error(`SessionEnd preempted the supervisor result: ${JSON.stringify(shutdown)}`);
    }
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
    if (childStatus.cwd !== (alternateRoot ? worktreeRoot : projectRoot) || parentStatus.cwd !== projectRoot) throw new Error("Real CLI launched from the wrong root");

    await rm(join(cliStatusRoot,'child.json'),{force:true});
    const nextEnvironment = { ...environment, HARNESS_SESSION_ID: parentId, HARNESS_E2E_CHILD_COMPLETE: NEXT_REPLY.split(':',1)[0]! };
    // The original child process has exited. Continue the same provider transcript.
    await execFileAsync(python,["-c","from subagents_runtime.cli import main; raise SystemExit(main())","resume","agent-1",NEXT_MARKER],{cwd:projectRoot,env:nextEnvironment,encoding:"utf8",windowsHide:true,timeout:30_000});
    const [resumedChild] = await waitForStatuses(cliStatusRoot);
    requireCompleted(resumedChild);
    if (resumedChild.cwd !== (alternateRoot ? worktreeRoot : projectRoot)) throw new Error("Resumed child changed its root");
    const visible = JSON.parse(await readFile(join(cliStatusRoot,'visible.json'),'utf8')) as { parent: number; child: number };
    if (visible.parent !== 1 || visible.child !== (mode === 'interactive' ? 2 : 0)) throw new Error('Execution mode did not preserve visible-terminal behavior');
    const assertions = server.assertions();
    const expectedCheckpoints = ["parent-inbox-enable", "parent-request-write", ...(options.skill === "found" ? ["child-skill-receipt"] : []), "parent-waiting", ...(mode === "interactive" ? ["child-reply-armed"] : []), "child-complete", "parent-received-reply", ...(mode === "interactive" ? ["child-resume-reply-armed"] : []), "child-resume-complete"];
    const checkpoints = assertions.observations.flatMap((item) => typeof item.checkpoint === "string" ? [item.checkpoint] : []);
    const required = expectedCheckpoints.filter((item) => item !== "parent-waiting");
    if (checkpoints.some((item) => !expectedCheckpoints.includes(item)) || required.some((item) => !checkpoints.includes(item)) || checkpoints[0] !== "parent-inbox-enable" || checkpoints.at(-1) !== "child-resume-complete") {
      throw new Error(`subagents checkpoint contract changed: ${checkpoints.join(", ")}`);
    }
    if (options.skill === "none" && assertions.inferenceRequests !== 6) throw new Error("No-skill inference count differed");
    if (options.skill === "found") {
      const receipt = JSON.parse(await readFile(join(projectRoot, SKILL_RECEIPT), "utf8"));
      if (receipt.skill !== "e2e-selected") throw new Error("Native child skill did not produce its receipt");
      if (assertions.inferenceRequests !== 7) throw new Error("Explicit skill inference count differed");
    }
    let shutdownsBeforeResult: number | undefined;
    if (shutdownBeforeResult) {
      const receipts = (await readdir(cliStatusRoot)).filter((name) => name.startsWith("shutdown-"));
      for (const name of receipts) {
        const receipt = JSON.parse(await readFile(join(cliStatusRoot, name), "utf8"));
        if (receipt.state !== "pending" || receipt.hasReply) throw new Error("Resumed child shutdown preempted the supervisor result");
      }
      shutdownsBeforeResult = receipts.length;
      const result = await execFileAsync(python, ["-c", [
        "import json",
        "from subagents_runtime.storage import connect",
        "with connect() as db:",
        " rows=db.execute('SELECT state,reply,acknowledged_at IS NOT NULL FROM requests ORDER BY created_at,rowid').fetchall()",
        "print(json.dumps([list(row) for row in rows]))",
      ].join("\n")], { cwd: projectRoot, env: environment, encoding: "utf8", windowsHide: true, timeout: 10_000 });
      const rows = JSON.parse(result.stdout) as [string, string, number][];
      if (rows.length !== 2 || rows[0]?.[0] !== "succeeded" || rows[0][1] !== CHILD_REPLY || rows[0][2] !== 1 || rows[1]?.[0] !== "succeeded" || rows[1][1] !== NEXT_REPLY) {
        throw new Error("Automatic shutdown regression did not persist and acknowledge the successful replies");
      }
    }
    return {
      ...(shutdownsBeforeResult === undefined ? {} : { shutdownsBeforeResult, inferenceRequests: assertions.observations.length }),
      checkpoints,
      completedClis: [childStatus.role, parentStatus.role],
      requestFilesRemaining: await countRequestFiles(join(stateRoot, "inboxes")),
      unexpectedRequests: assertions.unexpectedRequests,
      recoveredSessions: 0,
    };
  } finally {
    releaseInterruption?.();
    releaseParentWait?.();
    try { await cleanupExecutions?.(); }
    finally {
      try { await server?.close(); }
      finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
    }
  }
}

interface ExecutionSnapshot {
  readonly session_id: string;
  readonly parent_session_id: string | null;
  readonly provider_session_id: string | null;
  readonly supervisor_pid: number | null;
  readonly provider_pid: number | null;
  readonly dead: boolean;
}

async function executionSnapshot(python: string, cwd: string, env: NodeJS.ProcessEnv): Promise<ExecutionSnapshot[]> {
  const script = [
    "import json, sqlite3",
    "from subagents_runtime.storage import connect",
    "from subagents_runtime.processes import birth_identity, process_alive",
    "with connect() as db:",
    " db.row_factory = sqlite3.Row",
    " rows = [dict(row) for row in db.execute('SELECT e.session_id,s.parent_session_id,s.provider_session_id,e.supervisor_pid,e.supervisor_birth,e.provider_pid,e.provider_birth FROM executions e JOIN sessions s ON s.id=e.session_id WHERE e.superseded_at IS NULL AND e.rowid=(SELECT MAX(x.rowid) FROM executions x WHERE x.session_id=e.session_id)')]",
    "for row in rows:",
    " row['dead'] = all(not pid or not process_alive(pid) or (birth is not None and birth_identity(pid) not in (None,birth)) for pid,birth in [(row['supervisor_pid'],row.pop('supervisor_birth')),(row['provider_pid'],row.pop('provider_birth'))])",
    "print(json.dumps(rows))",
  ].join("\n");
  const result = await execFileAsync(python, ["-c",script], {cwd,env,encoding:"utf8",windowsHide:true,timeout:10_000});
  return JSON.parse(result.stdout) as ExecutionSnapshot[];
}

export async function killProcessTree(pid: number, allowExited = false): Promise<void> {
  if (process.platform === "win32") {
    try { await execFileAsync("taskkill",["/PID",String(pid),"/T","/F"],{windowsHide:true,timeout:10_000}); }
    catch {
      // A supervisor can exit (or reap its child) between the snapshot and taskkill.
      // Accept only observed absence, not a locale/version-dependent taskkill exit code.
      let exited = false;
      try { process.kill(pid, 0); }
      catch (error) { exited = (error as NodeJS.ErrnoException).code === "ESRCH"; }
      if (!allowExited || !exited) throw new Error("Could not terminate an owned real CLI process tree");
    }
    return;
  }
  const listing = await execFileAsync("ps",["-eo","pid=,ppid="],{encoding:"utf8",timeout:10_000});
  const processes = listing.stdout.trim().split("\n").map((line) => line.trim().split(/\s+/u).map(Number));
  const owned = [pid];
  for (let index = 0; index < owned.length; index++) {
    for (const [child,parent] of processes) if (parent === owned[index] && child) owned.push(child);
  }
  for (const target of owned) {
    try { process.kill(target,"SIGKILL"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }
}

async function waitForCheckpoint(ready: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now()+90_000;
  while (Date.now()<deadline) {
    if (await ready()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise,100));
  }
  throw new Error("Timed out waiting for the real CLI lifecycle checkpoint");
}

function structuralFailure(error: unknown, server: NonNullable<Awaited<ReturnType<typeof startFakeAnthropicServer>> | Awaited<ReturnType<typeof startFakeOpenAiServer>>>): Error {
  const structure = server.assertions().observations.map((item) => `${String(item.httpStatus)}:${String(item.checkpoint ?? item.diagnostic ?? "unknown")}`).join(", ");
  return new Error(`${error instanceof Error ? error.message : "Real CLI recovery failed"}; endpoint: ${structure}`);
}

interface HookSettings {
  readonly hooks: Record<string, Array<{ readonly hooks: Array<{ command: string; args?: string[] }> }>>;
}

async function stagePayload(platform: Platform, packageRoot: string, projectRoot: string, python: string): Promise<void> {
  if (platform === "claude") {
    const toolkitRoot = join(projectRoot, ".claude", "skills", "subagents-toolkit");
    await mkdir(toolkitRoot, { recursive: true });
    await cp(join(packageRoot, "subagents-toolkit", "SKILL.md"), join(toolkitRoot, "SKILL.md"));
    await cp(join(packageRoot, "subagents-toolkit", "scripts"), join(toolkitRoot, "scripts"), { recursive: true });
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
  const toolkitRoot = join(projectRoot, ".agents", "skills", "subagents-toolkit");
  await mkdir(join(toolkitRoot, "agents"), { recursive: true });
  await cp(join(packageRoot, "subagents-toolkit", "SKILL.md"), join(toolkitRoot, "SKILL.md"));
  await cp(join(packageRoot, "subagents-toolkit", "scripts"), join(toolkitRoot, "scripts"), { recursive: true });
  await cp(join(packageRoot, "subagents-toolkit", "chatgpt", "openai.yaml"), join(toolkitRoot, "agents", "openai.yaml"));
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
    'const { writeFileSync } = require("node:fs");',
    'const request = Buffer.from(process.argv[2], "base64").toString();',
    'const content = Buffer.from(process.argv[3], "base64");',
    // Match Windows PowerShell's UTF-8 BOM; hooks alone must discover the request.
    'writeFileSync(request, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), content]));',
    'process.exitCode = process.env.HARNESS_E2E_FAIL_REQUEST === "1" ? 7 : 0;',
    '',
  ].join("\n"), "utf8");
  await writeFile(join(bin, "harness"), `#!/bin/sh\nexec ${shellQuote(python)} -c 'from subagents_runtime.cli import main; raise SystemExit(main())' "$@"\n`, { encoding: "utf8", mode: 0o755 });
  await writeFile(join(bin, "harness-e2e-request"), `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(helper)} "$@"\n`, { encoding: "utf8", mode: 0o755 });
  if (process.platform === "win32") {
    await writeFile(join(bin, "harness-subagents-hook.cmd"), `@echo off\r\n"${python}" -m subagents_runtime.hooks %*\r\n`, "utf8");
    await writeFile(join(bin, "harness.cmd"), `@echo off\r\n"${python}" -c "from subagents_runtime.cli import main; raise SystemExit(main())" %*\r\n`, "utf8");
    await writeFile(join(bin, "harness-e2e-request.cmd"), `@echo off\r\n"${process.execPath}" "${helper}" %*\r\n`, "utf8");
  } else {
    await writeFile(join(bin, "harness-subagents-hook"), `#!/bin/sh\nexec ${shellQuote(python)} -m subagents_runtime.hooks "$@"\n`, { encoding: "utf8", mode: 0o755 });
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
    if (child !== undefined && child.status !== "completed" || parent !== undefined && parent.status !== "completed" && !(parent.exitCode === 0 && !parent.markerSeen && !parent.timedOut)) {
      throw new Error(`real CLI failed before delegation completed: ${JSON.stringify({ child, parent })}`);
    }
    if (child?.status === "completed" && parent?.status === "completed") return [child, parent];
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
