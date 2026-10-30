import { randomUUID } from "node:crypto";
import { lstat, readFile, stat } from "node:fs/promises";
import { existsSync as fileExists } from "node:fs";
import { acquireWorkspaceOwner, normalizeProjectPath } from "../runtime/agent-workspace-owner.js";
import { join } from "node:path";
import { ProcessGitClient } from "../git/client.js";
import { processSetupCommandRunner, runWorkspacePath, samePath, setupCommandLine, setupCommandPath, hasSetupCommands, type SetupCommandRunner } from "../git/worktree.js";

export type CheckoutSelection = { readonly kind: "current" } | { readonly kind: "existing"; readonly path: string } | { readonly kind: "new"; readonly branch: string; readonly startPoint?: string; readonly useExistingBranch?: boolean };
export interface CheckoutEntry { readonly path: string; readonly branch: string | undefined; readonly available: boolean; readonly dirty: boolean; readonly reserved?: boolean; readonly agents?: number; }
export interface CheckoutChoices { readonly entries: readonly CheckoutEntry[]; readonly nextPath?: string; readonly error?: string; }
interface SetupContext { readonly id: string; readonly source: string; readonly branch: string; }

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
        return { ...tree, available, dirty: (status?.entries.length ?? 0) > 0, reserved: this.options.reserved(tree.path), agents: this.options.activeAgents?.(tree.path) ?? 0 };
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
    const record: SetupContext = { id: randomUUID(), source: this.options.workspaceRoot, branch: selection.branch };
    let created = false;
    try {
      // Selection precedes the lease; never adopt another window's checkout.
      const occupied = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
      if (occupied || (await git.worktrees()).some((tree) => samePath(tree.path, path))) {
        throw new Error(`The checkout location ${path} is now occupied. Refresh and choose again.`);
      }
      await git.addWorktree(path, selection.branch, start);
      created = true;
      await this.#setup(path, record, progress);
    } catch (error) {
      if (!created) throw error;
      this.options.log(`Worktree setup failed at ${path}: ${message(error)}`);
      throw new CheckoutSetupError(path, `Worktree retained at ${path}. Setup failed: ${message(error)}`);
    } finally { await lease.release(); }
    return path;
  }

  async #requireCheckoutIdentity(path: string, mainRoot: string): Promise<void> {
    const target = new ProcessGitClient(path);
    const [root, trees] = await Promise.all([target.checkoutRoot().catch(() => undefined), target.worktrees()]);
    if (!root || !samePath(root, path) || !trees[0] || !samePath(trees[0].path, mainRoot)) {
      throw new Error(`The checkout at ${path} is missing or no longer belongs to this repository. Refresh and choose another checkout.`);
    }
  }

  async #setup(path: string, record: SetupContext, progress: (message: string) => void): Promise<void> {
    const script = join(record.source, setupCommandPath());
    const source = await readFile(script, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return ""; throw error; });
    if (hasSetupCommands(source)) {
      progress(`Running ${setupCommandPath()}…`);
      await (this.options.setup ?? processSetupCommandRunner).run({ ...setupCommandLine(script), cwd: path, env: { ABOARD_SESSION_PATH: path, ABOARD_PROJECT_ROOT: record.source, ABOARD_SESSION_BRANCH: record.branch, ABOARD_RUN_ID: record.id }, timeoutMs: this.options.settings().setupTimeoutSeconds * 1000 });
    }
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
