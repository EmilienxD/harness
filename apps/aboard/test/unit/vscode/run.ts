import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { downloadAndUnzipVSCode, runTests } from "@vscode/test-electron";

async function testExecutable(): Promise<string> {
  const executable = await downloadAndUnzipVSCode("1.141.0");
  if (process.platform !== "win32") return executable;

  // Archive test hosts must not be coupled to the machine installer's global update mutex.
  const archiveRoot = resolve(executable, "..");
  const entries = await readdir(archiveRoot, { withFileTypes: true });
  const commitDirectory = entries.find((entry) => entry.isDirectory() && /^[0-9a-f]{10}$/.test(entry.name));
  if (commitDirectory === undefined) throw new Error("VS Code archive commit directory is missing");
  const productPath = join(archiveRoot, commitDirectory.name, "resources", "app", "product.json");
  const product = JSON.parse(await readFile(productPath, "utf8")) as Record<string, unknown>;
  product.win32VersionedUpdate = false;
  await writeFile(productPath, `${JSON.stringify(product, null, 2)}\n`);
  return executable;
}

async function main(): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), "aboard-vscode-"));
  let target = workspace;
  if (process.env.ABOARD_VSCODE_TEST_MULTI_ROOT === "1") {
    const secondary = join(workspace, "secondary");
    await mkdir(secondary);
    target = join(workspace, "multi.code-workspace");
    await writeFile(target, JSON.stringify({ folders: [{ path: workspace }, { path: secondary }] }));
  }
  const vscodeExecutablePath = await testExecutable();
  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath: resolve(__dirname, "../.."),
    extensionTestsPath: resolve(__dirname, "suite.js"),
    launchArgs: [target, "--disable-extensions"],
  });
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : "VS Code integration tests failed"}\n`);
  process.exitCode = 1;
});
