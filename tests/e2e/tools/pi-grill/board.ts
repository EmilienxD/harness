import { createServer } from "node:http";
import { randomInt, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

/** Hosted transport fault fixture. Real app/database/storage acceptance uses the same journey CLI. */
export async function startGrillBoard() {
  const code = randomInt(10_000).toString().padStart(4, "0");
  const publications = new Map<string, any>();
  const rounds = new Map<string, any>();
  const sessions = new Map<string, any>();
  const snapshots = new Map<string, any>();
  const deliveries = new Map<string, any>();
  const presence = new Map<string, any>();
  const assets = new Map<string, Buffer>();
  let failAck = false;
  let failCommit = false;
  let supported = true;
  let offline = false;
  let origin = "";
  const server = createServer(async (req, res) => {
    const reply = (value: any, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    const path = new URL(req.url ?? "/", origin).pathname;
    if (offline) { reply({ error: { code: "unavailable", message: "Fixture outage" } }, 503); return; }
    if (!path.startsWith("/upload/") && req.headers.authorization !== `Bearer ${code}`) { reply({}, 401); return; }
    const body = bytes.length && !path.startsWith("/upload/") ? JSON.parse(bytes.toString("utf8")) : {};
    if (path === "/api/v1/capabilities") { reply({ providers: supported ? ["claude", "chatgpt", "pi"] : ["claude", "chatgpt"], pi_relay: supported ? 1 : 0 }); return; }
    if (path === "/api/v1/publications/prepare") {
      if (body.provider !== "pi") { reply({}, 422); return; }
      let pub = [...publications.values()].find((entry) => entry.key === req.headers["idempotency-key"]);
      if (!pub) {
        pub = { ...body, id: randomUUID(), key: req.headers["idempotency-key"], status: "prepared",
          asset_ids: body.assets.map(() => randomUUID()) };
        publications.set(pub.id, pub);
      }
      reply({ publication: { id: pub.id, status: pub.status }, upload_targets: pub.assets.map((asset: any, index: number) => ({ reference: asset.reference, signed_url: `${origin}/upload/${pub.asset_ids[index]}` })) }); return;
    }
    if (path.startsWith("/upload/")) { assets.set(path.split("/").at(-1)!, bytes); reply({}); return; }
    if (path.startsWith("/api/v1/assets/")) { const asset = assets.get(path.split("/").at(-1)!); res.writeHead(asset ? 200 : 404, { "Content-Type": "image/svg+xml" }); res.end(asset); return; }
    const commit = /^\/api\/v1\/publications\/([^/]+)\/commit$/.exec(path);
    if (commit) {
      if (failCommit) { reply({ error: { code: "unavailable", message: "Fixture commit outage" } }, 503); return; }
      const pub = publications.get(commit[1]!);
      if (!pub.result) {
        let session = sessions.get(pub.session_id);
        if (!session) { session = { id: randomUUID(), provider: "pi", provider_session_id: pub.session_id, display_title: pub.title, rounds: [] }; sessions.set(pub.session_id, session); }
        for (const old of session.rounds) old.status = "superseded";
        const payload = JSON.parse(JSON.stringify(pub.payload));
        pub.assets.forEach((asset: any, index: number) => {
          if (!assets.has(pub.asset_ids[index])) throw new Error("Fixture commit lacks uploaded asset");
          for (const question of payload.questions) question.explanation_html = question.explanation_html.replaceAll(asset.reference, `/api/v1/assets/${pub.asset_ids[index]}`);
        });
        const round = { id: randomUUID(), number: session.rounds.length + 1, status: "active", payload, answers: [], session_id: session.id };
        rounds.set(round.id, round); session.rounds.push(round);
        pub.status = "committed";
        pub.result = { round_id: round.id, round_number: round.number, url: `${origin}/?session=pi:${pub.session_id}` };
      }
      reply(pub.result); return;
    }
    const sessionMatch = /^\/api\/v1\/sessions\/pi\/(.+)$/.exec(path);
    if (sessionMatch) {
      const session = sessions.get(decodeURIComponent(sessionMatch[1]!));
      if (req.method === "DELETE") { sessions.delete(sessionMatch[1]!); reply({ ok: true }); return; }
      reply(session ? { session, rounds: [...session.rounds].reverse(), aboard: presence.get(session.provider_session_id) ?? null } : {}, session ? 200 : 404); return;
    }
    const answer = /^\/api\/v1\/rounds\/([^/]+)\/answers\/(Q\d+)$/.exec(path);
    if (answer) { const round = rounds.get(answer[1]!); round.answers = round.answers.filter((item: any) => item.question_id !== answer[2]); round.answers.push({ question_id: answer[2], ...body }); reply({ ok: true }); return; }
    const operation = /^\/api\/v1\/rounds\/([^/]+)(?:\/(prompt-preview|prompt-snapshots))?$/.exec(path);
    if (operation) {
      const round = rounds.get(operation[1]!);
      if (!operation[2]) { reply({ round }); return; }
      const prompt = round.answers.filter((answer: any) => answer.state === "queued").map((answer: any) => `- ${answer.question_id}: ${answer.selected_option ?? "None of these"}.${answer.note ? ` ${answer.note}` : ""}`).join("\n");
      if (operation[2] === "prompt-preview") { reply({ prompt }); return; }
      if (body.expected_prompt !== prompt || round.status !== "active") { reply({}, 409); return; }
      const snapshot = { id: randomUUID(), prompt, round: round.id }; snapshots.set(snapshot.id, snapshot); reply({ snapshot }); return;
    }
    const deliver = /^\/api\/v1\/prompt-snapshots\/([^/]+)\/deliveries$/.exec(path);
    if (deliver) {
      const snapshot = snapshots.get(deliver[1]!);
      let delivery = [...deliveries.values()].find((entry) => entry.snapshot === snapshot.id);
      if (!delivery) {
        const round = rounds.get(snapshot.round);
        const session = [...sessions.values()].find((entry) => entry.id === round.session_id);
        delivery = { id: randomUUID(), snapshot: snapshot.id, status: "pending", provider: "pi", session_id: session.provider_session_id, round_id: round.id, prompt: snapshot.prompt };
        deliveries.set(delivery.id, delivery);
      }
      reply({ delivery }); return;
    }
    const status = /^\/api\/v1\/deliveries\/([^/]+)$/.exec(path);
    if (status) { reply({ delivery: deliveries.get(status[1]!) }); return; }
    if (path === "/api/v1/pi/sync" || path === "/api/v1/aboard/sync") {
      if (failAck && body.acknowledgements.length) { reply({}, 503); return; }
      for (const ack of body.acknowledgements) { const delivery = deliveries.get(ack.delivery_id); if (delivery?.owner === body.instance_id) delivery.status = ack.status; }
      for (const session of body.sessions) presence.set(session.session_id, { instance_id: body.instance_id });
      const claimed = [];
      for (const delivery of deliveries.values()) {
        const session = body.sessions.find((entry: any) => entry.session_id === delivery.session_id && entry.provider === delivery.provider);
        if (!session || session.accepting === false || (session.active_round_id && session.active_round_id !== delivery.round_id)) continue;
        if (delivery.status !== "pending" && !(delivery.status === "claimed" && delivery.owner === body.instance_id)) continue;
        delivery.owner = body.instance_id; delivery.status = "claimed";
        claimed.push({ delivery_id: delivery.id, provider: delivery.provider, session_id: delivery.session_id, prompt: delivery.prompt, round_id: delivery.round_id });
      }
      reply({ deliveries: claimed }); return;
    }
    reply({}, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, code, deliveries, setFailAck: (value: boolean) => { failAck = value; }, setFailCommit: (value: boolean) => { failCommit = value; }, setSupported: (value: boolean) => { supported = value; }, setOffline: (value: boolean) => { offline = value; },
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); } };
}
