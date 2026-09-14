import { createHash } from "node:crypto";

import {
  startFakeAnthropicServer as startCoreServer,
  type FakeAnthropicServer,
} from "../../../../tests/e2e/core/anthropic-server.js";
import { parseMessagesRequest, transition } from "./scenario.js";

export type { FakeAnthropicServer, ServerAssertions, StructuralObservation } from "../../../../tests/e2e/core/anthropic-server.js";

const CATALOG = "single-file-success:v1|auto-run-afk:v2|auto-run-hitl:v2|auto-run-hitl-review:v1|auto-run-followup:v1";

export function startFakeAnthropicServer(options: {
  readonly repoRoot: string;
  readonly resolveRepoRoot?: () => Promise<string>;
  readonly diagnosticsPath?: string;
  readonly readinessPath?: string;
}): Promise<FakeAnthropicServer> {
  return startCoreServer({
    ...options,
    scenarioCatalogHash: createHash("sha256").update(CATALOG).digest("hex"),
    parseRequest: parseMessagesRequest,
    transition,
  });
}
