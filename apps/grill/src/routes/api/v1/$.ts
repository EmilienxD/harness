import { createFileRoute } from "@tanstack/react-router";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  authenticateBearer,
  authenticateBrowser,
  clearAccessCookie,
  makeAccessCookie,
  resetAccessAttempts,
  takeAccessAttempt,
  validCode,
} from "@/lib/grill-auth.server";
import {
  BUCKET,
  canonicalSessionUrl,
  fingerprint,
  getRound,
  json,
  problem,
  promptForRound,
  readJson,
  touchSession,
  validatePublication,
} from "@/lib/grill-api.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { NOTES_ID, PROVIDERS } from "@/lib/grill-contract";
import { diagramOperation } from "@/lib/diagram-api.server";
import { assetResponse, mediaMatches } from "@/lib/grill-assets.server";

export const Route = createFileRoute("/api/v1/$")({
  server: {
    handlers: {
      GET: ({ request, params }) => handle(request, params._splat ?? "", "GET"),
      HEAD: ({ request, params }) => handle(request, params._splat ?? "", "HEAD"),
      POST: ({ request, params }) => handle(request, params._splat ?? "", "POST"),
      PUT: ({ request, params }) => handle(request, params._splat ?? "", "PUT"),
      DELETE: ({ request, params }) => handle(request, params._splat ?? "", "DELETE"),
    },
  },
});

const answerBody = z.object({
  selected_option: z
    .string()
    .regex(/^[A-D]$/)
    .nullable(),
  note: z.string().max(10_000).nullable(),
  state: z.enum(["draft", "queued"]),
});
const syncBody = z.object({
  instance_id: z.string().min(1).max(200),
  workspace: z.object({ name: z.string().min(1).max(200), path: z.string().min(1).max(1000) }).optional(),
  sessions: z
    .array(
      z.object({
        provider: z.enum(PROVIDERS),
        session_id: z.string().min(1).max(512),
        active_round_id: z.string().uuid().optional(),
        accepting: z.boolean().optional(),
      }),
    )
    .max(200),
  acknowledgements: z
    .array(
      z.object({
        delivery_id: z.string().uuid(),
        status: z.enum(["submitted-to-terminal", "failed"]),
        failure_message: z.string().max(500).optional(),
      }),
    )
    .max(200),
});

