import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { normalizeProjectPath } from "../bridge/command-endpoint.js";

export { normalizeProjectPath } from "../bridge/command-endpoint.js";

export function ownerRuntimeDirectory(storageRoot: string, ownerId: string): string {
  return join(storageRoot, "owners", createHash("sha256").update(ownerId).digest("hex"));
}

export interface WorkspaceOwnerLease { release(): Promise<void> }

export interface OrdinaryWorkspaceOwnerLease extends WorkspaceOwnerLease { readonly ownerId: string }

/** Folder windows share VS Code workspace storage. Lease personal owner slots instead of sharing runtime state. */
export async function acquireOrdinaryWorkspaceOwner(storageRoot: string, projectRoot: string): Promise<OrdinaryWorkspaceOwnerLease> {
  const projectKey = createHash("sha256").update(normalizeProjectPath(projectRoot)).digest("hex");
  const directory = join(storageRoot, "ordinary-workspace-owners", projectKey);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const entries = await readdir(directory);
  const candidates = await Promise.all(entries.filter((name) => /^[0-9a-f-]{36}\.json$/i.test(name)).map(async (name) => ({
    ownerId: name.slice(0, -5),
    modified: await stat(join(directory, name)).then((item) => item.mtimeMs).catch(() => 0),
  })));
  candidates.sort((left, right) => right.modified - left.modified || left.ownerId.localeCompare(right.ownerId));
  const remember = async (ownerId: string, lease: WorkspaceOwnerLease): Promise<OrdinaryWorkspaceOwnerLease> => {
    const path = join(directory, `${ownerId}.json`);
    const touch = () => writeFile(path, JSON.stringify({ version: 1, ownerId }), { encoding: "utf8", mode: 0o600 });
    try { await touch(); }
    catch (error) { await lease.release(); throw error; }
    let released: Promise<void> | undefined;
    return { ownerId, release: () => released ??= (async () => { await touch(); await lease.release(); })() };
  };
  for (const candidate of candidates) {
    const lease = await acquireWorkspaceOwner(storageRoot, candidate.ownerId);
    if (lease !== undefined) return remember(candidate.ownerId, lease);
  }
  // Claim before publishing the slot so another activation cannot adopt it first.
  const ownerId = randomUUID();
  const lease = await acquireWorkspaceOwner(storageRoot, ownerId);
  if (lease === undefined) throw new Error("Could not allocate an agent workspace owner");
  return remember(ownerId, lease);
}

