import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readScaffoldState, scaffoldCatalogRevision, scaffoldProject } from "../src/scaffold/project.js";

test("a flat .abd scaffold is recognized as initialized", async () => {
  const root = await mkdtemp(join(tmpdir(), "aboard-scaffold-"));
  const assets = join(root, "assets");
  const project = join(root, "project");
  await mkdir(join(assets, ".abd"), { recursive: true });
  await mkdir(join(assets, ".harness"), { recursive: true });
  await writeFile(join(assets, ".harness", "launch.json"), '{"version":2,"platform":"claude"}\n');
  await writeFile(join(assets, ".abd", "session-setup.ps1"), "");

  const revision = await scaffoldCatalogRevision(assets);
  const report = await scaffoldProject({ projectRoot: project, assetRoot: assets });

  assert.deepEqual(report.created, [".abd/session-setup.ps1", ".harness/launch.json"]);
  assert.equal(await readScaffoldState(project, revision), "ready");
});