async function handle(request: Request, path: string, method: string): Promise<Response> {
  if (path === "access" && method === "POST") {
    const parsed = z.object({ code: z.string() }).safeParse(await readJson(request));
    if (!(await takeAccessAttempt())) return problem(429, "too_many_attempts", "Too many attempts. Retry later");
    if (!parsed.success || !validCode(parsed.data.code))
      return problem(401, "invalid_access_code", "That access code is not valid.");
    await resetAccessAttempts();
    return json({ ok: true }, 200, { "Set-Cookie": makeAccessCookie(request) });
  }
  if (path === "logout" && method === "POST") return json({ ok: true }, 200, { "Set-Cookie": clearAccessCookie() });

  const machineOnly =
    path.startsWith("publications/") || path === "publications/prepare" || path === "aboard/sync" || path === "pi/sync";
  const bearer = await authenticateBearer(request);
  if (bearer === "limited") return problem(429, "too_many_attempts", "Too many attempts. Retry later");
  const machine = bearer === "authorized";
  if ((machineOnly && !machine) || (!machineOnly && !machine && !authenticateBrowser(request))) {
    return problem(401, "unauthorized", "Access is required.");
  }

  if (path === "sessions" && method === "GET") return listSessions();
  if (path === "capabilities" && method === "GET")
    return json({ schema_version: 1, providers: PROVIDERS, pi_relay: 1, video_assets: 1 });

  const sessionMatch = /^sessions\/([^/]+)\/(.+)$/u.exec(path);
  if (sessionMatch && method === "GET")
    return readSession(decodeURIComponent(sessionMatch[1] ?? ""), decodeURIComponent(sessionMatch[2] ?? ""));
  if (sessionMatch && method === "DELETE")
    return deleteSession(decodeURIComponent(sessionMatch[1] ?? ""), decodeURIComponent(sessionMatch[2] ?? ""));
  const finishMatch = /^sessions\/([^/]+)\/(.+)\/(finish|restore)$/u.exec(path);
  if (finishMatch && method === "POST")
    return setSessionFinished(
      decodeURIComponent(finishMatch[1] ?? ""),
      decodeURIComponent(finishMatch[2] ?? ""),
      finishMatch[3] === "finish",
    );

  const roundMatch = /^rounds\/([0-9a-f-]+)$/u.exec(path);
  if (roundMatch && method === "GET") {
    const round = await getRound(roundMatch[1] ?? "");
    return round ? json({ round }) : problem(404, "round_not_found", "Round not found.");
  }

  const sceneMatch =
    /^rounds\/([0-9a-f-]+)\/scenes(?:\/(Q[1-9][0-9]*)\/([A-Za-z][A-Za-z0-9_-]{0,63})(\/image)?)?$/u.exec(path);
  if (
    sceneMatch &&
    ((method === "GET" && !sceneMatch[2]) ||
      (method === "PUT" && !!sceneMatch[2] && !sceneMatch[4]) ||
      (method === "POST" && !!sceneMatch[4]))
  )
    return diagramOperation(request, sceneMatch[1]!, sceneMatch[2], sceneMatch[3], !!sceneMatch[4]);
  const snapshotMatch = /^prompt-snapshots\/([0-9a-f-]+)$/u.exec(path);
  if (snapshotMatch && method === "GET") {
    const { data, error } = await supabaseAdmin
      .from("grill_prompt_snapshots")
      .select("id,round_id,prompt,reason,created_at,images,diagram_revisions")
      .eq("id", snapshotMatch[1]!)
      .maybeSingle();
    return !error && data ? json({ snapshot: data }) : problem(404, "snapshot_not_found", "Prompt snapshot not found.");
  }

  const assetMatch = /^assets\/([0-9a-f-]+)$/u.exec(path);
  if (assetMatch && (method === "GET" || method === "HEAD")) return serveAsset(assetMatch[1] ?? "", method);

  if (path === "publications/prepare" && method === "POST") return preparePublication(request);
  const publicationMatch = /^publications\/([0-9a-f-]+)(?:\/(commit))?$/u.exec(path);
  if (publicationMatch && method === "GET" && !publicationMatch[2]) return publicationStatus(publicationMatch[1] ?? "");
  if (publicationMatch && method === "POST" && publicationMatch[2] === "commit")
    return commitPublication(request, publicationMatch[1] ?? "");

  const answerMatch = /^rounds\/([0-9a-f-]+)\/answers\/(Q[1-9][0-9]*|Notes)$/u.exec(path);
  if (answerMatch && method === "PUT") return saveAnswer(request, answerMatch[1] ?? "", answerMatch[2] ?? "");

  const promptMatch = /^rounds\/([0-9a-f-]+)\/(prompt-preview|prompt-snapshots)$/u.exec(path);
  if (promptMatch && method === "POST") return promptOperation(request, promptMatch[1] ?? "", promptMatch[2] ?? "");

  const deliveryMatch = /^prompt-snapshots\/([0-9a-f-]+)\/deliveries$/u.exec(path);
  if (deliveryMatch && method === "POST") return createDelivery(deliveryMatch[1] ?? "", request);
  const deliveryStatusMatch = /^deliveries\/([0-9a-f-]+)$/u.exec(path);
  if (deliveryStatusMatch && method === "GET") return deliveryStatus(deliveryStatusMatch[1] ?? "");

  if (path === "aboard/sync" && method === "POST") return syncAboard(request);
  if (path === "pi/sync" && method === "POST") return syncAboard(request, true);
  return problem(404, "not_found", "Endpoint not found.");
}

async function listSessions(): Promise<Response> {
  const { data, error } = await supabaseAdmin
    .from("grill_sessions")
    .select(
      "id,provider,provider_session_id,display_title,project_name,project_path,last_activity_at,finished_at,expires_at,grill_rounds(id,number,status,payload,grill_answer_drafts(question_id,state))",
    )
    .eq("grill_rounds.status", "active")
    .order("last_activity_at", { ascending: false });
  if (error) return problem(500, "database_error", "Sessions could not be loaded.");
  const cutoff = new Date(Date.now() - 15_000).toISOString();
  const { data: presence } = await supabaseAdmin
    .from("grill_aboard_presence")
    .select("provider,provider_session_id,workspace_name,workspace_path,last_heartbeat_at")
    .gte("last_heartbeat_at", cutoff);
  const presenceMap = new Map((presence ?? []).map((item) => [`${item.provider}:${item.provider_session_id}`, item]));
  const sessions = (data ?? []).map((session) => {
    const rounds = session.grill_rounds as Array<{
      id: string;
      number: number;
      status: string;
      payload: { questions?: Array<{ id: string }> };
      grill_answer_drafts: Array<{ question_id: string; state: string }>;
    }>;
    const active = rounds.find((round) => round.status === "active");
    return {
      id: session.id,
      provider: session.provider,
      provider_session_id: session.provider_session_id,
      display_title: session.display_title,
      project_name: session.project_name,
      project_path: session.project_path,
      last_activity_at: session.last_activity_at,
      finished_at: session.finished_at,
      expires_at: session.expires_at,
      active_round_id: active?.id ?? null,
      active_round_number: active?.number ?? null,
      answered_count:
        active?.grill_answer_drafts.filter(
          (answer) =>
            answer.state === "queued" &&
            active.payload.questions?.some((question) => question.id === answer.question_id),
        ).length ?? 0,
      question_count: active?.payload.questions?.length ?? 0,
      aboard: presenceMap.get(`${session.provider}:${session.provider_session_id}`) ?? null,
    };
  });
  return json({ sessions });
}

