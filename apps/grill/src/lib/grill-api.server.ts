import { createHash, randomUUID } from "node:crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { compilePrompt, publicationSchema, type AnswerDraft, type RoundPayload } from "@/lib/grill-contract";

import { extractAuthoredDiagrams } from "./grill-diagrams";
import { diagramChanged, summarizeDiagram } from "./diagram-feedback";
import type { DiagramScene } from "./diagram-scene";

export { canonicalSessionUrl, DEFAULT_GRILL_URL } from "./grill-url";
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

export async function getRound(roundId: string, cachedContent = false) {
  const query = supabaseAdmin.from("grill_rounds");
  const { data: round, error } = cachedContent
    ? await query.select("id,status").eq("id", roundId).maybeSingle()
    : await query.select("*").eq("id", roundId).maybeSingle();
  if (error || !round) return null;
  const [answerResult, assetResult, snapshotResult] = await Promise.all([
    supabaseAdmin
      .from("grill_answer_drafts")
      .select("question_id,selected_option,note,state,updated_at,queued_at")
      .eq("round_id", roundId),
    cachedContent
      ? Promise.resolve({ data: undefined, error: null })
      : supabaseAdmin
          .from("grill_round_assets")
          .select("id,original_reference,media_type,byte_size,sha256")
          .eq("round_id", roundId),
    supabaseAdmin
      .from("grill_prompt_snapshots")
      .select("id,reason,grill_deliveries!inner(status)")
      .eq("round_id", roundId)
      .eq("grill_deliveries.status", "submitted-to-terminal")
      .limit(1, { referencedTable: "grill_deliveries" })
      .limit(1),
  ]);
  if (answerResult.error || assetResult.error || snapshotResult.error)
    throw new Error("Round updates could not be loaded. Retry shortly.");
  return {
    ...round,
    answers: answerResult.data ?? [],
    ...(cachedContent ? {} : { assets: assetResult.data ?? [] }),
    prompt_snapshots: snapshotResult.data ?? [],
  };
}

export async function promptForRound(roundId: string) {
  // Explicit review needs question source and saved diagram feedback. Keep those reads
  // separate from the board's lightweight answer and delivery updates.
  const [
    { data: round, error },
    { data: answers },
    { data: scenes, error: sceneError },
    { data: images, error: imageError },
  ] = await Promise.all([
    supabaseAdmin.from("grill_rounds").select("id,session_id,status,payload").eq("id", roundId).maybeSingle(),
    supabaseAdmin.from("grill_answer_drafts").select("question_id,selected_option,note,state").eq("round_id", roundId),
    supabaseAdmin
      .from("grill_diagram_scenes")
      .select("question_id,diagram_id,scene,baseline,revision")
      .eq("round_id", roundId),
    supabaseAdmin
      .from("grill_round_assets")
      .select("id,question_id,diagram_id,scene_revision,sha256,byte_size,media_type")
      .eq("round_id", roundId)
      .not("scene_revision", "is", null),
  ]);
  if (error || !round) return null;
  if (sceneError || imageError) throw new Error("Saved diagram feedback could not be loaded. Retry review.");
  const payload = round.payload as RoundPayload;
  const feedback: Record<string, string[]> = {};
  const diagramRevisions: Record<string, string> = {};
  const snapshotImages: Array<{
    asset_id: string;
    question_id: string;
    diagram_id: string;
    scene_revision: string;
    sha256: string;
    byte_size: number;
    media_type: string;
    reference: string;
    reference_start?: number;
    reference_end?: number;
  }> = [];
  const markerPrefix = randomUUID();
  let missingImages = false;
  for (const row of scenes ?? []) diagramRevisions[`${row.question_id}/${row.diagram_id}`] = row.revision;
  for (const question of payload.questions) {
    const diagrams = extractAuthoredDiagrams(question.explanation_html);
    const changed = (scenes ?? []).some(
      (row) =>
        row.question_id === question.id && diagramChanged(row.baseline as DiagramScene, row.scene as DiagramScene),
    );
    if (!changed && !(answers ?? []).some((answer) => answer.question_id === question.id && answer.state === "queued"))
      continue;
    feedback[question.id] = diagrams.flatMap((diagram) => {
      const row = (scenes ?? []).find((scene) => scene.question_id === question.id && scene.diagram_id === diagram.id);
      if (!row || !diagramChanged(row.baseline as DiagramScene, row.scene as DiagramScene)) return [];
      const summary = summarizeDiagram(row.baseline as DiagramScene, row.scene as DiagramScene);
      const asset = (images ?? []).find(
        (item) =>
          item.question_id === question.id && item.diagram_id === diagram.id && item.scene_revision === row.revision,
      );
      if (!asset) {
        missingImages = true;
        return `Diagram ${diagram.id}: ${summary}`;
      }
      const reference = asset.id;
      snapshotImages.push({
        asset_id: asset.id,
        question_id: question.id,
        diagram_id: diagram.id,
        scene_revision: row.revision,
        sha256: asset.sha256,
        byte_size: asset.byte_size,
        media_type: asset.media_type,
        reference,
      });
      return `Diagram ${diagram.id}: ${summary}\n  Image: ${markerPrefix}:${snapshotImages.length - 1}:${markerPrefix}`;
    });
  }
  if (snapshotImages.length > 20 || snapshotImages.reduce((sum, image) => sum + image.byte_size, 0) > 50 * 1024 * 1024)
    throw new Error(
      "Review supports at most 20 edited diagrams and 50 MiB of images per round. Split this round before continuing.",
    );
  let prompt = compilePrompt(payload, (answers ?? []) as AnswerDraft[], feedback);
  for (const [index, image] of snapshotImages.entries()) {
    const marker = `${markerPrefix}:${index}:${markerPrefix}`;
    const start = prompt.indexOf(marker);
    if (start < 0) throw new Error("Image reference could not be prepared.");
    prompt = prompt.slice(0, start) + image.reference + prompt.slice(start + marker.length);
    image.reference_start = start;
    image.reference_end = start + image.reference.length;
  }
  return {
    round,
    prompt,
    diagramRevisions,
    images: snapshotImages,
    missingImages,
  };
}

export async function touchSession(sessionId: string): Promise<void> {
  const { error } = await supabaseAdmin.rpc("grill_touch_session", { target_session: sessionId });
  if (error) throw error;
}
