import { rename } from "node:fs/promises";

/** Readers and antivirus can briefly deny replacement on Windows. Never unlink
 * the destination: its durable claim must survive every failed replacement. */
export async function atomicReplace(
  source: string,
  destination: string,
  replace: typeof rename = rename,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try { await replace(source, destination); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt === 20 || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "")) throw error;
      await sleep(100);
    }
  }
}
