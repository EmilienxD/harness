export class RuntimeAdmission {
  #open: boolean;
  #pending = new Set<Promise<unknown>>();

  public constructor(open: boolean) { this.#open = open; }

  public isOpen = (): boolean => this.#open;

  public async run<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.#open) throw new Error("aboard runtime is not initialized");
    let tracked!: Promise<T>;
    tracked = operation().finally(() => { this.#pending.delete(tracked); });
    this.#pending.add(tracked);
    return tracked;
  }

  /** Closes admission synchronously, then waits for every already-admitted operation. */
  public async close(): Promise<void> {
    this.#open = false;
    await Promise.allSettled([...this.#pending]);
  }

  public open(): void { this.#open = true; }
}

/** One admitted startup at a time; reset drains it through RuntimeAdmission. */
export class RuntimeStartup {
  #pending: Promise<void> | undefined;
  public constructor(private readonly admission: RuntimeAdmission) {}

  public run(operation: () => Promise<void>): Promise<void> {
    if (this.#pending !== undefined) return this.#pending;
    let pending!: Promise<void>;
    pending = this.admission.run(operation).finally(() => {
      if (this.#pending === pending) this.#pending = undefined;
    });
    this.#pending = pending;
    return pending;
  }
}
