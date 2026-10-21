import { randomUUID, createHash } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync as fileExists } from "node:fs";
import { acquireWorkspaceOwner, normalizeProjectPath } from "../runtime/agent-workspace-owner.js";
import { dirname, join, resolve } from "node:path";
import { ProcessGitClient } from "../git/client.js";
import { overlayProjectConfiguration, processSetupCommandRunner, runWorkspacePath, samePath, setupCommandLine, setupCommandPath, hasSetupCommands, type SetupCommandRunner } from "../git/worktree.js";

export type CheckoutSelection = { readonly kind: "current" } | { readonly kind: "existing"; readonly path: string } | { readonly kind: "new"; readonly branch: string; readonly startPoint?: string; readonly useExistingBranch?: boolean };
export interface CheckoutEntry { readonly path: string; readonly branch: string | undefined; readonly available: boolean; readonly dirty: boolean; readonly reserved?: boolean; readonly agents?: number; readonly preparation?: "preparing" | "failed"; }
export interface CheckoutChoices { readonly entries: readonly CheckoutEntry[]; readonly nextPath?: string; readonly error?: string; }
interface Preparation { readonly id: string; readonly source: string; readonly branch: string; readonly state: "preparing" | "failed" | "ready"; }

export function validateCheckoutSelection(value: unknown): CheckoutSelection {
  if (value === undefined) return { kind: "current" };
  if (!value || typeof value !== "object") throw new Error("Choose a checkout.");
  const selected = value as Record<string, unknown>;
  if (selected.kind === "current") return { kind: "current" };
  if (selected.kind === "existing" && typeof selected.path === "string" && selected.path.length > 0) return { kind: "existing", path: selected.path };
  if (selected.kind === "new" && typeof selected.branch === "string" && selected.branch.trim().length > 0) {
    if (selected.startPoint !== undefined && typeof selected.startPoint !== "string") throw new Error("Choose a valid starting point.");
    if (selected.useExistingBranch !== undefined && typeof selected.useExistingBranch !== "boolean") throw new Error("Invalid existing branch choice.");
    return { kind: "new", branch: selected.branch.trim(), ...(typeof selected.startPoint === "string" && selected.startPoint.trim() ? { startPoint: selected.startPoint.trim() } : {}), ...(selected.useExistingBranch === true ? { useExistingBranch: true } : {}) };
  }
  throw new Error("Choose a checkout and enter a branch name for a new worktree.");
}

/** Manual checkouts are retained, including failed preparations. Never adopts Auto Run cleanup rules. */
export class ManualCheckouts {
  #pending: Promise<unknown> = Promise.resolve();
  constructor(private readonly options: {
    workspaceRoot: string;
    storageRoot: string;
    settings: () => { root: string; setupTimeoutSeconds: number };
    reserved: (path: string) => boolean;
    activeAgents?: (path: string) => number;
    log: (message: string) => void;
    setup?: SetupCommandRunner;
  }) {}

  async choices(): Promise<CheckoutChoices> {
    let entries: readonly CheckoutEntry[] = [];
    try {
      const git = new ProcessGitClient(this.options.workspaceRoot);
      const trees = await git.worktrees();
      if (trees.length === 0) return { entries: [], error: "Worktrees require a Git repository." };
      entries = await Promise.all(trees.map(async (tree): Promise<CheckoutEntry> => {
        const status = await new ProcessGitClient(tree.path).status().catch(() => undefined);
        const available = status !== undefined && await this.#requireCheckoutIdentity(tree.path, trees[0]!.path).then(() => true, () => false);
        const preparation = await this.#readPreparation(tree.path);
        return { ...tree, available, dirty: (status?.entries.length ?? 0) > 0, reserved: this.options.reserved(tree.path), agents: this.options.activeAgents?.(tree.path) ?? 0, ...(preparation && preparation.state !== "ready" ? { preparation: preparation.state } : {}) };
      }));
      await git.headSha();
      return { entries, nextPath: runWorkspacePath({ workspaceRoot: trees[0]!.path, sourceRoot: this.options.workspaceRoot, root: this.options.settings().root, exists: (path) => entries.some((entry) => samePath(entry.path, path)) || fileExists(path) }) };
    } catch (error) {
      return { entries, error: `Worktree creation is unavailable: ${message(error)}` };
    }
  }

