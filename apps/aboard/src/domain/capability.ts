
export type WriteCapability = "write-capable" | "read-only";

/** Provider-neutral launch policy, translated by each adapter. */
export interface LaunchRestrictions {
  readonly denySubagents?: true;
  readonly denyWeb?: true;
  readonly deniedCommands?: readonly string[];
  /** Original checkout paths; Pi communicates these as per-turn worktree guidance. */
  readonly protectedPaths?: readonly string[];
}