async function readSession(provider: string, sessionId: string): Promise<Response> {
  if (!(PROVIDERS as readonly string[]).includes(provider))
    return problem(404, "session_not_found", "Session not found.");
  const { data: session, error } = await supabaseAdmin
    .from("grill_sessions")
    .select("*")
    .eq("provider", provider)
    .eq("provider_session_id", sessionId)
    .maybeSingle();
  if (error || !session) return problem(404, "session_not_found", "Session not found.");
  const { data: rounds } = await supabaseAdmin
    .from("grill_rounds")
    .select("id,number,status,created_at")
    .eq("session_id", session.id)
    .order("number", { ascending: false });
  const cutoff = new Date(Date.now() - 15_000).toISOString();
  const { data: presence } = await supabaseAdmin
    .from("grill_aboard_presence")
    .select("instance_id,workspace_name,workspace_path,last_heartbeat_at")
    .eq("provider", provider)
    .eq("provider_session_id", sessionId)
    .gte("last_heartbeat_at", cutoff)
    .order("last_heartbeat_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return json({ session, rounds: rounds ?? [], aboard: presence ?? null });
}

async function setSessionFinished(provider: string, sessionId: string, finished: boolean): Promise<Response> {
  if (!(PROVIDERS as readonly string[]).includes(provider))
    return problem(404, "session_not_found", "Session not found.");
  const { data: session, error } = await supabaseAdmin
    .from("grill_sessions")
    .select("id,finished_at")
    .eq("provider", provider)
    .eq("provider_session_id", sessionId)
    .maybeSingle();
  if (error || !session) return problem(404, "session_not_found", "Session not found.");
  if (Boolean(session.finished_at) === finished) return json({ ok: true });
  const { error: updateError } = await supabaseAdmin.rpc("grill_set_session_finished", {
    target_session: session.id,
    is_finished: finished,
  });
  if (updateError) return problem(500, "session_update_failed", "The session could not be updated.");
  return json({ ok: true });
}

async function deleteSession(provider: string, sessionId: string): Promise<Response> {
  if (!(PROVIDERS as readonly string[]).includes(provider))
    return problem(404, "session_not_found", "Session not found.");
  const { data: session, error: sessionError } = await supabaseAdmin
    .from("grill_sessions")
    .select("id")
    .eq("provider", provider)
    .eq("provider_session_id", sessionId)
    .maybeSingle();
  if (sessionError || !session) return problem(404, "session_not_found", "Session not found.");

  const [{ data: rounds, error: roundsError }, { data: publications, error: publicationsError }] = await Promise.all([
    supabaseAdmin.from("grill_rounds").select("id,grill_round_assets(object_path)").eq("session_id", session.id),
    supabaseAdmin
      .from("grill_publications")
      .select("id,asset_manifest")
      .eq("provider", provider)
      .eq("provider_session_id", sessionId),
  ]);
  if (roundsError || publicationsError) return problem(500, "delete_failed", "The session could not be deleted.");

  const objectPaths = new Set<string>();
  for (const round of rounds ?? []) {
    for (const asset of round.grill_round_assets as Array<{ object_path: string }>) objectPaths.add(asset.object_path);
  }
  for (const publication of publications ?? []) {
    for (const asset of publication.asset_manifest as Array<{ object_path?: string }>) {
      if (asset.object_path) objectPaths.add(asset.object_path);
    }
  }
  // Keep all database metadata intact when Storage fails so cleanup can be retried safely.
  if (objectPaths.size) {
    const { error: storageError } = await supabaseAdmin.storage.from(BUCKET).remove([...objectPaths]);
    if (storageError) return problem(500, "delete_failed", "The session's stored assets could not be deleted.");
  }

  // Publications and their committed rounds reference each other, so release the publication side first.
  const { error: unlinkError } = await supabaseAdmin
    .from("grill_publications")
    .update({ committed_round_id: null })
    .eq("provider", provider)
    .eq("provider_session_id", sessionId);
  if (unlinkError) return problem(500, "delete_failed", "The session could not be deleted.");

  const [{ error: presenceError }, { error: deleteError }] = await Promise.all([
    supabaseAdmin.from("grill_aboard_presence").delete().eq("provider", provider).eq("provider_session_id", sessionId),
    supabaseAdmin.from("grill_sessions").delete().eq("id", session.id),
  ]);
  if (presenceError || deleteError) return problem(500, "delete_failed", "The session could not be deleted.");

  const { error: publicationDeleteError } = await supabaseAdmin
    .from("grill_publications")
    .delete()
    .eq("provider", provider)
    .eq("provider_session_id", sessionId);
  if (publicationDeleteError) return problem(500, "delete_failed", "The session could not be fully deleted.");

  return json({ ok: true });
}

async function serveAsset(assetId: string, method: string): Promise<Response> {
  const { data: asset } = await supabaseAdmin
    .from("grill_round_assets")
    .select("object_path,media_type,sha256")
    .eq("id", assetId)
    .maybeSingle();
  if (!asset) return problem(404, "asset_not_found", "Asset not found.");
  return assetResponse(asset, supabaseAdmin.storage.from(BUCKET), method);
}

async function preparePublication(request: Request): Promise<Response> {
  const key = request.headers.get("idempotency-key")?.trim();
  if (!key || key.length > 200)
    return problem(400, "missing_idempotency_key", "A valid Idempotency-Key header is required.");
  const checked = validatePublication(await readJson(request));
  if (!checked.success)
    return problem(422, "invalid_payload", "The publication payload is invalid.", checked.error.flatten());
  const input = checked.data;
  const contentFingerprint = fingerprint(input);
  const { data: existing } = await supabaseAdmin
    .from("grill_publications")
    .select("*")
    .eq("provider", input.provider)
    .eq("provider_session_id", input.session_id)
    .eq("idempotency_key", key)
    .maybeSingle();
  if (existing) {
    if (existing.content_fingerprint !== contentFingerprint)
      return problem(409, "idempotency_conflict", "This key was already used for different content.");
    return publicationResponse(existing);
  }
  const publicationId = randomUUID();
  const sessionHash = createHash("sha256").update(`${input.provider}:${input.session_id}`).digest("hex").slice(0, 24);
  const manifest = input.assets.map((asset) => ({
    ...asset,
    id: randomUUID(),
    object_path: `${sessionHash}/${publicationId}/${asset.sha256}`,
  }));
  const { data: publication, error } = await supabaseAdmin
    .from("grill_publications")
    .insert({
      id: publicationId,
      provider: input.provider,
      provider_session_id: input.session_id,
      idempotency_key: key,
      content_fingerprint: contentFingerprint,
      schema_version: input.schema_version,
      original_payload: { title: input.title, project: input.project, payload: input.payload },
      asset_manifest: manifest,
      status: manifest.length ? "uploading" : "prepared",
    })
    .select("*")
    .single();
  if (error) {
    const { data: raced } = await supabaseAdmin
      .from("grill_publications")
      .select("*")
      .eq("provider", input.provider)
      .eq("provider_session_id", input.session_id)
      .eq("idempotency_key", key)
      .maybeSingle();
    if (!raced) return problem(500, "prepare_failed", "The publication could not be prepared.");
    if (raced.content_fingerprint !== contentFingerprint)
      return problem(409, "idempotency_conflict", "This key was already used for different content.");
    return publicationResponse(raced);
  }
  return publicationResponse(publication);
}

/** The hook decodes HTML entities while discovering assets, so the stored markup may still encode them. */
function referenceVariants(reference: string): string[] {
  if (!reference.includes("&")) return [reference];
  return [reference, ...["&amp;", "&#38;", "&#x26;"].map((entity) => reference.split("&").join(entity))];
}

function isDuplicateObject(error: unknown): boolean {
  const detail = error as { statusCode?: string | number; status?: number; error?: string; message?: string };
  return (
    String(detail.statusCode ?? detail.status ?? "") === "409" ||
    detail.error === "Duplicate" ||
    /already exists/iu.test(detail.message ?? "")
  );
}

async function publicationResponse(publication: Record<string, unknown>): Promise<Response> {
  const targets = [];
  if (publication["status"] !== "committed") {
    for (const item of publication["asset_manifest"] as Array<{ reference: string; object_path: string }>) {
      const { data, error } = await supabaseAdmin.storage
        .from(BUCKET)
        .createSignedUploadUrl(item.object_path, { upsert: false });
      // A retry re-signs immutable object names; an existing object is already durable, so omit its target.
      if (error && isDuplicateObject(error)) continue;
      if (error || !data) return problem(500, "upload_target_failed", "Upload targets could not be created.");
      targets.push({
        reference: item.reference,
        path: item.object_path,
        token: data.token,
        signed_url: data.signedUrl,
      });
    }
  }
  return json({ publication: { id: publication["id"], status: publication["status"] }, upload_targets: targets });
}

async function publicationStatus(id: string): Promise<Response> {
  const { data } = await supabaseAdmin
    .from("grill_publications")
    .select("id,status,provider,provider_session_id,committed_round_id,created_at,updated_at")
    .eq("id", id)
    .maybeSingle();
  return data ? json({ publication: data }) : problem(404, "publication_not_found", "Publication not found.");
}

async function commitPublication(request: Request, id: string): Promise<Response> {
  const key = request.headers.get("idempotency-key")?.trim();
  const { data: publication } = await supabaseAdmin.from("grill_publications").select("*").eq("id", id).maybeSingle();
  if (!publication) return problem(404, "publication_not_found", "Publication not found.");
  if (!key || key !== publication.idempotency_key)
    return problem(409, "idempotency_conflict", "The publication key does not match.");
  const requestOrigin = new URL(request.url).origin;
  if (publication.status === "committed") return committedResponse(publication, requestOrigin);
  if (!(["prepared", "uploading"] as string[]).includes(publication.status))
    return problem(409, "publication_not_committable", "The publication cannot be committed.");
  const manifest = publication.asset_manifest as Array<{
    id: string;
    reference: string;
    object_path: string;
    media_type: string;
    byte_size: number;
    sha256: string;
  }>;
  const verified = [];
  for (const item of manifest) {
    const { data: blob, error } = await supabaseAdmin.storage.from(BUCKET).download(item.object_path);
    if (error || !blob) return problem(422, "missing_asset", `Missing upload for ${item.reference}.`);
    if (blob.size !== item.byte_size)
      return problem(422, "asset_size_mismatch", `Size mismatch for ${item.reference}.`);
    const bytes = Buffer.from(await blob.arrayBuffer());
    if (!mediaMatches(bytes, item.media_type))
      return problem(422, "unsupported_asset", `Media type mismatch for ${item.reference}.`);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest.toLowerCase() !== item.sha256.toLowerCase())
      return problem(422, "asset_hash_mismatch", `Checksum mismatch for ${item.reference}.`);
    verified.push({
      id: item.id,
      original_reference: item.reference,
      object_path: item.object_path,
      media_type: item.media_type,
      byte_size: item.byte_size,
      sha256: digest,
    });
  }
  const original = publication.original_payload as {
    title?: string;
    project?: { name: string; path: string };
    payload: { questions: Array<{ explanation_html: string }> };
  };
  const rewritten = structuredClone(original.payload);
  const rewrites = [...manifest]
    .sort((left, right) => right.reference.length - left.reference.length)
    .flatMap((item) =>
      referenceVariants(item.reference).map((variant) => ({ variant, target: `/api/v1/assets/${item.id}` })),
    );
  for (const question of rewritten.questions) {
    for (const rewrite of rewrites)
      question.explanation_html = question.explanation_html.split(rewrite.variant).join(rewrite.target);
  }
  const { data, error } = await supabaseAdmin.rpc("grill_commit_publication", {
    target_publication: publication.id,
    target_title: original.title ?? "",
    rewritten_payload: rewritten,
    assets: verified,
  });
  if (error || !data?.[0]) return problem(500, "commit_failed", "The round could not be committed.");
  return json({
    provider: publication.provider,
    session_id: publication.provider_session_id,
    round_id: data[0].round_id,
    round_number: data[0].round_number,
    url: canonicalSessionUrl(publication.provider, publication.provider_session_id, requestOrigin),
  });
}

