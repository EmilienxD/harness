import { mkdtemp, realpath } from "node:fs/promises";

/** Resolve Windows short-name aliases before paths reach real CLI file tools. */
export async function canonicalMkdtemp(prefix: string): Promise<string> {
  return realpath(await mkdtemp(prefix));
}
