import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

/**
 * User-owned tools live upstream in the `harness` repository. aboard ships no
 * copy of them: shipped copies drift from upstream silently and turn a user file
 * into an extension asset. Each is installed instead by running its upstream
 * install command in the project. A tool whose command is missing or fails is
 * reported, never authored here.
 */
export interface VendoredTool {
  readonly name: string;
  readonly kind: "skill" | "hooks";
  readonly command: string | null;
}

/**
 * Deliberately unpinned: `AGENTS.md` wants upstream improvements picked up by
 * re-running the install command, which a `@vX.Y.Z` suffix would defeat.
 * `harness install` defaults to project scope, so the installer's `cwd` decides
 * where the skill lands.
 */
const HARNESS_INSTALL = "uvx --from git+https://github.com/EmilienxD/harness harness install";

export const VENDORED_TOOLS: readonly VendoredTool[] = [
  // Every issue skill is part of the one upstream `issues` tool, which installs
  // all seven together, so they name one command; a repeated command runs once
  // per scaffold. Listing each by name is what keeps its directory recognized as
  // the user's, both here and in the packaging exclusions.
  { name: "map-issues", kind: "skill", command: `${HARNESS_INSTALL} issues` },
  { name: "draft-issues", kind: "skill", command: `${HARNESS_INSTALL} issues` },
  { name: "publish-issues", kind: "skill", command: `${HARNESS_INSTALL} issues` },
  { name: "draft-issue", kind: "skill", command: `${HARNESS_INSTALL} issues` },
  { name: "publish-issue", kind: "skill", command: `${HARNESS_INSTALL} issues` },
  { name: "to-spec", kind: "skill", command: `${HARNESS_INSTALL} issues` },
  { name: "to-spec-draft-issue", kind: "skill", command: `${HARNESS_INSTALL} issues` },
  { name: "grill-me", kind: "skill", command: `${HARNESS_INSTALL} grill-me` },
  { name: "commit", kind: "skill", command: `${HARNESS_INSTALL} commit` },
  { name: "usage-limit-wait", kind: "hooks", command: `${HARNESS_INSTALL} usage-limit-wait` },
];

export interface VendoredToolInstaller {
  run(command: string, cwd: string): Promise<void>;
}

/**
 * The scaffolder deliberately creates no roadmap issue. A repository with no
 * `ai:todo` carrier is the normal first-run state, and an empty placeholder
 * issue is worse than none: it looks like a roadmap, so nothing prompts anyone
 * to write one. The Manager's briefing reports the absence as something to do,
 * and `/update-todo` surveys the codebase and writes the first one.
 */
export interface ScaffoldOptions {
  readonly projectRoot: string;
  readonly assetRoot: string;
  readonly autoCompactEnabled?: boolean;
  readonly vendoredTools?: readonly VendoredTool[];
  readonly installer?: VendoredToolInstaller;
}

