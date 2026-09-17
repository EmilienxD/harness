/** Workspace consent for running all enabled Codex hooks during Auto Run. */
export class AutoRunHookTrust {
  #pending: Promise<boolean> | undefined;
  public constructor(private readonly host: {
    readonly isAllowed: () => boolean;
    readonly remember: () => Promise<void>;
    readonly ask: () => Promise<boolean>;
  }) {}

  public approve(): Promise<boolean> {
    if (this.host.isAllowed()) return Promise.resolve(true);
    if (this.#pending !== undefined) return this.#pending;
    this.#pending = this.#ask().finally(() => { this.#pending = undefined; });
    return this.#pending;
  }

  async #ask(): Promise<boolean> {
    if (!await this.host.ask()) return false;
    await this.host.remember();
    return true;
  }
}
