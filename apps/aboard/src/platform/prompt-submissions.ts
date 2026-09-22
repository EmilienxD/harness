import type { SessionId } from "../domain/contracts.js";

export interface PromptExpectation {
  /** True once the provider reports a submitted prompt; false on timeout or cancel. */
  readonly confirmed: Promise<boolean>;
  cancel(): void;
}

type Waiter = { readonly settle: (confirmed: boolean) => void };

/**
 * Pairs a prompt Aboard types into a provider terminal with the provider's own
 * report that a prompt was submitted, so a delivery is confirmed rather than assumed.
 */
export class PromptSubmissions {
  readonly #waiting = new Map<SessionId, Waiter[]>();

  /** Arm before typing: the provider hook can report before the paste call returns. */
  public expect(sessionId: SessionId, timeoutMs: number): PromptExpectation {
    let settle: (confirmed: boolean) => void = () => undefined;
    const confirmed = new Promise<boolean>((resolve) => {
      const waiter: Waiter = {
        settle: (value) => {
          clearTimeout(timer);
          this.#remove(sessionId, waiter);
          resolve(value);
        },
      };
      const timer = setTimeout(() => waiter.settle(false), timeoutMs);
      settle = waiter.settle;
      this.#waiting.set(sessionId, [...(this.#waiting.get(sessionId) ?? []), waiter]);
    });
    return { confirmed, cancel: () => settle(false) };
  }

  /** Prompts confirm in the order they were typed; one nobody awaits is ignored. */
  public submitted(sessionId: SessionId): boolean {
    const waiter = this.#waiting.get(sessionId)?.[0];
    if (waiter === undefined) return false;
    waiter.settle(true);
    return true;
  }

  #remove(sessionId: SessionId, waiter: Waiter): void {
    const remaining = (this.#waiting.get(sessionId) ?? []).filter((candidate) => candidate !== waiter);
    if (remaining.length > 0) this.#waiting.set(sessionId, remaining);
    else this.#waiting.delete(sessionId);
  }
}
