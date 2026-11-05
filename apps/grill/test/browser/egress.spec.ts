import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";

const local = JSON.parse(execSync("npx supabase status -o json", { encoding: "utf8" }));
if (!new URL(local.API_URL).hostname.match(/^(127\.0\.0\.1|localhost)$/))
  throw new Error("Egress acceptance requires local Supabase");
const database = createClient(local.API_URL, local.SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

test("large rounds and snapshot history do not grow idle polling, summaries or cached updates", async ({ request }) => {
  const session = `egress-${randomUUID()}`;
  const instance = randomUUID();
  const headers = { Authorization: "Bearer 1234" };
  const changes = async () => {
    const response = await request.get("/api/v1/changes", { headers });
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json();
  };
  const initial = await changes();
  try {
    const key = randomUUID();
    const prepared = await request.post("/api/v1/publications/prepare", {
      headers: { ...headers, "Idempotency-Key": key },
      data: {
        provider: "chatgpt",
        session_id: session,
        schema_version: 1,
        payload: {
          questions: [
            {
              id: "Q1",
              question: "A large explanation",
              explanation_html: `<p>${"Context. ".repeat(40_000)}</p>`,
              recommendation: "A",
              options: [{ letter: "A", label: "Continue", detail: "Proceed" }],
            },
          ],
        },
      },
    });
    expect(prepared.ok(), await prepared.text()).toBeTruthy();
    const committed = await request.post(`/api/v1/publications/${(await prepared.json()).publication.id}/commit`, {
      headers: { ...headers, "Idempotency-Key": key },
      data: {},
    });
    expect(committed.ok(), await committed.text()).toBeTruthy();
    const roundId = (await committed.json()).round_id;
    const published = await changes();
    expect(published.content).not.toBe(initial.content);

    const full = await request.get(`/api/v1/rounds/${roundId}`, { headers });
    expect((await full.body()).byteLength).toBeGreaterThan(300_000);
    const metadata = await database.from("grill_round_answer_options").select("*").eq("id", roundId).single();
    expect(metadata.error).toBeNull();
    expect(Buffer.byteLength(JSON.stringify(metadata.data))).toBeLessThan(400);

    const saved = await request.put(`/api/v1/rounds/${roundId}/answers/Q1`, {
      headers,
      data: { selected_option: "A", note: "Saved across devices", state: "queued" },
    });
    expect(saved.ok()).toBeTruthy();
    const answered = await changes();
    expect(answered.content).not.toBe(published.content);
    const notes = await request.put(`/api/v1/rounds/${roundId}/answers/Notes`, {
      headers,
      data: { selected_option: null, note: "Separate round notes", state: "queued" },
    });
    expect(notes.ok()).toBeTruthy();

    const history = await database
      .from("grill_prompt_snapshots")
      .insert(Array.from({ length: 50 }, () => ({ round_id: roundId, prompt: "x".repeat(20_000), reason: "copy" })));
    expect(history.error).toBeNull();
    const cached = await request.get(`/api/v1/rounds/${roundId}`, {
      headers: { ...headers, "X-Grill-Content": "cached" },
    });
    expect(cached.ok(), await cached.text()).toBeTruthy();
    expect((await cached.body()).byteLength).toBeLessThan(1_200);
    const cachedRound = (await cached.json()).round;
    expect(cachedRound.payload).toBeUndefined();
    expect(cachedRound.answers).toHaveLength(2);
    expect(cachedRound.prompt_snapshots).toEqual([]);

    const snapshot = await database
      .from("grill_prompt_snapshots")
      .select("id")
      .eq("round_id", roundId)
      .limit(1)
      .single();
    expect(snapshot.error).toBeNull();
    const delivered = await database.from("grill_deliveries").insert({
      prompt_snapshot_id: snapshot.data!.id,
      provider: "chatgpt",
      provider_session_id: session,
      status: "submitted-to-terminal",
    });
    expect(delivered.error).toBeNull();
    const sent = await request.get(`/api/v1/rounds/${roundId}`, {
      headers: { ...headers, "X-Grill-Content": "cached" },
    });
    expect((await sent.body()).byteLength).toBeLessThan(1_200);
    expect((await sent.json()).round.prompt_snapshots).toHaveLength(1);

    // Measure the database response itself, not just the smaller Vercel API result.
    const summary = await database
      .from("grill_session_summaries")
      .select("*")
      .eq("provider_session_id", session)
      .single();
    expect(summary.error).toBeNull();
    expect(Buffer.byteLength(JSON.stringify(summary.data))).toBeLessThan(800);
    expect(summary.data.question_count).toBe(1);
    expect(summary.data.answered_count).toBe(1);
    const list = await request.get("/api/v1/sessions", { headers }).then((response) => response.json());
    expect(
      list.sessions.find((item: { provider_session_id: string }) => item.provider_session_id === session)
        .answered_count,
    ).toBe(1);

    const beforeHeartbeat = await changes();
    const heartbeat = {
      instance_id: instance,
      sessions: [{ provider: "chatgpt", session_id: session }],
      acknowledgements: [],
    };
    const sync = () => request.post("/api/v1/aboard/sync", { headers, data: heartbeat });
    expect((await sync()).ok()).toBeTruthy();
    const online = await changes();
    expect(online.content).toBe(beforeHeartbeat.content);
    expect(online.presence).not.toBe(beforeHeartbeat.presence);
    expect((await sync()).ok()).toBeTruthy();
    expect(await changes()).toEqual(online);

    // Response sizes, including HTTP headers, leave a monthly budget for active work and assets.
    let idleWireBytes = 0;
    for (const [path, body] of [
      ["grill_board_changes", {}],
      ["grill_sync", { target_input: heartbeat, target_native_pi: false }],
    ] as const) {
      const response = await fetch(`${local.API_URL}/rest/v1/rpc/${path}`, {
        method: "POST",
        headers: {
          apikey: local.SERVICE_ROLE_KEY,
          Authorization: `Bearer ${local.SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      expect(response.ok).toBeTruthy();
      const bytes = Buffer.byteLength(await response.text());
      expect(bytes).toBeLessThan(128);
      idleWireBytes +=
        bytes + Buffer.byteLength([...response.headers].map(([name, value]) => `${name}: ${value}\r\n`).join("")) + 32;
    }
    // One visible board and one native relay at two-second intervals, continuously for 30 days.
    const monthlyIdleBytes = idleWireBytes * ((30 * 24 * 60 * 60) / 2);
    expect(monthlyIdleBytes).toBeLessThan(2_000_000_000);
    console.log(
      `Continuous board + relay: ${(monthlyIdleBytes / 1e9).toFixed(2)} GB/month of local HTTP responses including headers`,
    );

    const offline = await database
      .from("grill_aboard_presence")
      .update({ last_heartbeat_at: new Date(Date.now() - 60_000).toISOString() })
      .eq("instance_id", instance);
    expect(offline.error).toBeNull();
    const expiredPresence = await changes();
    expect(expiredPresence.content).toBe(online.content);
    expect(expiredPresence.presence).not.toBe(online.presence);
    expect((await request.delete(`/api/v1/sessions/chatgpt/${session}`, { headers })).ok()).toBeTruthy();
    expect((await changes()).content).not.toBe(expiredPresence.content);
  } finally {
    await request.delete(`/api/v1/sessions/chatgpt/${session}`, { headers });
    await database.from("grill_aboard_presence").delete().eq("instance_id", instance);
  }
});
