import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { downloadAndUnzipVSCode } from "@vscode/test-electron";

interface RemoveDirectory {
  (path: string, options: { readonly recursive: true; readonly force: true; readonly maxRetries: number; readonly retryDelay: number }): Promise<void>;
}

export async function removeDirectoryWithRetries(path: string, remove: RemoveDirectory = rm): Promise<void> {
  await remove(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

export async function testExecutable(): Promise<string> {
  const executable = await downloadAndUnzipVSCode("1.141.0");
  if (process.platform !== "win32") return executable;
  const archiveRoot = resolve(executable, "..");
  const entries = await readdir(archiveRoot, { withFileTypes: true });
  const commitDirectory = entries.find((entry) => entry.isDirectory() && /^[0-9a-f]{10}$/u.test(entry.name));
  if (!commitDirectory) throw new Error("VS Code archive commit directory is missing");
  const productPath = join(archiveRoot, commitDirectory.name, "resources", "app", "product.json");
  const product = JSON.parse(await readFile(productPath, "utf8")) as Record<string, unknown>;
  product.win32VersionedUpdate = false;
  await writeFile(productPath, `${JSON.stringify(product, null, 2)}\n`);
  return executable;
}

export async function prepareInteractiveClaudeConfig(configRoot: string, trustedRoots: readonly string[]): Promise<void> {
  const path = join(configRoot, ".claude.json");
  let value: Record<string, unknown> = {};
  try { value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>; }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const current = typeof value.projects === "object" && value.projects !== null && !Array.isArray(value.projects)
    ? value.projects as Record<string, unknown>
    : {};
  const projects = { ...current };
  for (const root of trustedRoots) {
    projects[resolve(root).replace(/\\/g, "/")] = {
      allowedTools: [], mcpContextUris: [], mcpServers: {}, enabledMcpjsonServers: [], disabledMcpjsonServers: [],
      hasTrustDialogAccepted: true, hasClaudeMdExternalIncludesApproved: false, hasClaudeMdExternalIncludesWarningShown: false,
    };
  }
  await writeFile(path, `${JSON.stringify({
    ...value, hasCompletedOnboarding: true, lastOnboardingVersion: "2.1.261", shiftEnterKeyBindingInstalled: true, projects,
  }, null, 2)}\n`, "utf8");
}
