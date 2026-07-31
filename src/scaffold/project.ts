import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

export const VENDORED_SKILLS = ["map-issues", "draft-issues", "publish-issues", "grill-me", "lavish", "commit"] as const;

export interface ScaffoldTodo {
  ensure(): Promise<"created" | "existing">;
}

export interface ScaffoldOptions {
  readonly projectRoot: string;
  readonly assetRoot: string;
  readonly todo: ScaffoldTodo;
  readonly autoCompactEnabled?: boolean;
}

export interface ScaffoldReport {
  readonly created: readonly string[];
  readonly updated: readonly string[];
  readonly preserved: readonly string[];
  readonly warnings: readonly string[];
  readonly todo: "created" | "existing";
}

interface InstalledAsset {
  readonly sourceHash: string;
  readonly vendored: boolean;
}

interface Manifest {
  readonly version: 1;
  readonly assets: Readonly<Record<string, InstalledAsset>>;
}

const MANIFEST_PATH = ".aboard/scaffold.json";
const HOOK_MARKER = ".claude/hooks/aboard_hook.py";
const MCP_SERVER_NAME = "aboard";
const MCP_REGISTRATION = {
  type: "http",
  url: "http://127.0.0.1:${ABOARD_BRIDGE_PORT}/mcp",
  headers: { Authorization: "Bearer ${ABOARD_BRIDGE_TOKEN}" },
};

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

