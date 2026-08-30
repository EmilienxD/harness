import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AgentId } from "../domain/contracts.js";

export interface PrototypeFolderAllocator {
  allocate(agentId: AgentId, description: string): Promise<string>;
}

export function prototypeSlug(description: string): string {
  const slug = description
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48)
    .replace(/-+$/gu, "");
  return slug.length === 0 ? "experiment" : slug;
}

export class FilePrototypeFolderAllocator implements PrototypeFolderAllocator {
  public constructor(private readonly workspaceRoot: string) {}

  public async allocate(agentId: AgentId, description: string): Promise<string> {
    const root = join(this.workspaceRoot, ".aboard", "prototypes");
    await mkdir(root, { recursive: true });
    const stem = `${agentId}-${prototypeSlug(description)}`;
    for (let suffix = 1; ; suffix += 1) {
      const path = join(root, suffix === 1 ? stem : `${stem}-${suffix}`);
      try {
        await mkdir(path);
        return path;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
  }
}