async function committedResponse(
  publication: {
    provider: string;
    provider_session_id: string;
    committed_round_id: string | null;
  },
  requestOrigin: string,
): Promise<Response> {
  const { data: round } = await supabaseAdmin
    .from("grill_rounds")
    .select("id,number")
    .eq("id", publication.committed_round_id ?? "")
    .maybeSingle();
  return json({
    provider: publication.provider,
    session_id: publication.provider_session_id,
    round_id: round?.id,
    round_number: round?.number,
    url: canonicalSessionUrl(publication.provider, publication.provider_session_id, requestOrigin),
  });
}

async function saveAnswer(request: Request, roundId: string, questionId: string): Promise<Response> {
  const parsed = answerBody.safeParse(await readJson(request));
  if (!parsed.success) return problem(422, "invalid_answer", "The answer is invalid.");
  // The board autosaves every edit, so this reads only what validation needs rather than the whole round.
  const { data: round } = await supabaseAdmin
    .from("grill_rounds")
    .select("status,payload,session_id")
    .eq("id", roundId)
    .maybeSingle();
  if (!round) return problem(404, "round_not_found", "Round not found.");
  if (round.status !== "active") return problem(409, "stale_round", "Historical rounds are read-only.");
  const question = (
    round.payload as { questions: Array<{ id: string; options: Array<{ letter: string }> }> }
  ).questions.find((item) => item.id === questionId);
  if (questionId !== NOTES_ID && !question) return problem(404, "question_not_found", "Question not found.");
  if (questionId === NOTES_ID && parsed.data.selected_option !== null)
    return problem(422, "invalid_answer", "Round notes cannot select an option.");
  if (parsed.data.selected_option && !question?.options.some((option) => option.letter === parsed.data.selected_option))
    return problem(422, "invalid_answer", "The selected option is unavailable.");
  const empty = !parsed.data.selected_option && !parsed.data.note?.trim();
  let answer = null;
  if (parsed.data.state === "queued" && empty) {
    await supabaseAdmin.from("grill_answer_drafts").delete().eq("round_id", roundId).eq("question_id", questionId);
  } else {
    const { data, error } = await supabaseAdmin
      .from("grill_answer_drafts")
      .upsert(
        {
          round_id: roundId,
          question_id: questionId,
          ...parsed.data,
          // Stored as typed so an echo never trims text mid-edit; the prompt compiler trims instead.
          note: parsed.data.note?.trim() ? parsed.data.note : null,
          queued_at: parsed.data.state === "queued" ? new Date().toISOString() : null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "round_id,question_id" },
      )
      .select("question_id,selected_option,note,state,updated_at,queued_at")
      .single();
    if (error) return problem(500, "save_failed", "The answer could not be saved.");
    answer = data;
  }
  await touchSession(round.session_id as string);
  return json({ ok: true, state: empty ? "unanswered" : parsed.data.state, answer });
}

