import { access, copyFile, mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createPiFixture } from "../../core/pi-fixture.js";
import { createPiToolScenario } from "../../core/pi-scenario.js";

export const PI_SMOKE_MARKER = "[E2E:pi-smoke]";
export const piSmokeScenario = createPiToolScenario({
  name: "pi-smoke", marker: PI_SMOKE_MARKER,
  steps: [
    { checkpoint: "write", tool: "write", input: { path: "result.txt", content: "before\n" } },
    { checkpoint: "read", tool: "read", input: { path: "result.txt" } },
    { checkpoint: "edit", tool: "edit", input: { path: "result.txt", oldText: "before", newText: "after" } },
    { checkpoint: "blocked-write", tool: "write", input: { path: "blocked.txt", content: "must not exist\n" } },
  ],
});

export async function stagePiProbe(projectRoot: string): Promise<void> {
  let root = resolve(process.cwd());
  while (true) {
    const source = join(root, "tests", "e2e", "tools", "pi-smoke", "fixtures", "probe.ts.txt");
    try {
      await access(source);
      const destination = join(projectRoot, ".pi", "extensions", "harness-e2e-probe");
      await mkdir(destination, { recursive: true });
      await copyFile(source, join(destination, "index.ts"));
      return;
    } catch {
      const parent = dirname(root);
      if (parent === root) throw new Error("Could not locate the Pi smoke fixture source");
      root = parent;
    }
  }
}

export async function runPiSmokeJourney(mode: "json" | "rpc") {
  const fixture = await createPiFixture(piSmokeScenario);
  try {
    await stagePiProbe(fixture.workspace.projectRoot);
    const run = mode === "json" ? await fixture.runJson({ prompt: PI_SMOKE_MARKER }) : await fixture.rpc().prompt(PI_SMOKE_MARKER);
    const assertions = fixture.assertions();
    const files = await readdir(fixture.workspace.projectRoot);
    return {
      version: fixture.version, status: run.status, eventTypes: run.eventTypes,
      toolExecutions: run.toolExecutions, assistantStopReasons: run.assistantStopReasons,
      bytes: await readFile(join(fixture.workspace.projectRoot, "result.txt"), "utf8"), blockedFileExists: files.includes("blocked.txt"),
      checkpoints: assertions.checkpoints, inferenceRequests: assertions.inferenceRequests, unexpectedRequests: assertions.unexpectedRequests,
    };
  } finally { await fixture.close(); }
}
