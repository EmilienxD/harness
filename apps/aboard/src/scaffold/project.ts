import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

export interface ScaffoldOptions {
  readonly projectRoot: string;
  readonly assetRoot: string;
  /** Absent unless Claude Code itself is installed and has an explicit setting. */
  readonly autoCompactEnabled?: boolean;
}

export interface ScaffoldReport {
  readonly created: readonly string[];
  readonly updated: readonly string[];
  readonly removed: readonly string[];
  readonly preserved: readonly string[];
  readonly warnings: readonly string[];
}

interface InstalledAsset {
  readonly sourceHash: string;
}

interface Manifest {
  readonly version: 2;
  readonly revision?: string;
  readonly assets: Readonly<Record<string, InstalledAsset>>;
}

const MANIFEST_PATH = ".abd/scaffold.json";

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
  return output.sort((left, right) => left.localeCompare(right));
}

function portable(path: string): string { return path.split(sep).join("/"); }

function isOwnedAssetPath(path: string): boolean {
  const segments = path.split("/");
  const safe = segments.every((segment) => segment.length > 0 && segment !== "." && segment !== ".." && !segment.includes("\\"));
  return safe && ((segments.length >= 2 && segments[0] === ".abd")
    || (segments.length === 2 && segments[0] === ".codex" && segments[1] === "hooks.json")
    || (segments.length === 2 && segments[0] === ".harness" && segments[1] === "config.json"));
}

const CODEX_HOOKS_PATH = ".codex/hooks.json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAboardHook(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return typeof value.command === "string"
    && value.command.includes("ABOARD_RUNTIME_ROOT")
    && value.command.includes("abd_hook.py");
}

function withoutAboardHooks(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.flatMap((candidate) => {
    if (!isRecord(candidate) || !Array.isArray(candidate.hooks)) return [candidate];
    const hooks = candidate.hooks.filter((hook) => !isAboardHook(hook));
    return hooks.length === 0 ? [] : [{ ...candidate, hooks }];
  });
}

function mergeCodexHooks(existingText: string, fragmentText: string, path: string): string {
  const existing = parseObject(existingText, path);
  const fragment = parseObject(fragmentText, CODEX_HOOKS_PATH);
  const existingHooks = existing.hooks === undefined ? {} : existing.hooks;
  const fragmentHooks = fragment.hooks;
  if (!isRecord(existingHooks)) throw new Error(`${path} hooks must contain a JSON object`);
  if (!isRecord(fragmentHooks)) throw new Error(`${CODEX_HOOKS_PATH} hooks must contain a JSON object`);

  const hooks: Record<string, unknown> = {};
  for (const [event, groups] of Object.entries(existingHooks)) {
    const kept = withoutAboardHooks(groups);
    if (!Array.isArray(kept) || kept.length > 0) hooks[event] = kept;
  }
  for (const [event, groups] of Object.entries(fragmentHooks)) {
    if (!Array.isArray(groups)) throw new Error(`${CODEX_HOOKS_PATH} hooks.${event} must contain a JSON array`);
    const current = hooks[event];
    if (current !== undefined && !Array.isArray(current)) throw new Error(`${path} hooks.${event} must contain a JSON array`);
    hooks[event] = [...(current ?? []), ...groups];
  }
  return `${JSON.stringify({ ...existing, hooks }, null, 2)}\n`;
}

async function loadManifest(path: string): Promise<Manifest> {
  if (!await exists(path)) return { version: 2, assets: {} };
  let parsed: Record<string, unknown>;
  try { parsed = parseObject(await readFile(path, "utf8"), path); } catch { return { version: 2, assets: {} }; }
  const candidates = typeof parsed.assets === "object" && parsed.assets !== null && !Array.isArray(parsed.assets)
    ? parsed.assets as Record<string, unknown> : {};
  const assets: Record<string, InstalledAsset> = {};
  for (const [assetPath, candidate] of Object.entries(candidates)) {
    if (!isOwnedAssetPath(assetPath)) continue;
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) continue;
    const sourceHash = (candidate as Record<string, unknown>).sourceHash;
    if (typeof sourceHash === "string" && /^[a-f0-9]{64}$/u.test(sourceHash)) assets[assetPath] = { sourceHash };
  }
  const revision = typeof parsed.revision === "string" && /^[a-f0-9]{64}$/u.test(parsed.revision)
    ? parsed.revision : undefined;
  return { version: 2, assets, ...(revision === undefined ? {} : { revision }) };
}