async function promptOperation(request: Request, roundId: string, operation: string): Promise<Response> {
  const input = operation === "prompt-preview" ? {} : await readJson(request);
  const proposed = (input as { snapshot_id?: unknown } | undefined)?.snapshot_id;
  if (proposed !== undefined && !z.string().uuid().safeParse(proposed).success)
    return problem(422, "invalid_snapshot", "Snapshot identity must be a UUID.");
  const snapshotId = typeof proposed === "string" ? proposed : randomUUID();
  let result: Awaited<ReturnType<typeof promptForRound>>;
  try {
    result = await promptForRound(roundId);
  } catch (cause) {
    return problem(
      409,
      "diagram_review_unavailable",
      cause instanceof Error ? cause.message : "Diagram review is unavailable. Retry review.",
    );
  }
  if (!result) return problem(404, "round_not_found", "Round not found.");
  if (result.missingImages)
    return problem(409, "diagram_export_required", "A changed diagram needs its saved image. Retry review.");
  if (operation === "prompt-preview") {
    // Freeze reviewed image references before displaying the prompt, including history copies.
    if (result.images.length) {
      const { data, error } = await supabaseAdmin.rpc("grill_snapshot_diagrams", {
        target_round: roundId,
        target_prompt: result.prompt,
        target_reason: "copy",
        expected_revisions: result.diagramRevisions,
        target_images: result.images,
        target_snapshot: snapshotId,
      });
      if (error || !data?.[0])
        return problem(409, "snapshot_failed", "The diagram changed during review. Retry review.");
    }
    return json({ snapshot_id: snapshotId, prompt: result.prompt, diagram_revisions: result.diagramRevisions });
  }
  if (result.round.status !== "active") return problem(409, "stale_round", "Historical rounds are read-only.");
  const parsed = z
    .object({
      reason: z.enum(["copy", "aboard"]),
      expected_prompt: z.string().max(100_000),
      expected_diagram_revisions: z.record(z.string()).optional(),
    })
    .safeParse(input);
  if (!parsed.success) return problem(422, "invalid_snapshot_reason", "Snapshot reason must be copy or aboard.");
  if (!result.prompt) return problem(422, "empty_prompt", "Answer a question or add notes first.");
  if (parsed.data.expected_prompt !== result.prompt)
    return problem(409, "stale_prompt", "The answers changed. Review the regenerated prompt before continuing.");
  if (
    Object.keys(result.diagramRevisions).length &&
    fingerprint(Object.entries(parsed.data.expected_diagram_revisions ?? {}).sort()) !==
      fingerprint(Object.entries(result.diagramRevisions).sort())
  )
    return problem(409, "stale_diagrams", "The drawings changed. Review them again before continuing.");
  const { data, error } = await supabaseAdmin.rpc("grill_snapshot_diagrams", {
    target_round: roundId,
    target_prompt: result.prompt,
    target_reason: parsed.data.reason,
    expected_revisions: result.diagramRevisions,
    target_images: result.images,
    target_snapshot: snapshotId,
  });
  if (error || !data?.[0])
    return problem(
      409,
      "snapshot_failed",
      "The diagram changed or the prompt snapshot could not be created. Review again and retry.",
    );
  await touchSession(result.round.session_id as string);
  return json({ snapshot: data[0] });
}