export interface ScaffoldReport {
  readonly created: readonly string[];
  readonly updated: readonly string[];
  readonly removed: readonly string[];
  readonly preserved: readonly string[];
  readonly installed: readonly string[];
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
const HOOK_MARKER = ".claude/hooks/aboard_hook.py";
const MCP_SERVER_NAME = "aboard";
const MCP_REGISTRATION = {
  type: "http",
  url: "http://127.0.0.1:${ABOARD_BRIDGE_PORT}/mcp",
  // `alwaysLoad` keeps the aboard tools out of Claude Code's tool search, so
  // the Manager never has to discover the very surface it orchestrates through.
  alwaysLoad: true,
  headers: {
    Authorization: "Bearer ${ABOARD_BRIDGE_TOKEN}",
    "X-Aboard-Agent-Id": "${ABOARD_AGENT_ID}",
  },
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

function isVendoredSkill(path: string, tools: readonly VendoredTool[]): boolean {
  const match = /^\.claude\/skills\/([^/]+)\//.exec(path);
  return match !== null && tools.some((tool) => tool.kind === "skill" && tool.name === match[1]);
}

/**
 * Vendored tools are installed by command, so aboard neither writes nor owns
 * their files. Any that a shipped-copy build left behind is handed back to the
 * user: dropped from the manifest, left on disk for the install command to
 * replace.
 */
async function installVendoredTools(
  tools: readonly VendoredTool[],
  installer: VendoredToolInstaller | undefined,
  projectRoot: string,
  installed: string[],
  warnings: string[],
): Promise<void> {
  // Several skills can come from one upstream tool and therefore name the same
  // command. Run each distinct command once and replay its outcome, so a shared
  // installer is not invoked once per skill, while every skill still reports its
  // own result under its own name.
  const outcomes = new Map<string, string | null>();
  for (const tool of tools) {
    if (tool.command === null) { warnings.push(`No install command configured for vendored tool: ${tool.name}`); continue; }
    if (installer === undefined) { warnings.push(`Cannot install vendored tool ${tool.name}: no installer available`); continue; }
    if (!outcomes.has(tool.command)) {
      try { await installer.run(tool.command, projectRoot); outcomes.set(tool.command, null); }
      catch (error) { outcomes.set(tool.command, error instanceof Error ? error.message : "install command failed"); }
    }
    const failure = outcomes.get(tool.command) ?? null;
    if (failure === null) installed.push(tool.name);
    else warnings.push(`Failed to install vendored tool ${tool.name}: ${failure}`);
  }
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
 * Project MCP approval belongs in untracked local settings. Merge aboard into
 * the user's list rather than replacing approvals for their own servers.
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
  const created: string[] = [], updated: string[] = [], removed: string[] = [], preserved: string[] = [], installed: string[] = [], warnings: string[] = [];
  const manifestPath = join(projectRoot, MANIFEST_PATH);
  const previous = await loadManifest(manifestPath);
  const next: Record<string, InstalledAsset> = { ...previous.assets };
  const vendoredTools = options.vendoredTools ?? VENDORED_TOOLS;

  const sourceFiles = await files(assetRoot);
  const sourcePaths = new Set(sourceFiles.map((path) => portable(relative(assetRoot, path))));

  for (const source of sourceFiles) {
    const path = portable(relative(assetRoot, source));
    if (path === ".claude/hooks/aboard-hooks.json") continue;
    if (path === ".claude/settings.json" || path === ".claude/settings.local.json" || path === ".gitignore") continue;
    const content = await readFile(source, "utf8");
    const sourceHash = hash(content);
    const destination = join(projectRoot, ...path.split("/"));
    if (!await exists(destination)) {
      await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, content, "utf8"); created.push(path);
    } else {
      const current = await readFile(destination, "utf8");
      const previousAsset = previous.assets[path];
      if (current === content) {
        // Already current.
      } else if (previousAsset !== undefined && hash(current) === previousAsset.sourceHash) {
        await writeFile(destination, content, "utf8"); updated.push(path);
      } else {
        preserved.push(path); warnings.push(`Preserved locally edited aboard asset: ${path}`);
      }
    }
    next[path] = { sourceHash };
  }

  // An asset aboard used to ship but no longer does would otherwise linger and
  // keep applying to every session in the project. That is exactly what the
  // definitions left behind in `.claude/agents/` would do — Claude Code scans
  // that directory from every session, which is why they moved to
  // `.aboard/agents/`. Retire such a file only when it still
  // matches what we installed; a locally edited copy is the user's file now.
  for (const [path, asset] of Object.entries(previous.assets)) {
    if (sourcePaths.has(path)) continue;
    delete next[path];
    if (isVendoredSkill(path, vendoredTools)) continue;
    const destination = join(projectRoot, ...path.split("/"));
    if (!await exists(destination)) continue;
    if (hash(await readFile(destination, "utf8")) === asset.sourceHash) {
      await rm(destination, { force: true }); removed.push(path);
    } else {
      preserved.push(path); warnings.push(`Preserved locally edited asset aboard no longer ships: ${path}`);
    }
  }

  const registration = parseObject(await readFile(join(assetRoot, ".claude", "hooks", "aboard-hooks.json"), "utf8"), "aboard-hooks.json");
  const settingsPath = join(projectRoot, ".claude", "settings.json");
  const settings = await readObject(settingsPath);
  await writeJson(settingsPath, mergeHooks(settings, { hooks: registration }));

  const localSettingsPath = join(projectRoot, ".claude", "settings.local.json");
  await writeJson(localSettingsPath, mergeEnabledMcpServers(await readObject(localSettingsPath)));

  const mcpPath = join(projectRoot, ".mcp.json");
  const mcp = await readObject(mcpPath);
  const servers = typeof mcp.mcpServers === "object" && mcp.mcpServers !== null && !Array.isArray(mcp.mcpServers)
    ? mcp.mcpServers as Record<string, unknown>
    : {};
  await writeJson(mcpPath, { ...mcp, mcpServers: { ...servers, [MCP_SERVER_NAME]: MCP_REGISTRATION } });

  // MCP approval is machine-local and must not be committed. Claude Code also
  // writes per-machine permission decisions to this file.
  const ignorePath = join(projectRoot, ".gitignore");
  const ignore = await exists(ignorePath) ? await readFile(ignorePath, "utf8") : "";
  const present = new Set(ignore.split(/\r?\n/u).map((line) => line.trim()));
  const missing = [".aboard/runtime/", ".claude/settings.local.json"].filter((entry) => !present.has(entry));
  if (missing.length > 0) {
    const prefix = ignore.length === 0 || ignore.endsWith("\n") ? ignore : `${ignore}\n`;
    await writeFile(ignorePath, `${prefix}${missing.map((entry) => `${entry}\n`).join("")}`, "utf8");
  }
  // `agents` holds the derived system-prompt files every agent-defined launch
  // and resume points `--system-prompt-file` at.
  await Promise.all(["prompts", "events", "agents"].map((directory) => mkdir(join(projectRoot, ".aboard", "runtime", directory), { recursive: true })));
  await writeJson(manifestPath, { version: 1, assets: next });
  await installVendoredTools(vendoredTools, options.installer, projectRoot, installed, warnings);
  if (options.autoCompactEnabled === false || settings.autoCompact === false) warnings.push("Claude Code autoCompact is disabled; aboard workers may exhaust their context window.");
  return { created, updated, removed, preserved, installed, warnings };
}
