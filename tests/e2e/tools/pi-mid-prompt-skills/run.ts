import assert from "node:assert/strict";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runFixtureInstaller } from "../../core/installer.js";
import { createPiFixture } from "../../core/pi-fixture.js";
import { invocationScenario, marker, resourceMarker, routeInvocations, type InvocationCase, type SkillResource } from "./scenario.js";

export async function runPiMidPromptSkills(scope: "project" | "user", mode: "json" | "rpc") {
  const routes = new Map<string, ReturnType<typeof invocationScenario>>();
  const fixture = await createPiFixture({ scenarioCatalogHash: "pi-mid-prompt-skills-v1", transition: (request) => routeInvocations(routes, request) });
  try {
    const { workspace } = fixture;
    const resourcesRoot = scope === "project" ? join(workspace.projectRoot, ".pi") : workspace.agentDir;
    const extension = join(resourcesRoot, "extensions", ".harness-mid-prompt-skills", "index.ts");
    const settings = join(workspace.projectRoot, ".pi", "settings.json");
    const originalSettings = await readFile(settings, "utf8");
    // Skill commands hidden from the UI must still work, as with Pi's native explicit loader.
    const extra = join(fixture.root, "extra-resources");
    await writeFile(settings, JSON.stringify({ ...JSON.parse(originalSettings), enableSkillCommands: false, skills: [extra] }));
    const settingsBefore = await readFile(settings, "utf8");
    const resources: SkillResource[] = [];
    for (const name of ["first", "second", "third", "extra"]) {
      const skillName = `e2e-${name}`;
      const directory = name === "extra" ? extra : join(resourcesRoot, "skills", skillName);
      await mkdir(directory, { recursive: true });
      const path = join(directory, "SKILL.md");
      const reference = join(directory, "reference.txt");
      await writeFile(path, `---\nname: ${skillName}\ndescription: Fixture-only explicit skill.\ndisable-model-invocation: true\nlicense: "${resourceMarker("frontmatter-only")}"\n---\n${resourceMarker(skillName)}\nUse the bundled reference.txt for this fixture.\n${name === "first" ? "Example: /skill:e2e-third\n" : ""}`);
      await writeFile(reference, `reference:${skillName}\n`);
      resources.push({ name: skillName, path, reference });
    }
    // A colliding shared skill must not override the resource Pi actually chose.
    const collision = join(workspace.projectRoot, ".agents", "skills", "e2e-first");
    await mkdir(collision, { recursive: true });
    await writeFile(join(collision, "SKILL.md"), `---\nname: e2e-first\ndescription: Collision fixture.\ndisable-model-invocation: true\n---\n${resourceMarker("e2e-first")}\nCollision.\n`);
    await writeFile(join(collision, "reference.txt"), "reference:e2e-first\n");
    // Project shared skills outrank user Pi skills; project Pi skills outrank shared copies.
    if (scope === "user") {
      resources[0]!.path = join(collision, "SKILL.md");
      resources[0]!.reference = join(collision, "reference.txt");
    }
    const cases: InvocationCase[] = [
      { name: "middle", prompt: "Do this using /skill:e2e-first now", skills: ["e2e-first"] },
      { name: "multiple", prompt: "Use /skill:e2e-first then /skill:e2e-second and /skill:e2e-extra", skills: ["e2e-first", "e2e-second", "e2e-extra"] },
      { name: "duplicates", prompt: "Use /skill:e2e-first and /skill:e2e-first", skills: ["e2e-first"] },
      { name: "leading", prompt: "/skill:e2e-first do this with /skill:e2e-second then /skill:e2e-first", skills: ["e2e-first", "e2e-second"] },
      { name: "stacked", prompt: "/skill:e2e-first /skill:e2e-second", skills: ["e2e-first", "e2e-second"] },
      { name: "native", prompt: "/skill:e2e-first", skills: ["e2e-first"] },
      { name: "fences", prompt: "Examples:\n```text\n/skill:e2e-first\n````\n~~~\n/skill:e2e-second\n~~~\nNow /skill:e2e-extra", skills: ["e2e-extra"] },
      { name: "unclosed", prompt: "Example:\n```\n/skill:e2e-first", skills: [] },
      { name: "inline", prompt: "Example `/skill:e2e-first` then /skill:e2e-second", skills: ["e2e-second"] },
      { name: "unknown", prompt: "Use /skill:unknown and /e2e-first", skills: [] },
      { name: "boundaries", prompt: "Do not expand x/skill:e2e-first or /skill:e2e-second-suffix or /skill:e2e-extra/file", skills: [] },
      { name: "expanded", prompt: `<skill name="e2e-first" location="${resources[0]!.path}">\n${resourceMarker("e2e-first")}\nAlready loaded.\n</skill>\nUse /skill:e2e-first and /skill:e2e-second`, skills: ["e2e-first", "e2e-second"] },
    ];
    for (const entry of cases) routes.set(entry.name, invocationScenario(entry, resources));
    await runFixtureInstaller(workspace, "install", ["mid-prompt-skills"], { scope, dryRun: true });
    await assert.rejects(access(extension), { code: "ENOENT" });
    await runFixtureInstaller(workspace, "install", ["mid-prompt-skills"], { scope });
    const repeat = await runFixtureInstaller(workspace, "install", ["mid-prompt-skills"], { scope });
    assert.equal((repeat.results as { status: string }[])[0]?.status, "unchanged");
    // Observer runs after the installed handler and consumes only the image-preservation probe.
    const probe = join(workspace.projectRoot, ".pi", "extensions", "zz-e2e-mid-probe", "index.ts");
    await mkdir(dirname(probe), { recursive: true });
    await writeFile(probe, `import { writeFile } from "node:fs/promises";\nimport { join } from "node:path";\nexport default function(pi) { pi.on("input", async (event, ctx) => { if (!event.text.includes("[E2E:image-probe]")) return; await writeFile(join(ctx.cwd, "images.json"), JSON.stringify(event.images)); return { action: "handled" }; }); }\n`);
    const rpc = fixture.rpc({ timeoutMs: 180_000 });
    const discovery = await rpc.request("get_commands");
    const commands = (discovery.data as { commands: { name: string; sourceInfo: { path: string } }[] }).commands;
    for (const skill of resources) assert.equal(commands.find((item) => item.name === `skill:${skill.name}`)?.sourceInfo.path, skill.path);
    let expectedRequests = 0;
    for (const entry of cases) {
      const prompt = `${entry.prompt}${entry.name === "native" ? " " : "\n"}${marker(entry.name)}`;
      if (mode === "rpc") assert.equal((await rpc.request("new_session")).success, true);
      const run = mode === "json" ? await fixture.runJson({ prompt }) : await rpc.prompt(prompt);
      assert.equal(run.status, "success", `Invocation case ${entry.name} failed`);
      assert.deepEqual(run.toolExecutions.map(({ name, isError }) => [name, isError]), [...entry.skills.map(() => ["read", false]), ["write", false]]);
      assert.deepEqual(JSON.parse(await readFile(join(workspace.projectRoot, `${entry.name}.json`), "utf8")), entry.skills);
      expectedRequests += entry.skills.length + 2;
      assert.equal(fixture.assertions().inferenceRequests, expectedRequests);
    }
    const images = [{ type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=" }];
    const imageResult = await rpc.request("prompt", { message: "[E2E:image-probe] use /skill:e2e-second", images });
    assert.equal((imageResult.data as { disposition: string }).disposition, "handled");
    assert.deepEqual(JSON.parse(await readFile(join(workspace.projectRoot, "images.json"), "utf8")), images);
    // Discovery survives a deleted file until reload: do not silently proceed without its instructions.
    const broken = resources[1]!.path;
    await rename(broken, `${broken}.saved`);
    try { assert.equal((await rpc.prompt("Use /skill:e2e-second")).status, "handled"); }
    finally { await rename(`${broken}.saved`, broken); }
    assert.equal(fixture.assertions().inferenceRequests, expectedRequests);
    assert.equal(fixture.assertions().unexpectedRequests, 0);
    await rpc.close();
    await runFixtureInstaller(workspace, "uninstall", ["mid-prompt-skills"], { scope });
    await assert.rejects(access(extension), { code: "ENOENT" });
    for (const skill of resources) await access(skill.path);
    assert.deepEqual(JSON.parse(await readFile(settings, "utf8")), JSON.parse(settingsBefore));
    // After removal a later invocation is ordinary text again, not an extension transform.
    const removed: InvocationCase = { name: "removed", prompt: "Use /skill:e2e-second", skills: [] };
    routes.set(removed.name, invocationScenario(removed, resources));
    assert.equal((await fixture.runJson({ prompt: `${removed.prompt}\n${marker(removed.name)}` })).status, "success");
    expectedRequests += 2;
    const observations = fixture.assertions();
    assert.equal(observations.inferenceRequests, expectedRequests);
    assert.equal(observations.unexpectedRequests, 0);
    return { scope, mode, version: fixture.version, cases: cases.length, inferenceRequests: expectedRequests, unexpectedRequests: 0, imagesPreserved: true, removed: true };
  } finally { await fixture.close(); }
}
