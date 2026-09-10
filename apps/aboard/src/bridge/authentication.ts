import { createHash, timingSafeEqual } from "node:crypto";

const BEARER_PREFIX = "Bearer ";

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function isAuthorized(
  authorization: string | readonly string[] | undefined,
  expectedToken: string,
): boolean {
  if (typeof authorization !== "string" || !authorization.startsWith(BEARER_PREFIX)) {
    return false;
  }

  const suppliedToken = authorization.slice(BEARER_PREFIX.length);
  return timingSafeEqual(digest(suppliedToken), digest(expectedToken));
}

export interface BridgeTokens {
  readonly full: string;
  readonly command: string;
  readonly delegation: string;
}

export const COMMAND_SCOPE_ROOT = "/commands";
export const DELEGATION_SCOPE_ROOT = "/delegations";

/** `out-of-scope` is a valid credential used on a route it does not cover. */
export type AuthorizationOutcome = "full" | "command" | "delegation" | "unauthorized" | "out-of-scope";

function coversCommandScope(pathname: string): boolean {
  return pathname === COMMAND_SCOPE_ROOT || pathname.startsWith(`${COMMAND_SCOPE_ROOT}/`);
}

export function authorize(
  authorization: string | readonly string[] | undefined,
  tokens: BridgeTokens,
  pathname: string,
): AuthorizationOutcome {
  if (isAuthorized(authorization, tokens.full)) return "full";
  if (isAuthorized(authorization, tokens.command)) return coversCommandScope(pathname) ? "command" : "out-of-scope";
  if (isAuthorized(authorization, tokens.delegation)) return pathname === DELEGATION_SCOPE_ROOT ? "delegation" : "out-of-scope";
  return "unauthorized";
}

export function redactSecret(message: string, secret: string): string {
  return secret.length === 0 ? message : message.replaceAll(secret, "[redacted]");
}
