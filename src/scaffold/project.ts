import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

/**
 * User-owned skills live upstream in the `harness` repository. aboard ships no
 * copy of them: shipped copies drift from upstream silently and turn a user file
 * into an extension asset. Each is installed instead by running its upstream
 * install command in the project. A skill whose command is missing or fails is
 * reported, never authored here (spec §10.0, §10.1).
 */
export interface VendoredSkill {
  readonly name: string;
  readonly command: string | null;
}

/**
 * Deliberately unpinned: §10.1 wants upstream improvements picked up by
 * re-running the install command, which a `@vX.Y.Z` suffix would defeat.
 * `harness install` defaults to project scope, so the installer's `cwd` decides
 * where the skill lands.
 */
const HARNESS_INSTALL = "uvx --from git+https://github.com/EmilienxD/harness harness install";

export const VENDORED_SKILLS: readonly VendoredSkill[] = [
  // Every issue skill is part of the one upstream `issues` tool, which installs
  // all seven together, so they name one command; a repeated command runs once
  // per scaffold. Listing each by name is what keeps its directory recognized as
  // the user's, both here and in the packaging exclusions.
  { name: "map-issues", command: `${HARNESS_INSTALL} issues` },
  { name: "draft-issues", command: `${HARNESS_INSTALL} issues` },
  { name: "publish-issues", command: `${HARNESS_INSTALL} issues` },
  { name: "draft-issue", command: `${HARNESS_INSTALL} issues` },
  { name: "publish-issue", command: `${HARNESS_INSTALL} issues` },
  { name: "to-spec", command: `${HARNESS_INSTALL} issues` },
  { name: "to-spec-draft-issue", command: `${HARNESS_INSTALL} issues` },
  { name: "grill-me", command: `${HARNESS_INSTALL} grill-me` },
  { name: "commit", command: `${HARNESS_INSTALL} commit` },
];

export interface VendoredSkillInstaller {
  run(command: string, cwd: string): Promise<void>;
}

export interface ScaffoldTodo {
  ensure(): Promise<"created" | "existing">;
}

export interface ScaffoldOptions {
  readonly projectRoot: string;
  readonly assetRoot: string;
  readonly todo: ScaffoldTodo;
  readonly autoCompactEnabled?: boolean;
  readonly vendoredSkills?: readonly VendoredSkill[];
  readonly installer?: VendoredSkillInstaller;
}

