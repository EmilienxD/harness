import type { BridgeRequestHandler } from "./protocol.js";

export function combineHandlers(...handlers: readonly BridgeRequestHandler[]): BridgeRequestHandler {
  return async (request) => {
    for (const handler of handlers) {
      const response = await handler(request);
      if (response.status !== 404) return response;
    }
    return { status: 404, body: { ok: false, error: { code: "not-found", message: "Route not found" } } };
  };
}
