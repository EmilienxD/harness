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
}

export const COMMAND_SCOPE_ROOT = "/commands";

/** `out-of-scope` is a valid credential used on a route it does not cover. */
export type AuthorizationOutcome = "authorized" | "unauthorized" | "out-of-scope";

function coversCommandScope(pathname: string): boolean {
  return pathname === COMMAND_SCOPE_ROOT || pathname.startsWith(`${COMMAND_SCOPE_ROOT}/`);
}

export function authorize(
  authorization: string | readonly string[] | undefined,
  tokens: BridgeTokens,
  pathname: string,
): AuthorizationOutcome {
  if (isAuthorized(authorization, tokens.full)) return "authorized";
  if (!isAuthorized(authorization, tokens.command)) return "unauthorized";
  return coversCommandScope(pathname) ? "authorized" : "out-of-scope";
}

export function redactSecret(message: string, secret: string): string {
  return secret.length === 0 ? message : message.replaceAll(secret, "[redacted]");
}
