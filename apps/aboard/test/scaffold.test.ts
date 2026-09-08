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
  await writeFile(join(assets, ".abd", "launch.json"), '{"version":1}\n');
  await writeFile(join(assets, ".abd", "session-setup.ps1"), "");

  const revision = await scaffoldCatalogRevision(assets);
  const report = await scaffoldProject({ projectRoot: project, assetRoot: assets });

  assert.deepEqual(report.created, [".abd/launch.json", ".abd/session-setup.ps1"]);
  assert.equal(await readScaffoldState(project, revision), "ready");
});
