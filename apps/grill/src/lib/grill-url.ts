export const DEFAULT_GRILL_URL = "https://grill-me-in-cloud.vercel.app";

export function canonicalSessionUrl(provider: string, sessionId: string, requestOrigin?: string): string {
  const origin = (process.env["HARNESS_GRILL_URL"] || requestOrigin || DEFAULT_GRILL_URL).trim().replace(/\/+$/u, "");
  const parsed = new URL(origin);
  if (parsed.origin !== origin)
    throw new Error("HARNESS_GRILL_URL must be an origin without a path, query, or fragment");
  return `${origin}/?session=${encodeURIComponent(`${provider}:${sessionId}`)}`;
}