async function createDelivery(snapshotId: string, request: Request): Promise<Response> {
  const parsed = z.object({ delivery_id: z.string().uuid().optional() }).safeParse(await readJson(request));
  if (!parsed.success) return problem(422, "invalid_delivery", "Invalid delivery identity.");
  const deliveryId = parsed.data.delivery_id ?? randomUUID();
  const { data: snapshot } = await supabaseAdmin
    .from("grill_prompt_snapshots")
    .select(
      "id,reason,round_id,grill_rounds!inner(session_id,status,grill_sessions!inner(provider,provider_session_id))",
    )
    .eq("id", snapshotId)
    .maybeSingle();
  if (!snapshot) return problem(404, "snapshot_not_found", "Prompt snapshot not found.");
  const round = snapshot.grill_rounds as unknown as {
    session_id: string;
    status: string;
    grill_sessions: { provider: string; provider_session_id: string };
  };
  if (round.status !== "active") return problem(409, "stale_round", "Historical rounds cannot create deliveries.");
  const cutoff = new Date(Date.now() - 15_000).toISOString();
  const { data: presence } = await supabaseAdmin
    .from("grill_aboard_presence")
    .select("instance_id")
    .eq("provider", round.grill_sessions.provider)
    .eq("provider_session_id", round.grill_sessions.provider_session_id)
    .gte("last_heartbeat_at", cutoff)
    .limit(1)
    .maybeSingle();
  if (!presence) return problem(409, "aboard_unavailable", "The answer relay is not connected to this exact session.");
  // A gesture owns a delivery identity; retries reuse it, deliberate resends get a new identity.
  const { data: existing } = await supabaseAdmin
    .from("grill_deliveries")
    .select("*")
    .eq("id", deliveryId)
    .eq("prompt_snapshot_id", snapshotId)
    .maybeSingle();
  if (existing) return json({ delivery: existing });
  const { data, error } = await supabaseAdmin
    .from("grill_deliveries")
    .insert({
      id: deliveryId,
      prompt_snapshot_id: snapshotId,
      provider: round.grill_sessions.provider,
      provider_session_id: round.grill_sessions.provider_session_id,
    })
    .select("*")
    .single();
  if (error) {
    const { data: raced } = await supabaseAdmin
      .from("grill_deliveries")
      .select("*")
      .eq("id", deliveryId)
      .eq("prompt_snapshot_id", snapshotId)
      .maybeSingle();
    if (raced) return json({ delivery: raced });
    const { data: active } = await supabaseAdmin
      .from("grill_deliveries")
      .select("*")
      .eq("prompt_snapshot_id", snapshotId)
      .in("status", ["pending", "claimed"])
      .maybeSingle();
    return active ? json({ delivery: active }) : problem(500, "delivery_failed", "The delivery could not be created.");
  }
  await touchSession(round.session_id);
  return json({ delivery: data }, 201);
}

