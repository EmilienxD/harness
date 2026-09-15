import { isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { containsPath } from "../../../../tests/e2e/core/path.js";

export const DEFAULT_REPOSITORY = "EmilienxD/harness-e2e";
export const DEFAULT_RUNTIME_ROOT = join(tmpdir(), "aboard-e2e-runtime");

export interface HarnessConfig {
  readonly repository: string;
  readonly runtimeRoot: string;
  readonly cloneRoot: string;
  readonly claudeConfigRoot: string;
  readonly diagnosticsPath: string;
  readonly ownershipPath: string;
  readonly readinessPath: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HarnessConfig {
  const repository = env.ABOARD_E2E_REPOSITORY?.trim() || DEFAULT_REPOSITORY;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error(`ABOARD_E2E_REPOSITORY must be an exact owner/name slug; received ${JSON.stringify(repository)}`);
  }
  const runtimeRoot = resolve(env.ABOARD_E2E_ROOT?.trim() || DEFAULT_RUNTIME_ROOT);
  if (!isAbsolute(runtimeRoot)) throw new Error("ABOARD_E2E_ROOT must resolve to an absolute path");
  const checkoutRoot = resolve(__dirname, "..", "..");
  if (contains(checkoutRoot, runtimeRoot) || contains(runtimeRoot, checkoutRoot)) {
    throw new Error("ABOARD_E2E_ROOT must be separate from the aboard checkout");
  }
  return {
    repository,
    runtimeRoot,
    cloneRoot: join(runtimeRoot, "repository"),
    claudeConfigRoot: join(runtimeRoot, "claude-config"),
    diagnosticsPath: join(runtimeRoot, "structural-diagnostics.json"),
    ownershipPath: join(runtimeRoot, "harness-ownership.json"),
    readinessPath: join(runtimeRoot, "server-readiness.json"),
  };
}

export function contains(parent: string, candidate: string): boolean {
  return containsPath(parent, candidate);
}
