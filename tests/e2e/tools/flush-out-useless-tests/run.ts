import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { findHarnessRoot, runFixtureInstaller } from "../../core/installer.js";
import { createPiFixture } from "../../core/pi-fixture.js";
import type { PiEvent } from "../../core/pi.js";
import { APPROVAL_MARKER, AUDIT_MARKER, flushScenario, KEPT_TEST, ORIGINAL_TEST, PRODUCTION } from "./scenario.js";

const TOOL = "flush-out-useless-tests";

export async function runFlushOutUselessTestsJourney(scope: "project" | "user", mode: "json" | "rpc") {
  const shell = process.platform === "win32" ? "powershell" : "bash";
  const fixture = await createPiFixture(flushScenario(shell));
  try {
    const project = fixture.workspace.projectRoot;
    await mkdir(join(project, "src"));
    await mkdir(join(project, "tests"));
    await writeFile(join(project, "src", "sum.cjs"), PRODUCTION, "utf8");
    await writeFile(join(project, "tests", "sum.test.cjs"), ORIGINAL_TEST, "utf8");
    const settingsFile = join(project, ".pi", "settings.json");
    const settings = JSON.parse(await readFile(settingsFile, "utf8")) as Record<string, unknown>;
    settings.defaultTools = ["read", "edit", "write", shell];
    await writeFile(settingsFile, `${JSON.stringify(settings)}\n`, "utf8");
    const settingsBefore = await readFile(settingsFile, "utf8");
    const skillRoot = join(scope === "project" ? join(project, ".pi") : fixture.workspace.agentDir, "skills", TOOL);
    const skillFile = join(skillRoot, "SKILL.md");
    await runFixtureInstaller(fixture.workspace, "install", [TOOL], { scope, dryRun: true });
    if (await exists(skillFile)) throw new Error("Pi installer dry-run wrote the skill");
    await runFixtureInstaller(fixture.workspace, "install", [TOOL], { scope });
    const root = await findHarnessRoot();
    const sourceHash = hash(await readFile(join(root, "harness", "building", TOOL, "SKILL.md")));
    if (hash(await readFile(skillFile)) !== sourceHash) throw new Error("Pi installation differs from the actual shared skill payload");
    if ((await readdir(skillRoot)).join(",") !== "SKILL.md") throw new Error("Pi installation included provider-specific metadata");
    const repeat = await runFixtureInstaller(fixture.workspace, "install", [TOOL], { scope });
    if ((repeat.results as { status: string }[])[0]?.status !== "unchanged") throw new Error("Pi installation is not idempotent");
    if (scope === "user") {
      const otherAgent = { ...fixture.workspace, env: { ...fixture.workspace.env, PI_CODING_AGENT_DIR: join(fixture.root, "other-pi-agent") } };
      await runFixtureInstaller(otherAgent, "uninstall", [TOOL], { scope });
      if (!await exists(skillFile)) throw new Error("Changing the Pi agent directory redirected removal into another installation");
      const colocatedProject = { ...fixture.workspace, projectRoot: fixture.workspace.agentDir };
      await runFixtureInstaller(colocatedProject, "install", [TOOL]);
      await runFixtureInstaller(colocatedProject, "uninstall", [TOOL]);
      if (!await exists(skillFile)) throw new Error("Project removal in the Pi agent directory removed its user installation");
    }

    const rpc = fixture.rpc();
    const discovered = await rpc.request("get_commands");
    const commands = (discovered.data as { commands?: { name: string; source: string; sourceInfo?: { path?: string } }[] }).commands ?? [];
    const command = commands.find((item) => item.name === `skill:${TOOL}` && item.source === "skill");
    if (!command?.sourceInfo?.path || resolve(command.sourceInfo.path) !== resolve(skillFile)) throw new Error("Pi did not natively discover the receipt-owned skill");
    const prompt = `/skill:${TOOL} tests/sum.test.cjs ${AUDIT_MARKER}`;
    const audit = mode === "json" ? await fixture.runJson({ prompt, sessionId: "harness-flush" }) : await rpc.prompt(prompt);
    if (audit.status !== "success") throw new Error("Pi skill audit did not complete successfully");
    const unchangedBeforeApproval = await readFile(join(project, "tests", "sum.test.cjs"), "utf8") === ORIGINAL_TEST;
    if (!unchangedBeforeApproval || audit.toolExecutions.some((tool) => tool.name === "edit" || tool.name === "write")) throw new Error("Audit changed tests before approval");
    const noReportFile = !(await readdir(project)).some((file) => file.endsWith(".md"));
    const approval = `Approved: delete only the tautological test. ${APPROVAL_MARKER}`;
    let cleanup;
    if (mode === "json") {
      const sessions = await readdir(fixture.workspace.sessionsDir);
      const session = sessions.find((file) => file.includes("harness-flush"));
      if (!session) throw new Error("Pi audit has no exact saved conversation to resume");
      cleanup = await fixture.runJson({ prompt: approval, sessionFile: join(fixture.workspace.sessionsDir, session) });
    } else cleanup = await rpc.prompt(approval);
    if (cleanup.status !== "success") throw new Error("Pi approved cleanup did not complete successfully");
    if (await readFile(join(project, "tests", "sum.test.cjs"), "utf8") !== KEPT_TEST) throw new Error("Pi cleanup did not preserve the independent behavioral test");
    if (await readFile(join(project, "src", "sum.cjs"), "utf8") !== PRODUCTION) throw new Error("Test cleanup changed production code");
    if ([...audit.toolExecutions, ...cleanup.toolExecutions].some((tool) => tool.isError)) throw new Error("Pi test audit had a failed native tool operation");

    // Cross-provider receipts must keep the ChatGPT copy when the Pi selection is removed.
    await runFixtureInstaller(fixture.workspace, "install", [TOOL], { platform: "chatgpt" });
    const chatgptFile = join(project, ".agents", "skills", TOOL, "SKILL.md");
    await runFixtureInstaller(fixture.workspace, "uninstall", [TOOL], { scope });
    const removed = !await exists(skillFile);
    const chatgptPreserved = hash(await readFile(chatgptFile)) === sourceHash;
    const settingsPreserved = await readFile(settingsFile, "utf8") === settingsBefore;
    const assertions = fixture.assertions();
    return {
      scope, mode, unchangedBeforeApproval, noReportFile, removed, chatgptPreserved, settingsPreserved,
      auditTools: audit.toolExecutions.map((tool) => tool.name), cleanupTools: cleanup.toolExecutions.map((tool) => tool.name),
      checkpoints: assertions.checkpoints, inferenceRequests: assertions.inferenceRequests, unexpectedRequests: assertions.unexpectedRequests,
      baselineCounts: [...audit.events, ...cleanup.events].filter((event: PiEvent) => event.type === "tool_execution_end" && event.toolName === shell).length,
    };
  } finally { await fixture.close(); }
}

function hash(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
async function exists(path: string): Promise<boolean> { try { await access(path); return true; } catch { return false; } }