  async branchExists(branch: string): Promise<boolean> { return new ProcessGitClient(this.options.workspaceRoot).branchExists(branch); }

  prepare(selection: CheckoutSelection, progress: (message: string) => void = () => {}): Promise<string> {
    const pending = this.#pending.then(() => this.#prepare(selection, progress));
    this.#pending = pending.catch(() => undefined);
    return pending;
  }

  async #prepare(selection: CheckoutSelection, progress: (message: string) => void): Promise<string> {
    if (selection.kind !== "new") {
      const path = selection.kind === "current" ? this.options.workspaceRoot : selection.path;
      if (this.options.reserved(path)) throw new Error("This checkout is reserved by an active Auto Run. Stop that run before launching agents here.");
      if (selection.kind === "existing") {
        const trees = await new ProcessGitClient(this.options.workspaceRoot).worktrees();
        if (!trees.some((tree) => samePath(tree.path, path))) throw new Error("That checkout is no longer registered with this repository. Refresh and choose again.");
        await this.#requireCheckoutIdentity(path, trees[0]!.path);
      }
      const directory = await stat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
      if (!directory?.isDirectory()) throw new Error(`The checkout at ${path} is missing.`);
      const preparation = await this.#readPreparation(path);
      if (preparation && preparation.state !== "ready") throw new CheckoutSetupError(path, `Setup has not completed in ${path}. Retry setup before launching agents.`);
      return path;
    }
    const git = new ProcessGitClient(this.options.workspaceRoot);
    await git.validateBranchName(selection.branch);
    const trees = await git.worktrees();
    const checkedOut = trees.find((tree) => tree.branch === selection.branch);
    if (checkedOut) throw new CheckoutBranchInUseError(checkedOut.path, selection.branch);
    const existing = await git.branchExists(selection.branch);
    if (existing && !selection.useExistingBranch) throw new Error(`Branch ${selection.branch} already exists. Choose Use existing branch to create a worktree for it.`);
    if (!existing && selection.useExistingBranch) throw new Error(`Branch ${selection.branch} no longer exists. Clear Use existing branch to create it.`);
    const start = existing ? undefined : await git.resolveCommit(selection.startPoint ?? "HEAD");
    if (!trees[0]) throw new Error("A main checkout is required.");
    const path = runWorkspacePath({ workspaceRoot: trees[0].path, sourceRoot: this.options.workspaceRoot, root: this.options.settings().root, exists: (candidate) => trees.some((tree) => samePath(candidate, tree.path)) || fileExists(candidate) });
    progress(`Creating checkout at ${path}…`);
    // Git owns path/branch reservation across processes. Never force or retry a partially successful add.
    const lease = await acquireWorkspaceOwner(this.options.storageRoot, `checkout-setup:${normalizeProjectPath(path)}`);
    if (!lease) throw new Error(`Checkout setup is already in progress at ${path}.`);
    const record: Preparation = { id: randomUUID(), source: this.options.workspaceRoot, branch: selection.branch, state: "preparing" };
    let intentWritten = false;
    try {
      // Selection precedes the lease. Another window may have finished creating this
      // path meanwhile; never replace its preparation record or adopt its checkout.
      const occupied = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
      if (occupied || (await git.worktrees()).some((tree) => samePath(tree.path, path))) {
        throw new Error(`The checkout location ${path} is now occupied. Refresh and choose again.`);
      }
      // Record intent before Git effects so an interrupted creation never appears prepared.
      await this.#writePreparation(path, record);
      intentWritten = true;
      await git.addWorktree(path, selection.branch, start);
      await this.#setup(path, record, progress);
    } catch (error) {
      if (!intentWritten) throw error;
      this.options.log(`Worktree setup failed at ${path}: ${message(error)}`);
      const remaining = await git.worktrees();
      const registered = remaining.some((tree) => samePath(tree.path, path) && tree.branch === selection.branch);
      if (!registered && remaining.length > 0) {
        // Git may have lost a race to an external creator. Our failed intent must
        // not make that unrelated checkout eligible for our setup script.
        await rm(this.#recordPath(path), { force: true });
        throw error;
      }
      await this.#writePreparation(path, { ...record, state: "failed" }).catch(() => undefined);
      if (!registered) throw error; // An unavailable Git inventory is not proof that creation had no effects.
      throw new CheckoutSetupError(path, `Worktree retained at ${path}. Setup failed: ${message(error)}`);
    } finally { await lease.release(); }
    return path;
  }

