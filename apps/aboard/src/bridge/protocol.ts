import type { IncomingHttpHeaders } from "node:http";

export type BridgeErrorCode =
  | "unauthorized"
  | "forbidden"
  | "malformed-request"
  | "invalid-request"
  | "conflict"
  /** A claimed launch with an unknown outcome must retain its request identity. */
  | "startup-uncertain"
  | "terminal-closed"
  | "not-found"
  | "internal-error";

export interface BridgeProtocolError {
  readonly ok: false;
  readonly error: {
    readonly code: BridgeErrorCode;
    readonly message: string;
  };
}

export interface AuthenticatedBridgeRequest {
  /** Credential class established by the loopback server. Omitted only by direct in-process callers. */
  readonly authorizationScope?: "full" | "command" | "delegation";
  readonly method: string;
  readonly url: URL;
  readonly headers: IncomingHttpHeaders;
  readonly body: unknown;
  readonly signal: AbortSignal;
}

export interface BridgeResponse {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export type BridgeRequestHandler = (
  request: AuthenticatedBridgeRequest,
) => BridgeResponse | Promise<BridgeResponse>;

export function protocolError(
  status: number,
  code: BridgeErrorCode,
  message: string,
): BridgeResponse {
  return { status, body: { ok: false, error: { code, message } } };
}
