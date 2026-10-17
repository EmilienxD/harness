// Pi 1.2.0 compatibility adapter: no public persistent registry-exclusion API.
import { AgentSession, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const key = Symbol.for("harness:exclude-unwanted-tools:pi-1.2.0");
const excluded = new Set(["powershell", "codemode", "find", "grep", "ls"]);

export default function excludeUnwantedTools(_pi: ExtensionAPI): void {
  const registry = globalThis as typeof globalThis & { [key: symbol]: boolean | undefined };
  if (registry[key]) return;
  const prototype = AgentSession.prototype as unknown as {
    _isAllowedTool(name: string): boolean;
  };
  const original = prototype._isAllowedTool;
  if (typeof original !== "function") {
    throw new Error("exclude-unwanted-tools needs updating for this Pi version. Launch with --exclude-tools powershell,codemode,find,grep,ls.");
  }
  prototype._isAllowedTool = function (name) {
    return !excluded.has(name) && original.call(this, name);
  };
  registry[key] = true;
}
