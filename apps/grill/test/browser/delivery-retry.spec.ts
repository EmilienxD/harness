import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

for (const provider of ["claude", "chatgpt", "pi"] as const) {
  for (const nativePi of provider === "pi" ? [false, true] : [false]) {
    test(`${provider} ${nativePi ? "native" : "Aboard"} snapshot supports active idempotency, failed retry and intentional resend`, async ({
      request,
    }, info) => {
      test.skip(info.project.name !== "desktop", "API delivery semantics are viewport independent");
      const session = `delivery-retry-${randomUUID()}`;
      const headers = { Authorization: "Bearer 1234" };
      const key = randomUUID();
      try {
        const prepared = await request.post("/api/v1/publications/prepare", {
          headers: { ...headers, "Idempotency-Key": key },
          data: {
            provider,
            session_id: session,
            schema_version: 1,
            payload: {
              questions: [
                {
                  id: "Q1",
                  question: "Continue?",
                  explanation_html: "<p>Decision</p>",
                  recommendation: "A",
                  options: [{ letter: "A", label: "Continue", detail: "Proceed" }],
                },
              ],
            },
          },
        });
        expect(prepared.ok()).toBeTruthy();
        const committed = await request.post(`/api/v1/publications/${(await prepared.json()).publication.id}/commit`, {
          headers: { ...headers, "Idempotency-Key": key },
          data: {},
        });
        const round = (await committed.json()).round_id;
        expect(
          (
            await request.put(`/api/v1/rounds/${round}/answers/Q1`, {
              headers,
              data: { selected_option: "A", note: null, state: "queued" },
            })
          ).ok(),
        ).toBeTruthy();
        const preview = await (
          await request.post(`/api/v1/rounds/${round}/prompt-preview`, { headers, data: {} })
        ).json();
        const snapshot = (
          await (
            await request.post(`/api/v1/rounds/${round}/prompt-snapshots`, {
              headers,
              data: {
                reason: "copy",
                snapshot_id: preview.snapshot_id,
                expected_prompt: preview.prompt,
                expected_diagram_revisions: preview.diagram_revisions,
              },
            })
          ).json()
        ).snapshot;
        const sync = {
          instance_id: randomUUID(),
          sessions: [
            { provider, session_id: session, ...(nativePi ? { active_round_id: round, accepting: true } : {}) },
          ],
          acknowledgements: [] as object[],
        };
        const route = nativePi ? "/api/v1/pi/sync" : "/api/v1/aboard/sync";
        const synchronize = async () => (await request.post(route, { headers, data: sync })).json();
        await synchronize();
        const deliver = async (id: string) => {
          const response = await request.post(`/api/v1/prompt-snapshots/${snapshot.id}/deliveries`, {
            headers,
            data: { delivery_id: id },
          });
          expect(response.ok(), await response.text()).toBeTruthy();
          return (await response.json()).delivery;
        };
        const firstId = randomUUID();
        expect((await deliver(firstId)).id).toBe(firstId);
        expect((await deliver(randomUUID())).id).toBe(firstId);
        if (nativePi) {
          const rejected = await request.post(route, {
            headers,
            data: { ...sync, sessions: [{ provider, session_id: session }] },
          });
          expect(rejected.status()).toBe(422);
          for (const state of [
            { accepting: false, active_round_id: round },
            { accepting: true, active_round_id: randomUUID() },
          ]) {
            const refused = await request.post(route, {
              headers,
              data: { ...sync, sessions: [{ provider, session_id: session, ...state }] },
            });
            expect((await refused.json()).deliveries).toEqual([]);
          }
        }
        const claimed = await synchronize();
        expect(claimed.deliveries.map((item: { delivery_id: string }) => item.delivery_id)).toEqual([firstId]);
        expect(Date.parse(claimed.deliveries[0].expires_at)).toBeGreaterThan(Date.now());
        // Aboard submits asynchronously: a heartbeat must never reclaim its in-flight prompt.
        expect((await synchronize()).deliveries.map((item: { delivery_id: string }) => item.delivery_id)).toEqual(
          nativePi ? [firstId] : [],
        );
        sync.acknowledgements = [
          { delivery_id: firstId, status: "failed", failure_message: "Fixture download unavailable" },
        ];
        await synchronize();
        expect((await deliver(firstId)).status).toBe("failed");
        const retry = randomUUID();
        expect((await deliver(retry)).id).toBe(retry);
        expect((await deliver(retry)).id).toBe(retry);
        sync.acknowledgements = [];
        await synchronize();
        sync.acknowledgements = [{ delivery_id: retry, status: "submitted-to-terminal" }];
        await synchronize();
        expect((await (await request.get(`/api/v1/deliveries/${retry}`, { headers })).json()).delivery.status).toBe(
          "submitted-to-terminal",
        );
        const resend = randomUUID();
        expect((await deliver(resend)).id).toBe(resend);
        expect((await deliver(randomUUID())).id).toBe(resend);
        expect(
          (await (await request.get(`/api/v1/prompt-snapshots/${snapshot.id}`, { headers })).json()).snapshot.prompt,
        ).toBe(snapshot.prompt);
      } finally {
        await request.delete(`/api/v1/sessions/${provider}/${session}`, { headers });
      }
    });
  }
}
