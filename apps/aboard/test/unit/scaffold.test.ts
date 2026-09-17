import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readScaffoldState, scaffoldCatalogRevision, scaffoldProject } from "../../src/scaffold/project.js";

test("a flat .abd scaffold is recognized as initialized", async () => {
  const root = await mkdtemp(join(tmpdir(), "aboard-scaffold-"));
  const assets = join(root, "assets");
  const project = join(root, "project");
  await mkdir(join(assets, ".abd"), { recursive: true });
  await mkdir(join(assets, ".harness"), { recursive: true });
  await writeFile(join(assets, ".harness", "config.json"), '{"version":1,"providers":{"claude":{},"chatgpt":{}}}\n');
  await writeFile(join(assets, ".abd", "session-setup.ps1"), "");

  const revision = await scaffoldCatalogRevision(assets);
  const report = await scaffoldProject({ projectRoot: project, assetRoot: assets });

  assert.deepEqual(report.created, [".abd/session-setup.ps1", ".harness/config.json"]);
  assert.equal(await readScaffoldState(project, revision), "ready");
});

test("a disabled Claude Code auto-compact is reported, and an unset one is not", async () => {
  const root = await mkdtemp(join(tmpdir(), "aboard-scaffold-compact-"));
  const assets = join(root, "assets");
  await mkdir(join(assets, ".abd"), { recursive: true });
  await writeFile(join(assets, ".abd", "session-setup.ps1"), "");

  const warned = await scaffoldProject({ projectRoot: join(root, "off"), assetRoot: assets, autoCompactEnabled: false });
  assert.equal(warned.warnings.length, 1);
  assert.match(warned.warnings[0]!, /autoCompact/u);

  for (const options of [{ autoCompactEnabled: true }, {}]) {
    const report = await scaffoldProject({ projectRoot: join(root, `on-${String(Object.keys(options).length)}`), assetRoot: assets, ...options });
    assert.deepEqual(report.warnings, []);
  }
});
