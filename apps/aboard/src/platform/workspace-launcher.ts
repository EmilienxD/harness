/** A launch definition is deliberately separate from the owner's mutable sessions. */
export interface WorkspaceLaunchPlan {
  readonly preset: { readonly id: string; readonly name: string; readonly columns: number; readonly rows: number; readonly panes: readonly { readonly providers: readonly string[] }[] };
  readonly empty: boolean;
  readonly manual?: boolean;
  /** Resolved checkout for a current-window batch; never stored in a preset. */
  readonly checkoutRoot?: string;
}

export interface WorkspaceBatchResult {
  readonly started: number;
  readonly cancelled: number;
  readonly failed: readonly { provider: string; message: string; retrySafe?: boolean }[];
}

export interface WorkspaceLaunchProgress {
  readonly total: number;
  readonly started: number;
  readonly failed: number;
}

/** One notification at most; partial success deliberately cannot offer recovery actions. */
export async function presentWorkspaceBatchResult(result: WorkspaceBatchResult, error: (message: string) => PromiseLike<unknown>): Promise<void> {
  if (result.failed.length === 0) return;
  if (result.started > 0) {
    await error(`Started ${result.started} of ${result.started + result.failed.length + result.cancelled} terminals. ${result.failed.length} terminal${result.failed.length === 1 ? "" : "s"} failed to start.`);
    return;
  }
  if (result.failed.some((failure) => failure.retrySafe === false)) {
    await error("No terminals confirmed startup. A launch is still uncertain; inspect the original workspace before launching again.");
    return;
  }
  await error("No terminals started.");
}

export function validateWorkspaceLaunchPlan(value: unknown, providers: readonly string[]): WorkspaceLaunchPlan {
  if (typeof value !== "object" || value === null) throw new Error("A workspace launch plan is required");
  const plan = value as WorkspaceLaunchPlan;
  const preset = plan.preset;
  if (!preset || typeof preset.id !== "string" || typeof preset.name !== "string" || !Number.isInteger(preset.columns) || !Number.isInteger(preset.rows) || preset.columns < 1 || preset.rows < 1 || preset.columns * preset.rows > 9) throw new Error("Choose a rectangular layout containing one to nine panes");
  if (!Array.isArray(preset.panes) || preset.panes.length !== preset.columns * preset.rows) throw new Error("The preset pane count does not match its layout");
  for (const pane of preset.panes) if (!pane || !Array.isArray(pane.providers) || pane.providers.some((provider: string) => (provider !== "" && !providers.includes(provider)))) throw new Error("The preset contains an unavailable provider");
  if (typeof plan.empty !== "boolean" || (plan.manual !== undefined && typeof plan.manual !== "boolean")) throw new Error("Invalid workspace launch options");
  if (plan.checkoutRoot !== undefined && (typeof plan.checkoutRoot !== "string" || plan.checkoutRoot.length === 0)) throw new Error("Invalid checkout directory");
  return plan;
}

export class WorkspaceBatchLauncher {
  #pending: Promise<unknown> = Promise.resolve();
  public constructor(private readonly host: {
    readonly providers: readonly string[];
    readonly initialized: () => boolean;
    readonly markInitialized: () => Promise<void>;
    readonly initializeLayout: (columns: number, rows: number) => Promise<readonly object[]>;
    readonly launch: (provider: string, pane: object | undefined, onCreated: () => void, checkoutRoot?: string) => Promise<{ terminalId: string }>;
    readonly focus: (terminalId: string) => void;
  }) {}

  /** One-time new-window startup; replayed handoffs must never reapply the grid. */
  public launch(value: unknown, onProgress?: (progress: WorkspaceLaunchProgress) => void): Promise<WorkspaceBatchResult> {
    const plan = validateWorkspaceLaunchPlan(value, this.host.providers);
    // Serialize owner requests so two sources cannot race initialization or placement.
    const pending = this.#pending.then(() => this.#launch(plan, onProgress));
    this.#pending = pending.catch(() => undefined);
    return pending;
  }

  /** An explicit launch applies its grid once, including in an already initialized window. */
  public launchCurrent(value: unknown, onProgress?: (progress: WorkspaceLaunchProgress) => void): Promise<WorkspaceBatchResult> {
    const plan = validateWorkspaceLaunchPlan(value, this.host.providers);
    const pending = this.#pending.then(() => this.#launch(plan, onProgress, false));
    this.#pending = pending.catch(() => undefined);
    return pending;
  }

  async #launch(plan: WorkspaceLaunchPlan, onProgress?: (progress: WorkspaceLaunchProgress) => void, startup = true): Promise<WorkspaceBatchResult> {
    let panes: readonly object[] = [];
    if (startup && this.host.initialized()) throw new Error("The agent workspace is already initialized");
    try {
      panes = await this.host.initializeLayout(plan.preset.columns, plan.preset.rows);
      if (startup) await this.host.markInitialized();
    } catch (error) {
      return { started: 0, cancelled: 0, failed: [{ provider: "workspace", message: error instanceof Error ? error.message : String(error) }] };
    }
    return this.#launchAgents(plan, panes, onProgress);
  }

  async #launchAgents(plan: WorkspaceLaunchPlan, panes: readonly object[], onProgress?: (progress: WorkspaceLaunchProgress) => void): Promise<WorkspaceBatchResult> {
    const failed: { provider: string; message: string; retrySafe?: boolean }[] = [];
    const started: (string | undefined)[] = [];
    const pending: Promise<void>[] = [];
    let cancelled = false;
    const requested = plan.preset.panes.reduce((count, pane) => count + Math.max(1, pane.providers.length), 0);
    const report = () => onProgress?.({ total: plan.empty ? 0 : requested, started: started.filter((id) => id !== undefined).length, failed: failed.length });
    report();
    launchAssignments: if (!plan.empty) for (const [index, pane] of plan.preset.panes.entries()) {
      for (const provider of (pane.providers.length ? pane.providers : [""])) {
        if (cancelled) break launchAssignments;
        const placement = panes[index];
        let onCreated!: () => void;
        const created = new Promise<void>((resolve) => { onCreated = resolve; });
        const assignment = pending.length;
        const launch = (async () => {
          try { started[assignment] = (await this.host.launch(provider, placement, onCreated, plan.checkoutRoot)).terminalId; }
          catch (error) {
            if (error instanceof Error && error.name === "SessionStartCancelledError") cancelled = true;
            else failed.push({ provider, message: error instanceof Error ? error.message : String(error), ...(typeof error === "object" && error !== null && "retrySafe" in error && error.retrySafe === false ? { retrySafe: false } : {}) });
          }
          report();
        })();
        pending.push(launch);
        // Known panes can start independently once their terminals exist. With
        // automatic placement, wait for startup so native tab counts settle.
        if (placement !== undefined) await Promise.race([created, launch]);
        else await launch;
      }
    }
    await Promise.all(pending);
    const live = started.filter((id): id is string => id !== undefined);
    if (plan.manual && live.length > 0) this.host.focus(live[0]!);
    return { started: live.length, failed, cancelled: cancelled ? requested - live.length - failed.length : 0 };
  }
}
