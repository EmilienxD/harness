import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export const COOKIE_NAME = "harness_grill_access";
const ATTEMPT_CAPACITY = 10;
const ATTEMPT_REFILL_MS = 30 * 60 * 1000;

/** Used only when the shared bucket is unreachable, so a database outage cannot remove the limit. */
const localBucket = { tokens: ATTEMPT_CAPACITY, refilledAt: Date.now() };

function takeLocalAttempt(): boolean {
  const earned = Math.max(0, Math.floor((Date.now() - localBucket.refilledAt) / ATTEMPT_REFILL_MS));
  const available = Math.min(ATTEMPT_CAPACITY, localBucket.tokens + earned);
  if (available <= 0) return false;
  localBucket.refilledAt =
    localBucket.tokens + earned >= ATTEMPT_CAPACITY ? Date.now() : localBucket.refilledAt + earned * ATTEMPT_REFILL_MS;
  localBucket.tokens = available - 1;
  return true;
}

export async function takeAccessAttempt(): Promise<boolean> {
  const { data, error } = await supabaseAdmin.rpc("grill_take_access_attempt");
  if (error) return takeLocalAttempt();
  return typeof data === "number" && data >= 0;
}

export async function resetAccessAttempts(): Promise<void> {
  localBucket.tokens = ATTEMPT_CAPACITY;
  localBucket.refilledAt = Date.now();
  await supabaseAdmin.rpc("grill_reset_access_attempts");
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function digest(value: string): Buffer {
  return createHmac("sha256", required("HARNESS_GRILL_SESSION_SECRET")).update(value).digest();
}

function same(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function validCode(candidate: string): boolean {
  const expected = required("HARNESS_GRILL_CODE");
  return /^\d{4}$/u.test(candidate) && /^\d{4}$/u.test(expected) && same(candidate, expected);
}

export function makeAccessCookie(request: Request): string {
  const payload = `${Date.now()}.${randomBytes(24).toString("base64url")}`;
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${COOKIE_NAME}=${payload}.${digest(payload).toString("base64url")}; Path=/; HttpOnly${secure}; SameSite=Strict`;
}

export function clearAccessCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

function cookieValue(request: Request): string | undefined {
  return request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE_NAME}=`))
    ?.slice(COOKIE_NAME.length + 1);
}

export function authenticateBrowser(request: Request): boolean {
  const token = cookieValue(request);
  if (!token) return false;
  const split = token.lastIndexOf(".");
  if (split < 1) return false;
  const payload = token.slice(0, split);
  const signature = token.slice(split + 1);
  const expected = digest(payload).toString("base64url");
  return same(signature, expected);
}

export type BearerAuthentication = "authorized" | "invalid" | "limited";

export async function authenticateBearer(request: Request): Promise<BearerAuthentication> {
  const match = /^Bearer ([^\s,]+)$/u.exec(request.headers.get("authorization") ?? "");
  const candidate = match?.[1];
  if (candidate === undefined) return "invalid";
  if (validCode(candidate)) return "authorized";
  return (await takeAccessAttempt()) ? "invalid" : "limited";
}
