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

export function redactSecret(message: string, secret: string): string {
  return secret.length === 0 ? message : message.replaceAll(secret, "[redacted]");
}
