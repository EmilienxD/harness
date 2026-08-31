import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

export interface ScaffoldOptions {
  readonly projectRoot: string;
  readonly assetRoot: string;
  readonly autoCompactEnabled?: boolean;
}

export interface ScaffoldReport {
  readonly created: readonly string[];
  readonly updated: readonly string[];
  readonly preserved: readonly string[];
  readonly warnings: readonly string[];
}

interface InstalledAsset {
  readonly sourceHash: string;
}

interface Manifest {
  readonly version: 1;
  readonly assets: Readonly<Record<string, InstalledAsset>>;
}

const MANIFEST_PATH = ".aboard/scaffold.json";

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

function parseObject(text: string, path: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(text) as unknown; } catch { throw new Error(`${path} contains invalid JSON`); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${path} must contain a JSON object`);
  return value as Record<string, unknown>;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function files(root: string): Promise<readonly string[]> {
  if (!await exists(root)) return [];
  const output: string[] = [];
  for (const entry of await readdir(root)) {
    const path = join(root, entry);
    if ((await stat(path)).isDirectory()) output.push(...await files(path));
    else output.push(path);
  }
  return output;
}

function portable(path: string): string { return path.split(sep).join("/"); }

async function loadManifest(path: string): Promise<Manifest> {
  if (!await exists(path)) return { version: 1, assets: {} };
  let parsed: Record<string, unknown>;
  try { parsed = parseObject(await readFile(path, "utf8"), path); } catch { return { version: 1, assets: {} }; }
  const assets = typeof parsed.assets === "object" && parsed.assets !== null && !Array.isArray(parsed.assets)
    ? parsed.assets as Record<string, InstalledAsset> : {};
  return { version: 1, assets };
}

export type ScaffoldState = "uninitialized" | "initialized";

export async function readScaffoldState(projectRoot: string): Promise<ScaffoldState> {
  const manifestPath = join(resolve(projectRoot), ...MANIFEST_PATH.split("/"));
  return Object.keys((await loadManifest(manifestPath)).assets).length > 0 ? "initialized" : "uninitialized";
}

export async function scaffoldProject(options: ScaffoldOptions): Promise<ScaffoldReport> {
  const projectRoot = resolve(options.projectRoot);
  const assetRoot = resolve(options.assetRoot);
  const created: string[] = [], updated: string[] = [], preserved: string[] = [], warnings: string[] = [];
  const manifestPath = join(projectRoot, MANIFEST_PATH);
  const previous = await loadManifest(manifestPath);
  const next: Record<string, InstalledAsset> = {};

  const sourceFiles = await files(assetRoot);
  for (const source of sourceFiles) {
    const path = portable(relative(assetRoot, source));
    const content = await readFile(source, "utf8");
    const sourceHash = hash(content);
    const destination = join(projectRoot, ...path.split("/"));
    let installedAsset: InstalledAsset | undefined;
    if (!await exists(destination)) {
      await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, content, "utf8"); created.push(path);
      installedAsset = { sourceHash };
    } else {
      const current = await readFile(destination, "utf8");
      const previousAsset = previous.assets[path];
      if (current === content) {
        // Already current.
        installedAsset = { sourceHash };
      } else if (previousAsset !== undefined && hash(current) === previousAsset.sourceHash) {
        await writeFile(destination, content, "utf8"); updated.push(path);
        installedAsset = { sourceHash };
      } else {
        preserved.push(path);
        // Keep the last version known to have been installed. Recording the
        // new source here would make a preserved old version look user-edited
        // forever, even if the user later restored that installed version.
        installedAsset = previousAsset;
      }
    }
    if (installedAsset !== undefined) next[path] = installedAsset;
  }

  // `agents` holds the derived system-prompt files every agent-defined launch
  // and resume points `--system-prompt-file` at.
  await Promise.all(["prompts", "events", "agents"].map((directory) => mkdir(join(projectRoot, ".aboard", "runtime", directory), { recursive: true })));
  await writeJson(manifestPath, { version: 1, assets: next });
  if (options.autoCompactEnabled === false) warnings.push("Claude Code autoCompact is disabled; aboard workers may exhaust their context window.");
  return { created, updated, preserved, warnings };
}
