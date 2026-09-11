import type { AutoRunDryRunResult } from "../domain/auto-run.js";
import type { AutoRunStartResult } from "../auto/engine.js";
import type { BridgeRequestHandler } from "./protocol.js";
import { protocolError } from "./protocol.js";

export interface AutoRouteService {
  dryRun(options?: { readonly additionalGuideline?: string }): Promise<AutoRunDryRunResult>;
  start(options?: { readonly additionalGuideline?: string }): Promise<AutoRunStartResult>;
}

export function createAutoRoutes(service: AutoRouteService): BridgeRequestHandler {
  return async (request) => {
    if (request.method !== "POST" || request.url.pathname !== "/hooks/auto") {
      return protocolError(404, "not-found", "Route not found");
    }
    try {
      const body = object(request.body);
      requiredString(body.sessionId, "sessionId");
      const prompt = requiredString(body.prompt, "prompt").trim();
      if (prompt === "/auto --dry") {
        const result = await service.dryRun();
        return { status: 200, body: { message: JSON.stringify(result, null, 2) } };
      }
      if (prompt !== "/auto" && !prompt.startsWith("/auto ")) {
        return protocolError(400, "invalid-request", "prompt must be /auto or /auto --dry");
      }
      const additionalGuideline = prompt.slice("/auto".length).trim();
      const result = await service.start(additionalGuideline.length === 0 ? {} : { additionalGuideline });
      return { status: 200, body: { message: JSON.stringify(result, null, 2) } };
    } catch (error) {
      return protocolError(400, "invalid-request", error instanceof Error ? error.message : "Invalid auto hook request");
    }
  };
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Request body must be an object");
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${name} must be a non-empty string`);
  return value;
}
