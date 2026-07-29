import type { IncomingHttpHeaders } from "node:http";

export type BridgeErrorCode =
  | "unauthorized"
  | "malformed-request"
  | "invalid-request"
  | "conflict"
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
