
export type WriteCapability = "write-capable" | "read-only";

/** Provider-neutral restrictions which each agent adapter encodes natively. */
export interface LaunchRestrictions {
  readonly denySubagents?: true;
  readonly denyWeb?: true;
  readonly deniedCommands?: readonly string[];
  readonly protectedPaths?: readonly string[];
}
