import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, copyFile, mkdir, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { findHarnessRoot, runFixtureInstaller } from "../../core/installer.js";
import { createPiFixture } from "../../core/pi-fixture.js";
import { routeSharedSkills, sharedSkillScenario } from "./scenario.js";

export const SHARED_SKILL_PACKAGES = [
  ["building", "tdd"], ["engineering", "resolving-merge-conflicts"], ["engineering", "setup-git-worktree-maker"],
  ["planning", "audit"], ["planning", "grill-me"], ["planning", "breakdown-help-wanted-issue"],
  ["planning", "read-all-adrs"], ["planning", "writing-adrs"], ["productivity", "writing-for-agents"],
  ["productivity", "zoom-out"], ["planning", "prototype"],
  ["productivity", "handoff"], ["productivity", "handoff-grilling"], ["productivity", "todo-hitl"],
  ["productivity", "decisions"], ["productivity", "next-decision"], ["productivity", "stop-overthinking"],
  ["productivity", "setup-command-aliases"], ["productivity", "setup-text-replacements"],
  ["productivity", "caveman"], ["shipping", "setup-help"], ["planning", "websearch"],
] as const;

const AUTOMATIC_SKILLS = new Set(["tdd", "resolving-merge-conflicts", "writing-adrs", "writing-for-agents"]);

export async function runPiSharedSkillsJourney(scope: "project" | "user") {
  const scenarios = new Map<string, ReturnType<typeof sharedSkillScenario>>();
  const fixture = await createPiFixture({ scenarioCatalogHash: "pi-shared-skills-v1", transition: (request) => routeSharedSkills(scenarios, request) });
  try {
    const root = await findHarnessRoot();
    const packages = SHARED_SKILL_PACKAGES.map(([, name]) => name);
    await runFixtureInstaller(fixture.workspace, "install", packages, { scope });
    const skillsRoot = join(scope === "project" ? join(fixture.workspace.projectRoot, ".pi") : fixture.workspace.agentDir, "skills");
    const installed = [];
    let referenceReads = 0;
    for (const [category, packageName] of SHARED_SKILL_PACKAGES) {
      for (const name of packageName === "todo-hitl" ? ["mark-as-todo-hitl", "address-todo-hitl"] : [packageName]) {
        const source = join(root, "harness", category, packageName, ...(packageName === "todo-hitl" ? [name] : []));
        const destination = join(skillsRoot, name);
        const files = await readdir(destination);
        assert.equal(files.includes("agents"), false, "Pi payload included ChatGPT metadata");
        const references = files.filter((file) => file !== "SKILL.md");
        const reads = [];
        for (const file of ["SKILL.md", ...references]) {
          const bytes = await readFile(join(destination, file), "utf8");
          const sourceBytes = await readFile(join(source, file), "utf8");
          assert.equal(hash(bytes), hash(sourceBytes), "Installer changed shared payload bytes");
          // Skill instructions are checked as file bytes above, not matched in model prompts.
          if (file !== "SKILL.md") reads.push({ path: join(destination, file), bytes });
        }
        if (packageName === "websearch") {
          const workspaceRoot = scope === "project" ? fixture.workspace.projectRoot : fixture.workspace.env.HOME!;
          const path = join(workspaceRoot, ".harness", "websearch", "INDEX.md");
          const bytes = await readFile(path, "utf8");
          assert.equal(bytes, await readFile(join(source, "INDEX.md"), "utf8"));
          reads.push({ path, bytes });
        }
        referenceReads += reads.length;
        scenarios.set(name, sharedSkillScenario(name, reads));
        installed.push({ name, filePath: join(destination, "SKILL.md"), disableModelInvocation: !AUTOMATIC_SKILLS.has(name) });
      }
    }
    const extension = join(fixture.workspace.projectRoot, ".pi", "extensions", "e2e-skill-resources");
    await mkdir(extension, { recursive: true });
    await copyFile(join(root, "tests", "e2e", "tools", "pi-shared-skills", "fixtures", "resources.ts.txt"), join(extension, "index.ts"));
    const rpc = fixture.rpc({ timeoutMs: 180_000 });
    const discovery = await rpc.request("get_commands");
    const commands = (discovery.data as { commands: { name: string; source: string; sourceInfo?: { path?: string } }[] }).commands;
    for (const skill of installed) {
      const command = commands.find((item) => item.name === `skill:${skill.name}` && item.source === "skill");
      assert.equal(resolve(command?.sourceInfo?.path ?? ""), resolve(skill.filePath), "Native discovery did not find installed skill");
    }
    assert.ok(commands.some(command => command.name === "e2e-skill-resources" && command.source === "extension"), "The fixture inspection command was not discovered");
    assert.equal((await rpc.prompt("/e2e-skill-resources")).status, "handled");
    const resources = JSON.parse(await readFile(join(fixture.workspace.projectRoot, "skill-resources.json"), "utf8")) as { skills: typeof installed; diagnostics: unknown[] };
    assert.deepEqual(resources.diagnostics, [], "Native skill loading produced diagnostics");
    for (const skill of installed) assert.deepEqual(resources.skills.find((item) => item.name === skill.name), skill, "Native parser changed explicit invocation semantics");
    assert.equal(fixture.assertions().inferenceRequests, 0);
    for (const skill of installed) {
      assert.equal((await rpc.request("new_session")).success, true);
      const run = await rpc.prompt(`/skill:${skill.name} [E2E:pi-shared-${skill.name}]`);
      assert.equal(run.status, "success", "Native installed skill invocation failed");
      assert.equal(run.toolExecutions.some((tool) => tool.isError), false);
      assert.equal(await readFile(join(fixture.workspace.projectRoot, `${skill.name}-result.txt`), "utf8"), `${skill.name}\n`);
    }
    await rpc.close();
    await runFixtureInstaller(fixture.workspace, "install", packages, { scope, platform: "chatgpt" });
    const collisionRpc = fixture.rpc();
    const collisionDiscovery = await collisionRpc.request("get_commands");
    const collisionCommands = (collisionDiscovery.data as { commands: { name: string; sourceInfo?: { path?: string } }[] }).commands;
    for (const skill of installed) {
      const command = collisionCommands.find((item) => item.name === `skill:${skill.name}`);
      assert.equal(resolve(command?.sourceInfo?.path ?? ""), resolve(skill.filePath), "Colocated ChatGPT copy displaced Pi skill discovery");
    }
    await collisionRpc.close();
    await runFixtureInstaller(fixture.workspace, "uninstall", packages, { scope });
    await assert.rejects(access(skillsRoot), { code: "ENOENT" });
    const chatgptRoot = scope === "project" ? fixture.workspace.projectRoot : fixture.workspace.env.HOME!;
    for (const skill of installed) await access(join(chatgptRoot, ".agents", "skills", skill.name, "SKILL.md"));
    const assertions = fixture.assertions();
    assert.equal(assertions.inferenceRequests, installed.length * 2 + referenceReads);
    assert.equal(assertions.unexpectedRequests, 0);
    return { scope, packages: packages.length, skills: installed.length, referenceReads, inferenceRequests: assertions.inferenceRequests, unexpectedRequests: assertions.unexpectedRequests };
  } finally { await fixture.close(); }
}

function hash(bytes: string): string { return createHash("sha256").update(bytes).digest("hex"); }