  async retrySetup(path: string, progress: (message: string) => void = () => {}): Promise<string> {
    const pending = this.#pending.then(async () => {
      const record = await this.#readPreparation(path);
      if (!record || record.state === "ready") throw new Error("This checkout has no failed setup to retry.");
      const trees = await new ProcessGitClient(this.options.workspaceRoot).worktrees();
      if (!trees.some((tree) => samePath(tree.path, path) && tree.branch === record.branch)) throw new Error("The checkout or branch has changed; setup will not be retried.");
      await this.#requireCheckoutIdentity(path, trees[0]!.path);
      if (this.options.reserved(path)) throw new Error("This checkout is reserved by Auto Run.");
      const lease = await acquireWorkspaceOwner(this.options.storageRoot, `checkout-setup:${normalizeProjectPath(path)}`);
      if (!lease) throw new Error(`Checkout setup is already in progress at ${path}.`);
      try {
        // Re-read under the lease: another window may have completed setup while this request waited.
        const latest = await this.#readPreparation(path);
        if (latest?.state !== "ready") await this.#setup(path, record, progress);
        return path;
      } finally { await lease.release(); }
    });
    this.#pending = pending.catch(() => undefined);
    return pending;
  }

  async #requireCheckoutIdentity(path: string, mainRoot: string): Promise<void> {
    const target = new ProcessGitClient(path);
    const [root, trees] = await Promise.all([target.checkoutRoot().catch(() => undefined), target.worktrees()]);
    if (!root || !samePath(root, path) || !trees[0] || !samePath(trees[0].path, mainRoot)) {
      throw new Error(`The checkout at ${path} is missing or no longer belongs to this repository. Refresh and choose another checkout.`);
    }
  }

  async #setup(path: string, record: Preparation, progress: (message: string) => void): Promise<void> {
    progress("Preparing project configuration…");
    await overlayProjectConfiguration({ workspaceRoot: record.source, worktreeRoot: path, git: new ProcessGitClient(path) });
    const script = join(record.source, setupCommandPath());
    const source = await readFile(script, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return ""; throw error; });
    if (hasSetupCommands(source)) {
      progress(`Running ${setupCommandPath()}…`);
      await (this.options.setup ?? processSetupCommandRunner).run({ ...setupCommandLine(script), cwd: path, env: { ABOARD_SESSION_PATH: path, ABOARD_PROJECT_ROOT: record.source, ABOARD_SESSION_BRANCH: record.branch, ABOARD_RUN_ID: record.id }, timeoutMs: this.options.settings().setupTimeoutSeconds * 1000 });
    }
    await this.#writePreparation(path, { ...record, state: "ready" });
  }
  #recordPath(path: string): string { return join(this.options.storageRoot, "manual-checkouts", `${createHash("sha256").update(normalizeProjectPath(resolve(path))).digest("hex")}.json`); }
  async #readPreparation(path: string): Promise<Preparation | undefined> {
    try { return JSON.parse(await readFile(this.#recordPath(path), "utf8")) as Preparation; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }
  async #writePreparation(path: string, record: Preparation): Promise<void> {
    const target = this.#recordPath(path);
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(record), "utf8");
    await rename(temporary, target);
  }
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
export class CheckoutSetupError extends Error { constructor(readonly path: string, message: string) { super(message); this.name = "CheckoutSetupError"; } }
export class CheckoutBranchInUseError extends Error {
  constructor(readonly path: string, branch: string) {
    super(`Branch ${branch} is already checked out at ${path}. Choose its existing worktree instead.`);
    this.name = "CheckoutBranchInUseError";
  }
}