async function deliveryStatus(id: string): Promise<Response> {
  const { data } = await supabaseAdmin
    .from("grill_deliveries")
    .select("id,status,failure_message")
    .eq("id", id)
    .maybeSingle();
  return data ? json({ delivery: data }) : problem(404, "delivery_not_found", "Delivery not found.");
}

async function syncAboard(request: Request, piRelay = false): Promise<Response> {
  const parsed = syncBody.safeParse(await readJson(request));
  if (!parsed.success)
    return problem(422, "invalid_sync", "The Aboard sync payload is invalid.", parsed.error.flatten());
  const input = parsed.data;
  if (
    piRelay &&
    input.sessions.some(
      (session) => session.provider !== "pi" || !session.active_round_id || session.accepting === undefined,
    )
  )
    return problem(422, "invalid_sync", "Pi presence requires the exact active round and acceptance state.");
  const now = new Date().toISOString();
  await supabaseAdmin
    .from("grill_deliveries")
    .update({ status: "expired", completed_at: now })
    .in("status", ["pending", "claimed"])
    .lte("expires_at", now);
  // Refresh before pruning so an eligible session is never briefly absent between two syncs.
  if (input.sessions.length) {
    const { error } = await supabaseAdmin.from("grill_aboard_presence").upsert(
      input.sessions.map((session) => ({
        instance_id: input.instance_id,
        provider: session.provider,
        provider_session_id: session.session_id,
        workspace_name: input.workspace?.name ?? null,
        workspace_path: input.workspace?.path ?? null,
        last_heartbeat_at: now,
      })),
      { onConflict: "instance_id,provider,provider_session_id" },
    );
    if (error) return problem(500, "presence_failed", "Aboard presence could not be updated.");
  }
  await supabaseAdmin
    .from("grill_aboard_presence")
    .delete()
    .eq("instance_id", input.instance_id)
    .lt("last_heartbeat_at", now);
  for (const acknowledgement of input.acknowledgements) {
    const { data: delivery } = await supabaseAdmin
      .from("grill_deliveries")
      .select("id,status,target_instance_id,provider,provider_session_id")
      .eq("id", acknowledgement.delivery_id)
      .maybeSingle();
    if (!delivery || delivery.target_instance_id !== input.instance_id) continue;
    if (
      delivery.status === "claimed" ||
      (piRelay &&
        delivery.provider === "pi" &&
        delivery.status === "expired" &&
        acknowledgement.status === "submitted-to-terminal")
    ) {
      const { error: acknowledgementError } = await supabaseAdmin
        .from("grill_deliveries")
        .update({
          status: acknowledgement.status,
          failure_message:
            acknowledgement.status === "failed"
              ? (acknowledgement.failure_message ?? "Terminal submission failed")
              : null,
          completed_at: now,
        })
        .eq("id", delivery.id)
        .eq("target_instance_id", input.instance_id)
        .eq("status", delivery.status);
      if (acknowledgementError)
        return problem(500, "acknowledgement_failed", "The confirmed delivery could not be recorded.");
      const { data: session } = await supabaseAdmin
        .from("grill_sessions")
        .select("id")
        .eq("provider", delivery.provider)
        .eq("provider_session_id", delivery.provider_session_id)
        .maybeSingle();
      if (session) await touchSession(session.id);
    }
  }
  const { data, error } = await supabaseAdmin.rpc("grill_claim_deliveries", {
    target_instance: input.instance_id,
    target_sessions: input.sessions,
    target_native_pi: piRelay,
  });
  if (error) return problem(500, "delivery_claim_failed", "Pending deliveries could not be claimed.");
  const deliveries = await Promise.all(
    (data ?? []).map(
      async (delivery: { delivery_id: string; provider: string; session_id: string; prompt: string }) => {
        const { data: row } = await supabaseAdmin
          .from("grill_deliveries")
          .select("prompt_snapshot_id,expires_at,grill_prompt_snapshots(images,diagram_revisions)")
          .eq("id", delivery.delivery_id)
          .single();
        const snapshot = row?.grill_prompt_snapshots as unknown as
          | { images: unknown[]; diagram_revisions: unknown }
          | undefined;
        return {
          ...delivery,
          snapshot_id: row?.prompt_snapshot_id,
          expires_at: row?.expires_at,
          images: snapshot?.images ?? [],
          diagram_revisions: snapshot?.diagram_revisions ?? {},
        };
      },
    ),
  );
  return json({ deliveries });
}
