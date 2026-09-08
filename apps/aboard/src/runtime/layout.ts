import { join } from "node:path";

/** All mutable aboard state lives in VS Code's workspace-specific storage. */
export class RuntimeLayout {
  public readonly root: string;

  public constructor(storageRoot: string) {
    this.root = join(storageRoot, "runtime");
  }

  public state(name: string): string { return join(this.root, "state", name); }
  public agent(agentId: string): string { return join(this.root, "agents", agentId); }
  public agents(): string { return join(this.root, "agents"); }
  public locks(): string { return join(this.root, "locks"); }
  public transcripts(): string { return join(this.root, "transcripts"); }
  public events(): string { return join(this.root, "events"); }
}