/** The same managed workspace can be opened twice. The second window must not adopt its owner or replay its handoff. */
export async function acquireWorkspaceOwner(storageRoot: string, ownerId: string): Promise<WorkspaceOwnerLease | undefined> {
  const directory = ownerRuntimeDirectory(storageRoot, ownerId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "owner.lock");
  const activationId = randomUUID();
  const claim = async (): Promise<boolean> => {
    try {
      const file = await open(path, "wx", 0o600);
      try { await file.writeFile(JSON.stringify({ pid: process.pid, activationId })); await file.sync(); }
      finally { await file.close(); }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  };
  let acquired = await claim();
  if (!acquired) {
    // Serializing abandoned-lock repair prevents two recovering windows from deleting one another's fresh claim.
    const repair = `${path}.repair`;
    try { await mkdir(repair); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined; throw error; }
    try {
      try {
        const record = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown };
        if (typeof record.pid !== "number" || !Number.isInteger(record.pid) || record.pid <= 0) return undefined;
        try { process.kill(record.pid, 0); return undefined; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") return undefined; }
        await rm(path);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined; }
      acquired = await claim();
    } finally { await rm(repair, { recursive: true, force: true }); }
  }
  if (!acquired) return undefined;
  let released: Promise<void> | undefined;
  return { release: () => released ??= (async () => {
    try {
      const record = JSON.parse(await readFile(path, "utf8")) as { activationId?: unknown };
      if (record.activationId === activationId) await rm(path, { force: true });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  })() };
}

export interface WorkspaceHandoff {
  readonly version: 1;
  readonly ownerId: string;
  readonly projectRoot: string;
  readonly requestId: string;
  readonly plan: unknown;
  readonly workspaceFile: string;
}

/** Only extension-managed files can designate an owner or trigger a startup request. */
export class AgentWorkspaceFiles {
  readonly #root: string;
  public constructor(storageRoot: string) { this.#root = resolve(storageRoot, "agent-workspaces"); }

  public async create(projectRoot: string, plan: unknown, requestId: string = randomUUID()): Promise<WorkspaceHandoff> {
    const ownerId = randomUUID();
    const projectName = basename(resolve(projectRoot)) || "Workspace";
    const workspaceFile = join(this.#root, ownerId, `${projectName}.code-workspace`);
    const handoff: WorkspaceHandoff = { version: 1, ownerId, projectRoot: resolve(projectRoot), requestId, plan, workspaceFile };
    await mkdir(dirname(workspaceFile), { recursive: true, mode: 0o700 });
    await writeFile(`${workspaceFile}.handoff.json`, JSON.stringify(handoff), { encoding: "utf8", flag: "wx", mode: 0o600 });
    await writeFile(workspaceFile, JSON.stringify({ folders: [{ path: handoff.projectRoot }], settings: { "workbench.editor.autoLockGroups": { terminal: false } } }, null, 2), { encoding: "utf8", flag: "wx", mode: 0o600 });
    return handoff;
  }

  public async read(workspaceFile: string, projectRoot: string): Promise<WorkspaceHandoff | undefined> {
    const directory = dirname(workspaceFile);
    const flat = normalizeProjectPath(directory) === normalizeProjectPath(this.#root);
    if (!flat && normalizeProjectPath(dirname(directory)) !== normalizeProjectPath(this.#root)) return undefined;
    try {
      const value: unknown = JSON.parse(await readFile(`${workspaceFile}.handoff.json`, "utf8"));
      if (value === null || typeof value !== "object") return undefined;
      const candidate = value as Partial<WorkspaceHandoff>;
      if (candidate.version !== 1 || typeof candidate.ownerId !== "string" || typeof candidate.requestId !== "string"
        || typeof candidate.projectRoot !== "string" || typeof candidate.workspaceFile !== "string"
        || (flat ? basename(workspaceFile) !== `${candidate.ownerId}.code-workspace`
          : basename(directory) !== candidate.ownerId || basename(workspaceFile) !== `${basename(resolve(projectRoot)) || "Workspace"}.code-workspace`)
        || normalizeProjectPath(candidate.workspaceFile) !== normalizeProjectPath(workspaceFile)
        || normalizeProjectPath(candidate.projectRoot) !== normalizeProjectPath(projectRoot)) return undefined;
      return candidate as WorkspaceHandoff;
    } catch { return undefined; }
  }
}

export class WorkspaceRequestUncertainError extends Error {
  public constructor(public readonly requestId: string) {
    super("This workspace launch was already claimed. Its startup outcome is uncertain; check the owner before retrying.");
  }
}

export class WorkspaceRequestConflictError extends Error {
  public constructor(public readonly requestId: string) {
    super("This workspace request identifier belongs to a different launch plan.");
  }
}

function requestFingerprint(binding: unknown): string {
  const serialized = JSON.stringify(binding ?? null, (_key, value: unknown) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
  });
  return createHash("sha256").update(serialized).digest("hex");
}

export type WorkspaceRequestState = { readonly state: "completed"; readonly result: unknown } | { readonly state: "uncertain" };

/** Claims are durable before terminal/layout side effects. A lost acknowledgment is never permission to launch again. */
export class WorkspaceRequestJournal {
  readonly #pending = new Map<string, { readonly promise: Promise<unknown>; readonly fingerprint: string }>();
  public constructor(private readonly directory: string) {}

  #path(requestId: string): string {
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(requestId)) throw new Error("Invalid workspace request identifier");
    return join(this.directory, `${requestId}.json`);
  }

  public async read(requestId: string): Promise<WorkspaceRequestState | undefined> {
    try {
      const value: unknown = JSON.parse(await readFile(this.#path(requestId), "utf8"));
      if (value !== null && typeof value === "object" && "state" in value && value.state === "completed" && "result" in value) {
        return { state: "completed", result: value.result };
      }
      return { state: "uncertain" };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      // Corrupt claims must never authorize a duplicate side effect.
      return { state: "uncertain" };
    }
  }

  public execute<T>(requestId: string, operation: () => Promise<T>, binding?: unknown): Promise<T> {
    const fingerprint = requestFingerprint(binding);
    const pending = this.#pending.get(requestId);
    if (pending !== undefined) return pending.fingerprint === fingerprint
      ? pending.promise as Promise<T> : Promise.reject(new WorkspaceRequestConflictError(requestId));
    const task = this.#execute(requestId, operation, fingerprint);
    this.#pending.set(requestId, { promise: task, fingerprint });
    void task.finally(() => this.#pending.delete(requestId)).catch(() => undefined);
    return task;
  }

  async #execute<T>(requestId: string, operation: () => Promise<T>, fingerprint: string): Promise<T> {
    const path = this.#path(requestId);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const claim = await open(path, "wx", 0o600);
      try { await claim.writeFile(JSON.stringify({ version: 1, state: "uncertain", fingerprint })); await claim.sync(); }
      finally { await claim.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const record = JSON.parse(await readFile(path, "utf8")) as { fingerprint?: unknown };
        if (record.fingerprint !== fingerprint) throw new WorkspaceRequestConflictError(requestId);
      } catch (error) {
        if (error instanceof WorkspaceRequestConflictError) throw error;
        throw new WorkspaceRequestUncertainError(requestId);
      }
      const existing = await this.read(requestId);
      if (existing?.state === "completed") return existing.result as T;
      throw new WorkspaceRequestUncertainError(requestId);
    }
    const result = await operation();
    const temporary = `${path}.${randomUUID()}.tmp`;
    const completed = await open(temporary, "wx", 0o600);
    try { await completed.writeFile(JSON.stringify({ version: 1, state: "completed", fingerprint, result: result ?? null })); await completed.sync(); }
    finally { await completed.close(); }
    try { await rename(temporary, path); }
    finally { await rm(temporary, { force: true }); }
    return result;
  }
}
