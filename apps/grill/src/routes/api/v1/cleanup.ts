import { createFileRoute } from "@tanstack/react-router";
import { timingSafeEqual } from "node:crypto";
import { BUCKET, problem } from "@/lib/grill-api.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export const Route = createFileRoute("/api/v1/cleanup")({
  server: {
    handlers: {
      GET: ({ request }) => cleanup(request),
      POST: ({ request }) => cleanup(request),
    },
  },
});

async function cleanup(request: Request): Promise<Response> {
  if (!authorized(request)) return problem(401, "unauthorized", "Cleanup access is required.");
  const now = new Date();
  const nowIso = now.toISOString();
  const publicationCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const presenceCutoff = new Date(now.getTime() - 60 * 60 * 1000).toISOString();

  await supabaseAdmin.from("grill_aboard_presence").delete().lt("last_heartbeat_at", presenceCutoff);
  await supabaseAdmin
    .from("grill_deliveries")
    .update({ status: "expired", completed_at: nowIso })
    .in("status", ["pending", "claimed"])
    .lte("expires_at", nowIso);

  const { data: stalePublications } = await supabaseAdmin
    .from("grill_publications")
    .select("id,asset_manifest")
    .in("status", ["prepared", "uploading", "failed"])
    .lt("created_at", publicationCutoff);
  let removedPublications = 0;
  for (const publication of stalePublications ?? []) {
    const paths = (publication.asset_manifest as Array<{ object_path?: string }>)
      .map((asset) => asset.object_path)
      .filter((path): path is string => Boolean(path));
    if (paths.length) {
      const { error } = await supabaseAdmin.storage.from(BUCKET).remove(paths);
      if (error) continue;
    }
    const { error } = await supabaseAdmin.from("grill_publications").delete().eq("id", publication.id);
    if (!error) removedPublications += 1;
  }

  const { data: expiredSessions } = await supabaseAdmin
    .from("grill_sessions")
    .select("id,provider,provider_session_id")
    .not("finished_at", "is", null)
    .lt("expires_at", nowIso);
  let removed = 0;
  for (const session of expiredSessions ?? []) {
    const { data: rounds } = await supabaseAdmin.from("grill_rounds").select("id").eq("session_id", session.id);
    const roundIds = (rounds ?? []).map((round) => round.id);
    let storageFailed = false;
    if (roundIds.length) {
      const { data: assets } = await supabaseAdmin
        .from("grill_round_assets")
        .select("object_path")
        .in("round_id", roundIds);
      const paths = (assets ?? []).map((asset) => asset.object_path);
      if (paths.length) {
        const { error } = await supabaseAdmin.storage.from(BUCKET).remove(paths);
        storageFailed = Boolean(error);
      }
    }
    if (storageFailed) continue;
    const { data: publications } = await supabaseAdmin
      .from("grill_publications")
      .select("id")
      .eq("provider", session.provider)
      .eq("provider_session_id", session.provider_session_id);
    const publicationIds = (publications ?? []).map((publication) => publication.id);
    if (publicationIds.length)
      await supabaseAdmin.from("grill_publications").update({ committed_round_id: null }).in("id", publicationIds);
    await supabaseAdmin
      .from("grill_aboard_presence")
      .delete()
      .eq("provider", session.provider)
      .eq("provider_session_id", session.provider_session_id);
    const { error } = await supabaseAdmin.from("grill_sessions").delete().eq("id", session.id);
    if (error) continue;
    if (publicationIds.length) await supabaseAdmin.from("grill_publications").delete().in("id", publicationIds);
    removed += 1;
  }
  return Response.json(
    {
      ok: true,
      expired_publications: removedPublications,
      expired_sessions: removed,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

function authorized(request: Request): boolean {
  const expected = process.env["CRON_SECRET"] ?? process.env["HARNESS_GRILL_CLEANUP_SECRET"] ?? "";
  const supplied = /^Bearer ([^\s,]+)$/u.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
  const left = Buffer.from(expected);
  const right = Buffer.from(supplied);
  return left.length > 0 && left.length === right.length && timingSafeEqual(left, right);
}
