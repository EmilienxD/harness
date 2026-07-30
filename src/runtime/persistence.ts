import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { FleetPersistenceDto } from "../domain/fleet.js";
import { parseFleetPersistenceDto } from "../domain/validation.js";

export class AtomicJsonFile<T> {
  public constructor(private readonly path: string, private readonly parse: (value: unknown) => T | undefined) {}
  public async load(): Promise<T | undefined> {
    try {
      const value: unknown = JSON.parse(await readFile(this.path, "utf8"));
      return this.parse(value);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return undefined;
      throw error;
    }
  }
  public async save(value: T): Promise<void> {
    const temporary = `${this.path}.${process.pid}.tmp`;
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rm(this.path, { force: true });
    await rename(temporary, this.path);
  }
}

export class FileFleetStore extends AtomicJsonFile<FleetPersistenceDto> {
  public constructor(workspaceRoot: string) {
    super(join(workspaceRoot, ".aboard", "runtime", "fleet.json"), (value) => {
      const result = parseFleetPersistenceDto(value);
      return result.ok ? result.value : undefined;
    });
  }
}

export class PersistOnChange {
  readonly #registration: { dispose(): void };
  #pending: Promise<void> = Promise.resolve();
  #disposed = false;
  public constructor(register: (listener: () => void) => { dispose(): void }, private readonly save: () => Promise<void>, private readonly onError: (error: unknown) => void) {
    this.#registration = register(() => { this.#pending = this.#pending.then(() => this.#disposed ? undefined : this.save()).catch(this.onError); });
  }
  public async dispose(): Promise<void> { this.#registration.dispose(); await this.#pending; await this.save(); this.#disposed = true; }
}