async function readObject(path: string): Promise<Record<string, unknown>> {
  return await exists(path) ? parseObject(await readFile(path, "utf8"), path) : {};
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

function isVendored(path: string): boolean {
  const match = /^\.claude\/skills\/([^/]+)\//.exec(path);
  return match !== null && (VENDORED_SKILLS as readonly string[]).includes(match[1] ?? "");
}

function isAboardHook(value: unknown): boolean {
  if (typeof value === "string") return value.includes(HOOK_MARKER);
  if (Array.isArray(value)) return value.some(isAboardHook);
  return typeof value === "object" && value !== null && Object.values(value).some(isAboardHook);
}

function mergeHooks(settings: Record<string, unknown>, registration: Record<string, unknown>): Record<string, unknown> {
  const current = typeof settings.hooks === "object" && settings.hooks !== null && !Array.isArray(settings.hooks)
    ? settings.hooks as Record<string, unknown> : {};
  const incoming = typeof registration.hooks === "object" && registration.hooks !== null && !Array.isArray(registration.hooks)
    ? registration.hooks as Record<string, unknown> : {};
  const hooks: Record<string, unknown> = { ...current };
  for (const event of new Set([...Object.keys(current), ...Object.keys(incoming)])) {
    const kept = Array.isArray(current[event]) ? current[event].filter((entry) => !isAboardHook(entry)) : [];
    const aboard = Array.isArray(incoming[event]) ? incoming[event] : [];
    const merged = [...kept, ...aboard];
    if (merged.length > 0) hooks[event] = merged;
    else delete hooks[event];
  }
  return { ...settings, hooks };
}

/**
 * Approving the bridge server in `enabledMcpjsonServers` is what stops Claude
 * Code from prompting for `.mcp.json` trust on the first launch of every
 * scaffolded project. It must live in `settings.local.json`: Claude Code honors
 * the key in an untrusted folder only from a settings file that is not checked
 * into the repository. Merge into the user's list instead of replacing it.
 */
function mergeEnabledMcpServers(settings: Record<string, unknown>): Record<string, unknown> {
  const current = Array.isArray(settings.enabledMcpjsonServers) ? settings.enabledMcpjsonServers : [];
  if (current.includes(MCP_SERVER_NAME)) return settings;
  return { ...settings, enabledMcpjsonServers: [...current, MCP_SERVER_NAME] };
}

/**
 * A damaged manifest degrades to "nothing installed" rather than failing the
 * scaffold: the manifest is only an upgrade hint, and every asset still falls
 * back to the preserve-on-local-edit path when it is missing.
 */
async function loadManifest(path: string): Promise<Manifest> {
  if (!await exists(path)) return { version: 1, assets: {} };
  let parsed: Record<string, unknown>;
  try { parsed = parseObject(await readFile(path, "utf8"), path); } catch { return { version: 1, assets: {} }; }
  const assets = typeof parsed.assets === "object" && parsed.assets !== null && !Array.isArray(parsed.assets)
    ? parsed.assets as Record<string, InstalledAsset> : {};
  return { version: 1, assets };
}

export type ScaffoldState = "uninitialized" | "initialized";

/**
 * Distinguishes a first install from a re-run so the UI can offer "Initialize"
 * or "Update" rather than the ambiguous "Install or Upgrade". The manifest is
 * the marker: only a completed scaffold writes it, and it is what drives the
 * upgrade-versus-preserve decision on the next run.
 */
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
  const next: Record<string, InstalledAsset> = { ...previous.assets };

  const sourceFiles = await files(assetRoot);
  const sourcePaths = new Set(sourceFiles.map((path) => portable(relative(assetRoot, path))));
  for (const skill of VENDORED_SKILLS) {
    if (![...sourcePaths].some((path) => path.startsWith(`.claude/skills/${skill}/`))) warnings.push(`Missing upstream vendored skill: ${skill}`);
  }

  for (const source of sourceFiles) {
    const path = portable(relative(assetRoot, source));
    if (path === ".claude/hooks/aboard-hooks.json") continue;
    if (path === ".claude/settings.json" || path === ".claude/settings.local.json" || path === ".mcp.json" || path === ".gitignore") continue;
    const content = await readFile(source, "utf8");
    const sourceHash = hash(content);
    const destination = join(projectRoot, ...path.split("/"));
    const vendored = isVendored(path);
    if (!await exists(destination)) {
      await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, content, "utf8"); created.push(path);
    } else {
      const current = await readFile(destination, "utf8");
      const installed = previous.assets[path];
      if (current === content) {
        // Already current.
      } else if (vendored || (installed !== undefined && hash(current) === installed.sourceHash)) {
        await writeFile(destination, content, "utf8"); updated.push(path);
      } else {
        preserved.push(path); warnings.push(`Preserved locally edited aboard asset: ${path}`);
      }
    }
    next[path] = { sourceHash, vendored };
  }

  const registration = parseObject(await readFile(join(assetRoot, ".claude", "hooks", "aboard-hooks.json"), "utf8"), "aboard-hooks.json");
  const settingsPath = join(projectRoot, ".claude", "settings.json");
  const settings = await readObject(settingsPath);
  await writeJson(settingsPath, mergeHooks(settings, { hooks: registration }));

  const localSettingsPath = join(projectRoot, ".claude", "settings.local.json");
  await writeJson(localSettingsPath, mergeEnabledMcpServers(await readObject(localSettingsPath)));

  const mcpPath = join(projectRoot, ".mcp.json");
  const mcp = await readObject(mcpPath);
  const servers = typeof mcp.mcpServers === "object" && mcp.mcpServers !== null && !Array.isArray(mcp.mcpServers) ? mcp.mcpServers as Record<string, unknown> : {};
  await writeJson(mcpPath, { ...mcp, mcpServers: { ...servers, [MCP_SERVER_NAME]: MCP_REGISTRATION } });

  // `settings.local.json` is ignored on purpose: Claude Code only honors the MCP
  // approval from a settings file that is not checked into the repository.
  const ignorePath = join(projectRoot, ".gitignore");
  const ignore = await exists(ignorePath) ? await readFile(ignorePath, "utf8") : "";
  const present = new Set(ignore.split(/\r?\n/u).map((line) => line.trim()));
  const missing = [".aboard/runtime/", ".claude/settings.local.json"].filter((entry) => !present.has(entry));
  if (missing.length > 0) {
    const prefix = ignore.length === 0 || ignore.endsWith("\n") ? ignore : `${ignore}\n`;
    await writeFile(ignorePath, `${prefix}${missing.map((entry) => `${entry}\n`).join("")}`, "utf8");
  }
  await Promise.all(["prompts", "events"].map((directory) => mkdir(join(projectRoot, ".aboard", "runtime", directory), { recursive: true })));
  await writeJson(manifestPath, { version: 1, assets: next });
  if (options.autoCompactEnabled === false || settings.autoCompact === false) warnings.push("Claude Code autoCompact is disabled; aboard workers may exhaust their context window.");
  const todo = await options.todo.ensure();
  return { created, updated, preserved, warnings, todo };
}
