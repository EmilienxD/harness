import { z } from "zod";
import { extractAuthoredDiagrams } from "./grill-diagrams.ts";

export const SCHEMA_VERSION = 1 as const;
// Reserved draft identity for round-wide notes; generated question IDs are always Q<number>.
export const NOTES_ID = "Notes";
export const PROVIDERS = ["claude", "chatgpt", "pi"] as const;
export const MEDIA_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/avif",
  "image/svg+xml",
  "video/mp4",
  "video/webm",
] as const;

export const optionSchema = z.object({
  letter: z.string().regex(/^[A-D]$/),
  label: z.string().trim().min(1),
  detail: z.string().trim().min(1),
});

export const questionSchema = z
  .object({
    id: z.string().regex(/^Q[1-9][0-9]*$/),
    question: z.string().trim().min(1),
    explanation_html: z.string().trim().min(1),
    recommendation: z.string().regex(/^[A-D]$/),
    init_js: z.string().optional(),
    options: z.array(optionSchema).min(1).max(4),
  })
  .superRefine((question, context) => {
    try {
      extractAuthoredDiagrams(question.explanation_html);
    } catch (error) {
      context.addIssue({ code: "custom", path: ["explanation_html"], message: (error as Error).message });
    }
    const letters = question.options.map((_option, index) => String.fromCharCode(65 + index));
    if (question.options.some((option, index) => option.letter !== letters[index])) {
      context.addIssue({ code: "custom", message: "Option letters must be consecutive from A" });
    }
    if (!question.options.some((option) => option.letter === question.recommendation)) {
      context.addIssue({ code: "custom", message: "Recommendation must name an available option" });
    }
  });

export const roundPayloadSchema = z
  .object({ questions: z.array(questionSchema).min(1) })
  .superRefine((payload, context) => {
    const ids = payload.questions.map((question) => question.id);
    if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", message: "Question IDs must be unique" });
  });

export const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 20 * 1024 * 1024;
export const MAX_ROUND_BYTES = 50 * 1024 * 1024;

export const assetManifestSchema = z
  .object({
    reference: z.string().min(1),
    media_type: z.enum(MEDIA_TYPES),
    byte_size: z.number().int().positive().max(MAX_VIDEO_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/i),
  })
  .superRefine((asset, context) => {
    if (!asset.media_type.startsWith("video/") && asset.byte_size > MAX_IMAGE_BYTES) {
      context.addIssue({ code: "custom", path: ["byte_size"], message: "Images cannot exceed 6 MiB" });
    }
  });

export const publicationSchema = z
  .object({
    provider: z.enum(PROVIDERS),
    session_id: z.string().min(1).max(512),
    title: z.string().max(200).optional().default(""),
    project: z
      .object({
        name: z.string().trim().min(1).max(200),
        path: z.string().trim().min(1).max(2_000),
      })
      .optional(),
    schema_version: z.literal(SCHEMA_VERSION),
    payload: roundPayloadSchema,
    assets: z.array(assetManifestSchema).max(20).default([]),
  })
  .superRefine((publication, context) => {
    if (publication.assets.reduce((total, asset) => total + asset.byte_size, 0) > MAX_ROUND_BYTES) {
      context.addIssue({ code: "custom", message: "Round assets exceed 50 MiB" });
    }
    if (new Set(publication.assets.map((asset) => asset.reference)).size !== publication.assets.length) {
      context.addIssue({ code: "custom", message: "Asset references must be unique" });
    }
  });

export type RoundPayload = z.infer<typeof roundPayloadSchema>;
export type GrillQuestion = z.infer<typeof questionSchema>;
export type AnswerDraft = {
  question_id: string;
  selected_option: string | null;
  note: string | null;
  state: "draft" | "queued";
};

export function compilePrompt(
  payload: RoundPayload,
  answers: readonly AnswerDraft[],
  diagramFeedback: Record<string, string[]> = {},
): string {
  const queued = new Map(
    answers.filter((answer) => answer.state === "queued").map((answer) => [answer.question_id, answer]),
  );
  // The agent still holds the round it authored, so the reply only needs the choice itself.
  const bullets: string[] = [];
  for (const question of payload.questions) {
    const answer = queued.get(question.id);
    const feedback = diagramFeedback[question.id] ?? [];
    if (!answer && !feedback.length) continue;
    const note = answer?.note?.trim() ?? "";
    if (!answer?.selected_option && !note && !feedback.length) continue;
    const choice = answer ? (answer.selected_option ?? "None of these") : "Diagram feedback";
    bullets.push(
      `- ${question.id}: ${choice}.${note ? ` ${note}` : ""}${feedback.length ? `\n${feedback.map((line) => `  ${line}`).join("\n")}` : ""}`,
    );
  }
  const notes = queued.get(NOTES_ID)?.note?.trim();
  if (notes) bullets.push(`- Additional Notes:\n${notes}`);
  return bullets.join("\n");
}