export interface ScaffoldReport {
  readonly created: readonly string[];
  readonly updated: readonly string[];
  readonly removed: readonly string[];
  readonly preserved: readonly string[];
  readonly installed: readonly string[];
  readonly warnings: readonly string[];
  readonly todo: "created" | "existing";
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

/**
 * The Manager's delegation CLI, workspace-relative with POSIX separators. The
 * terminal controller exports its absolute path as `ABOARD_CLI` into the Manager's
 * terminal alone.
 */
export const MANAGER_CLI_SCRIPT = ".aboard/scripts/aboard_cli.py";

/**
 * The bridge used to register itself as a project MCP server. It no longer does:
 * a `.mcp.json` entry is loaded by every Claude Code session in the workspace,
 * where it competed with the user's own servers and spent context on tools only
 * the Manager could use. The delegation surface is `MANAGER_CLI_SCRIPT` instead.
 *
 * The registration is *removed* on the next scaffold rather than merely no
 * longer written: a stale entry would leave every session in the project
 * pointing at a route the bridge no longer serves. Other servers in either file
 * are the user's and are left exactly as they are.
 */
const RETIRED_MCP_SERVER_NAME = "aboard";

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

function isVendored(path: string, skills: readonly VendoredSkill[]): boolean {
  const match = /^\.claude\/skills\/([^/]+)\//.exec(path);
  return match !== null && skills.some((skill) => skill.name === match[1]);
}

/**
 * Vendored skills are installed by command, so aboard neither writes nor owns
 * their files. Any that a shipped-copy build left behind is handed back to the
 * user: dropped from the manifest, left on disk for the install command to
 * replace.
 */
async function installVendoredSkills(
  skills: readonly VendoredSkill[],
  installer: VendoredSkillInstaller | undefined,
  projectRoot: string,
  installed: string[],
  warnings: string[],
): Promise<void> {
  // Several skills can come from one upstream tool and therefore name the same
  // command. Run each distinct command once and replay its outcome, so a shared
  // installer is not invoked once per skill, while every skill still reports its
  // own result under its own name.
  const outcomes = new Map<string, string | null>();
  for (const skill of skills) {
    if (skill.command === null) { warnings.push(`No install command configured for vendored skill: ${skill.name}`); continue; }
    if (installer === undefined) { warnings.push(`Cannot install vendored skill ${skill.name}: no installer available`); continue; }
    if (!outcomes.has(skill.command)) {
      try { await installer.run(skill.command, projectRoot); outcomes.set(skill.command, null); }
      catch (error) { outcomes.set(skill.command, error instanceof Error ? error.message : "install command failed"); }
    }
    const failure = outcomes.get(skill.command) ?? null;
    if (failure === null) installed.push(skill.name);
    else warnings.push(`Failed to install vendored skill ${skill.name}: ${failure}`);
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
 * Drops aboard's own approval from `enabledMcpjsonServers`, and the key itself
 * once nothing else is listed under it. Approvals the user granted to their own
 * servers are untouched.
 */
function withoutRetiredMcpApproval(settings: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(settings.enabledMcpjsonServers)) return settings;
  const remaining = settings.enabledMcpjsonServers.filter((name) => name !== RETIRED_MCP_SERVER_NAME);
  if (remaining.length === settings.enabledMcpjsonServers.length) return settings;
  const { enabledMcpjsonServers: _approved, ...rest } = settings;
  return remaining.length === 0 ? rest : { ...rest, enabledMcpjsonServers: remaining };
}

/**
 * Drops the bridge's server from `.mcp.json`, and the file's `mcpServers` key
 * once it is empty. A `.mcp.json` that aboard created and that now holds nothing
 * is removed outright, so a project that never had one is left as it was found.
 * Returns `undefined` when the file should be deleted rather than rewritten.
 */
function withoutRetiredMcpServer(mcp: Record<string, unknown>): Record<string, unknown> | undefined {
  const servers = typeof mcp.mcpServers === "object" && mcp.mcpServers !== null && !Array.isArray(mcp.mcpServers)
    ? mcp.mcpServers as Record<string, unknown> : undefined;
  if (servers === undefined || !(RETIRED_MCP_SERVER_NAME in servers)) return mcp;
  const { [RETIRED_MCP_SERVER_NAME]: _retired, ...remaining } = servers;
  if (Object.keys(remaining).length > 0) return { ...mcp, mcpServers: remaining };
  const { mcpServers: _servers, ...rest } = mcp;
  return Object.keys(rest).length === 0 ? undefined : rest;
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
  const vendoredSkills = options.vendoredSkills ?? VENDORED_SKILLS;

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
    if (isVendored(path, vendoredSkills)) continue;
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

  // Both files are only ever *cleaned* now, and only of aboard's own entries.
  // An untouched file is not rewritten, so a project that never registered the
  // bridge keeps its formatting and a project that has no `.mcp.json` never
  // gains one.
  const localSettingsPath = join(projectRoot, ".claude", "settings.local.json");
  if (await exists(localSettingsPath)) {
    const local = await readObject(localSettingsPath);
    const cleaned = withoutRetiredMcpApproval(local);
    if (cleaned !== local) await writeJson(localSettingsPath, cleaned);
  }

  const mcpPath = join(projectRoot, ".mcp.json");
  if (await exists(mcpPath)) {
    const mcp = await readObject(mcpPath);
    const cleaned = withoutRetiredMcpServer(mcp);
    if (cleaned === undefined) await rm(mcpPath, { force: true });
    else if (cleaned !== mcp) await writeJson(mcpPath, cleaned);
  }

  // `.claude/settings.local.json` is machine-local by construction — Claude Code
  // writes per-machine permission decisions into it — so it stays ignored even
  // though aboard no longer has an MCP approval to put there.
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
  await installVendoredSkills(vendoredSkills, options.installer, projectRoot, installed, warnings);
  if (options.autoCompactEnabled === false || settings.autoCompact === false) warnings.push("Claude Code autoCompact is disabled; aboard workers may exhaust their context window.");
  const todo = await options.todo.ensure();
  return { created, updated, removed, preserved, installed, warnings, todo };
}
