import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { BUCKET, json, problem, readJson, touchSession } from "./grill-api.server";
import { extractAuthoredDiagrams } from "./grill-diagrams";
import { meaningfulScene } from "./diagram-feedback";
import type { DiagramScene } from "./diagram-scene";
import { validDiagramPng } from "./diagram-png.server";
const MAX_DIAGRAM_PNG_BYTES = 2_900_000;

const sceneSchema = z.object({
  elements: z.array(z.object({ id: z.string().min(1).max(200), type: z.string().min(1) }).passthrough()).max(10_000),
  appState: z.record(z.unknown()),
  files: z.record(z.object({ dataURL: z.string(), mimeType: z.string() }).passthrough()),
});
const bodySchema = z.object({
  source: z.string().max(100_000),
  scene: sceneSchema,
  baseline: sceneSchema,
  imageFallback: z.boolean(),
  expected_revision: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
});
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

export async function diagramOperation(
  request: Request,
  roundId: string,
  questionId?: string,
  diagramId?: string,
  image = false,
): Promise<Response> {
  const { data: round, error: roundError } = await supabaseAdmin
    .from("grill_rounds")
    .select("status,payload,session_id")
    .eq("id", roundId)
    .maybeSingle();
  if (roundError || !round) return problem(404, "round_not_found", "Round not found.");
  if (request.method === "GET" && !questionId) {
    const { data, error } = await supabaseAdmin
      .from("grill_diagram_scenes")
      .select("question_id,diagram_id,source,baseline,scene,image_fallback,revision")
      .eq("round_id", roundId);
    if (error)
      return problem(500, "scenes_unavailable", "Diagram drawings could not be loaded. Retry to preserve saved edits.");
    return json({
      scenes: (data ?? []).map(({ image_fallback, ...row }) => ({ ...row, imageFallback: image_fallback })),
    });
  }
  if (round.status !== "active") return problem(409, "stale_round", "Historical rounds are read-only.");
  const question = (round.payload as { questions: Array<{ id: string; explanation_html: string }> }).questions.find(
    (item) => item.id === questionId,
  );
  const diagram = question && extractAuthoredDiagrams(question.explanation_html).find((item) => item.id === diagramId);
  if (!diagram) return problem(404, "diagram_not_found", "Diagram not found.");
  const raw = await readJson(request);
  if (Buffer.byteLength(JSON.stringify(raw ?? null)) > 4_000_000)
    return problem(413, "diagram_too_large", "The diagram is too large to save.");
  if (image) {
    const parsed = z
      .object({
        revision: z.string().regex(/^[a-f0-9]{64}$/),
        png: z.string().max(Math.ceil((MAX_DIAGRAM_PNG_BYTES * 4) / 3)),
      })
      .safeParse(raw);
    if (!parsed.success) return problem(422, "invalid_diagram_image", "The diagram image is invalid.");
    const { data: scene } = await supabaseAdmin
      .from("grill_diagram_scenes")
      .select("revision")
      .eq("round_id", roundId)
      .eq("question_id", questionId!)
      .eq("diagram_id", diagramId!)
      .maybeSingle();
    if (scene?.revision !== parsed.data.revision)
      return problem(409, "scene_conflict", "The diagram changed before its image was saved. Retry review.");
    const bytes = Buffer.from(parsed.data.png, "base64");
    if (bytes.length > MAX_DIAGRAM_PNG_BYTES || !validDiagramPng(bytes))
      return problem(
        422,
        "invalid_diagram_image",
        "The PNG export is invalid or exceeds the 2.9 MB diagram image limit.",
      );
    const sha256 = digest(bytes);
    const { data: existing } = await supabaseAdmin
      .from("grill_round_assets")
      .select("id,sha256")
      .eq("round_id", roundId)
      .eq("question_id", questionId!)
      .eq("diagram_id", diagramId!)
      .eq("scene_revision", scene.revision)
      .maybeSingle();
    if (existing) return json({ asset_id: existing.id, sha256: existing.sha256 });
    const id = randomUUID();
    const path = `${roundId}/diagrams/${id}.png`;
    const { error: uploadError } = await supabaseAdmin.storage
      .from(BUCKET)
      .upload(path, bytes, { contentType: "image/png", upsert: false });
    if (uploadError)
      return problem(
        500,
        "diagram_export_failed",
        "The diagram image could not be stored. Your drawing is saved; retry review.",
      );
    const { error } = await supabaseAdmin.from("grill_round_assets").insert({
      id,
      round_id: roundId,
      original_reference: `diagram:${questionId}/${diagramId}/${scene.revision}`,
      object_path: path,
      media_type: "image/png",
      byte_size: bytes.length,
      sha256,
      question_id: questionId,
      diagram_id: diagramId,
      scene_revision: scene.revision,
    });
    if (error) {
      await supabaseAdmin.storage.from(BUCKET).remove([path]);
      return problem(500, "diagram_export_failed", "The diagram image metadata could not be stored. Retry review.");
    }
    return json({ asset_id: id, sha256 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return problem(422, "invalid_diagram", "The diagram drawing is invalid.");
  if (parsed.data.source !== diagram.source)
    return problem(409, "source_conflict", "The authored diagram differs. Your drawing has been preserved.");
  const input = parsed.data;
  const revision = digest(meaningfulScene(input.scene as unknown as DiagramScene));
  const { data, error } = await supabaseAdmin.rpc("grill_save_diagram", {
    target_round: roundId,
    target_question: questionId,
    target_diagram: diagramId,
    target_source: input.source,
    target_source_sha256: digest(input.source),
    target_baseline: input.baseline,
    target_scene: input.scene,
    target_image_fallback: input.imageFallback,
    target_revision: revision,
    expected_revision: input.expected_revision,
  });
  if (error || !data?.[0])
    return problem(
      error?.message.includes("conflict") || error?.message.includes("stale_round") ? 409 : 500,
      "diagram_save_failed",
      "The diagram could not be saved. Your local drawing is preserved; retry or reload after resolving changes on another device.",
    );
  await touchSession(round.session_id);
  return json({ revision: data[0].revision, baseline: data[0].baseline });
}
