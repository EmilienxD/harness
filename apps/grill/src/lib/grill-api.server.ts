import { createHash } from "node:crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { compilePrompt, publicationSchema, type AnswerDraft, type RoundPayload } from "@/lib/grill-contract";

export const BUCKET = "grill-assets";
export const json = (body: unknown, status = 200, headers?: HeadersInit) => {
  const responseHeaders = new Headers(headers);
  if (!responseHeaders.has("Cache-Control")) responseHeaders.set("Cache-Control", "no-store");
  return Response.json(body, { status, headers: responseHeaders });
};
export const problem = (status: number, code: string, message: string, details?: unknown) =>
  json({ error: { code, message, ...(details === undefined ? {} : { details }) } }, status);

export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

export function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function validatePublication(value: unknown) {
  return publicationSchema.safeParse(value);
}

export function canonicalSessionUrl(provider: string, sessionId: string, requestOrigin?: string): string {
  const origin = process.env["HARNESS_GRILL_URL"] || requestOrigin || "";
  if (!origin) throw new Error("A Grill-Me board origin is required");
  const parsed = new URL(origin);
  if (parsed.origin !== origin) throw new Error("HARNESS_GRILL_URL must be an origin without a trailing slash");
  return `${origin}/?session=${encodeURIComponent(`${provider}:${sessionId}`)}`;
}

export async function getRound(roundId: string) {
  const { data: round, error } = await supabaseAdmin.from("grill_rounds").select("*").eq("id", roundId).maybeSingle();
  if (error || !round) return null;
  const [{ data: answers }, { data: assets }, { data: snapshots }] = await Promise.all([
    supabaseAdmin
      .from("grill_answer_drafts")
      .select("question_id,selected_option,note,state,updated_at,queued_at")
      .eq("round_id", roundId),
    supabaseAdmin
      .from("grill_round_assets")
      .select("id,original_reference,media_type,byte_size,sha256")
      .eq("round_id", roundId),
    supabaseAdmin
      .from("grill_prompt_snapshots")
      .select(
        "id,prompt,reason,created_at,grill_deliveries(id,status,failure_message,created_at,completed_at,expires_at)",
      )
      .eq("round_id", roundId)
      .order("created_at", { ascending: false }),
  ]);
  return { ...round, answers: answers ?? [], assets: assets ?? [], prompt_snapshots: snapshots ?? [] };
}

export async function promptForRound(roundId: string) {
  // Preview and snapshot validation only need the payload and answers. The full round also
  // fetches assets and every historical snapshot, which grows with each copy.
  const [{ data: round, error }, { data: answers }] = await Promise.all([
    supabaseAdmin.from("grill_rounds").select("id,session_id,status,payload").eq("id", roundId).maybeSingle(),
    supabaseAdmin
      .from("grill_answer_drafts")
      .select("question_id,selected_option,note,state")
      .eq("round_id", roundId),
  ]);
  if (error || !round) return null;
  return { round, prompt: compilePrompt(round.payload as RoundPayload, (answers ?? []) as AnswerDraft[]) };
}

export async function touchSession(sessionId: string): Promise<void> {
  const { error } = await supabaseAdmin.rpc("grill_touch_session", { target_session: sessionId });
  if (error) throw error;
}