interface SourceAsset {
  readonly path: string;
  readonly content: string;
  readonly sourceHash: string;
}

async function sourceCatalog(assetRoot: string): Promise<{ readonly assets: readonly SourceAsset[]; readonly revision: string }> {
  const root = resolve(assetRoot);
  const assets = await Promise.all((await files(root)).map(async (source): Promise<SourceAsset> => {
    const path = portable(relative(root, source));
    const content = await readFile(source, "utf8");
    return { path, content, sourceHash: hash(content) };
  }));
  const revision = hash(assets.map((asset) => `${asset.path}\0${asset.sourceHash}`).join("\n"));
  return { assets, revision };
}

export type ScaffoldState = "uninitialized" | "update-required" | "ready";

async function isDeletionInsideOwnedDirectory(projectRoot: string, destination: string): Promise<boolean> {
  try {
    const [canonicalProject, canonicalParent] = await Promise.all([realpath(projectRoot), realpath(dirname(destination))]);
    const parentFromProject = relative(canonicalProject, canonicalParent);
    return isOwnedAssetPath(portable(join(parentFromProject, basename(destination))));
  } catch {
    return false;
  }
}

export async function scaffoldCatalogRevision(assetRoot: string): Promise<string> {
  return (await sourceCatalog(assetRoot)).revision;
}

export async function readScaffoldState(projectRoot: string, expectedRevision: string): Promise<ScaffoldState> {
  const manifestPath = join(resolve(projectRoot), ...MANIFEST_PATH.split("/"));
  const manifest = await loadManifest(manifestPath);
  if (Object.keys(manifest.assets).length === 0) return "uninitialized";
  return manifest.revision === expectedRevision ? "ready" : "update-required";
}

export async function scaffoldProject(options: ScaffoldOptions): Promise<ScaffoldReport> {
  const projectRoot = resolve(options.projectRoot);
  const assetRoot = resolve(options.assetRoot);
  const created: string[] = [], updated: string[] = [], removed: string[] = [], preserved: string[] = [], warnings: string[] = [];
  const manifestPath = join(projectRoot, MANIFEST_PATH);
  const previous = await loadManifest(manifestPath);
  const next: Record<string, InstalledAsset> = {};

  const catalog = await sourceCatalog(assetRoot);
  const currentPaths = new Set(catalog.assets.map((asset) => asset.path));
  for (const { path, content, sourceHash } of catalog.assets) {
    const destination = join(projectRoot, ...path.split("/"));
    let installedAsset: InstalledAsset | undefined;
    if (path === CODEX_HOOKS_PATH && await exists(destination)) {
      const current = await readFile(destination, "utf8");
      const merged = mergeCodexHooks(current, content, destination);
      if (current !== merged) { await writeFile(destination, merged, "utf8"); updated.push(path); }
      installedAsset = { sourceHash };
      next[path] = installedAsset;
      continue;
    }
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

  for (const [path, previousAsset] of Object.entries(previous.assets)) {
    if (currentPaths.has(path)) continue;
    const destination = join(projectRoot, ...path.split("/"));
    if (!await exists(destination)) continue;
    const current = await readFile(destination, "utf8");
    if (hash(current) === previousAsset.sourceHash && await isDeletionInsideOwnedDirectory(projectRoot, destination)) {
      await rm(destination);
      removed.push(path);
    } else {
      preserved.push(path);
    }
  }

  await writeJson(manifestPath, { version: 2, revision: catalog.revision, assets: next });
  if (options.autoCompactEnabled === false) warnings.push("Claude Code autoCompact is disabled; aboard workers may exhaust their context window.");
  return { created, updated, removed, preserved, warnings };
}
