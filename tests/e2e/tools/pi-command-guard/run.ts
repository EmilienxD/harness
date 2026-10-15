import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runFixtureInstaller } from "../../core/installer.js";
import { createPiFixture } from "../../core/pi-fixture.js";
import { createPiToolScenario, type PiScenarioStep } from "../../core/pi-scenario.js";

const POLICY = 'version = 1\n[[rules]]\nreason = "end-to-end forbidden command"\npatterns = ["forbidden-marker"]\n';

function shellCommands() {
  if (process.platform === "win32") {
    return {
      shell: "powershell",
      safe: "Set-Content -Path allowed.txt -Value allowed",
      // The guard denies before execution, so denied.txt is never written. '#' comments the write.
      dangerous: "Set-Content -Path denied.txt -Value denied # forbidden-marker",
    };
  }
  return {
    shell: "bash",
    safe: "printf allowed > allowed.txt",
    dangerous: "printf denied > denied.txt # forbidden-marker",
  };
}

async function enableShell(projectRoot: string, shell: string): Promise<void> {
  await writeFile(
    join(projectRoot, ".pi", "settings.json"),
    JSON.stringify({ defaultProvider: "harness-e2e", defaultModel: "pi-e2e", defaultTools: ["read", "write", "edit", shell] }),
  );
}

/** Install the real package, allow a safe command, and deny a configured dangerous one. */
export async function runPiCommandGuardJourney(mode: "json" | "rpc", scope: "project" | "user") {
  const { shell, safe, dangerous } = shellCommands();
  const steps: PiScenarioStep[] = [
    { checkpoint: "allow-safe", tool: shell, input: { command: safe } },
    { checkpoint: "deny-dangerous", tool: shell, input: { command: dangerous } },
  ];
  const marker = "[E2E:pi-command-guard]";
  const fixture = await createPiFixture(createPiToolScenario({ name: "pi-command-guard", marker, steps }));
  try {
    const project = fixture.workspace.projectRoot;
    await enableShell(project, shell);
    await runFixtureInstaller(fixture.workspace, "install", ["command-guard"], { scope, dryRun: true });
    assert.equal(existsSync(join(project, ".pi", "hooks", "pi-transport")), false);
    await runFixtureInstaller(fixture.workspace, "install", ["command-guard"], { scope });
    // Reinstall must preserve the policy below and stay idempotent.
    await runFixtureInstaller(fixture.workspace, "install", ["command-guard"], { scope });
    const platformRoot = scope === "project" ? join(project, ".pi") : fixture.workspace.agentDir;
    const policy = scope === "project"
      ? join(project, ".harness", "guards", "command-guard.toml")
      : join(platformRoot, "hooks", "command-guard.toml");
    await writeFile(policy, POLICY);

    const run = mode === "json" ? await fixture.runJson({ prompt: marker }) : await fixture.rpc().prompt(marker);
    assert.equal(run.status, "success", JSON.stringify(fixture.assertions()));
    assert.deepEqual(run.toolExecutions.map((tool) => tool.isError), [false, true]);
    assert.equal((await readFile(join(project, "allowed.txt"), "utf8")).trim(), "allowed");
    assert.equal(existsSync(join(project, "denied.txt")), false);
    assert.equal(fixture.assertions().inferenceRequests, steps.length + 1);
    assert.equal(fixture.assertions().unexpectedRequests, 0);

    await runFixtureInstaller(fixture.workspace, "uninstall", ["command-guard"], { scope });
    await assert.rejects(access(join(platformRoot, "extensions", "harness-command-guard", "index.ts")));
    await assert.rejects(access(join(platformRoot, "hooks", "command_guard_pi.py")));
    await assert.rejects(access(join(platformRoot, "hooks", "pi-transport", "transport.ts")));
    assert.equal(await readFile(policy, "utf8"), POLICY);
    return { version: fixture.version, mode, scope, status: run.status, inferenceRequests: steps.length + 1 };
  } finally {
    await fixture.close();
  }
}

/** A malformed policy must deny every command, matching the hook's fail-closed behavior. */
export async function runPiMalformedPolicyJourney(mode: "json" | "rpc") {
  const { shell, safe } = shellCommands();
  const steps: PiScenarioStep[] = [
    { checkpoint: "deny-on-malformed-policy", tool: shell, input: { command: safe } },
  ];
  const marker = "[E2E:pi-command-guard-malformed]";
  const fixture = await createPiFixture(createPiToolScenario({ name: "pi-command-guard-malformed", marker, steps }));
  try {
    const project = fixture.workspace.projectRoot;
    await enableShell(project, shell);
    await runFixtureInstaller(fixture.workspace, "install", ["command-guard"]);
    await writeFile(join(project, ".harness", "guards", "command-guard.toml"), "([invalid\n");

    const run = mode === "json" ? await fixture.runJson({ prompt: marker }) : await fixture.rpc().prompt(marker);
    assert.equal(run.status, "success", JSON.stringify(fixture.assertions()));
    assert.deepEqual(run.toolExecutions.map((tool) => tool.isError), [true]);
    assert.equal(existsSync(join(project, "allowed.txt")), false);
    assert.equal(fixture.assertions().inferenceRequests, steps.length + 1);
    assert.equal(fixture.assertions().unexpectedRequests, 0);
  } finally {
    await fixture.close();
  }
}
