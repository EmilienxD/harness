import { createHash, randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

test("identical files under different references publish and survive partial-upload retries", async ({
  request,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Publication is viewport independent");
  const session = `duplicate-assets-${randomUUID()}`;
  const headers = { Authorization: "Bearer 1234", "Idempotency-Key": randomUUID() };
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=",
    "base64",
  );
  const digest = createHash("sha256").update(bytes).digest("hex");
  const references = ["assets/round-001/first.png", "assets/round-001/second.png"];
  const input = {
    provider: "chatgpt",
    session_id: session,
    title: "Duplicate image publication acceptance",
    schema_version: 1,
    payload: {
      questions: [
        {
          id: "Q1",
          question: "Compare the screenshots",
          explanation_html: references.map((reference) => `<img src="${reference}" alt="Screenshot">`).join(""),
          recommendation: "A",
          options: [{ letter: "A", label: "Proceed", detail: "Continue" }],
        },
      ],
    },
    assets: references.map((reference) => ({
      reference,
      media_type: "image/png",
      byte_size: bytes.length,
      sha256: digest,
    })),
  };
  type Target = { reference: string; path: string; signed_url: string };
  const prepare = async () => {
    const response = await request.post("/api/v1/publications/prepare", { headers, data: input });
    expect(response.ok(), await response.text()).toBeTruthy();
    return (await response.json()) as { publication: { id: string }; upload_targets: Target[] };
  };
  const upload = async (target: Target) => {
    const response = await request.put(target.signed_url, {
      headers: { "Content-Type": "image/png", "x-upsert": "false" },
      data: bytes,
    });
    expect(response.ok(), await response.text()).toBeTruthy();
  };
  try {
    const initialHeaders = { ...headers, "Idempotency-Key": randomUUID() };
    const initial = await request.post("/api/v1/publications/prepare", {
      headers: initialHeaders,
      data: {
        ...input,
        assets: [],
        payload: {
          questions: [{ ...input.payload.questions[0], explanation_html: "<p>Initial round.</p>" }],
        },
      },
    });
    expect(initial.ok(), await initial.text()).toBeTruthy();
    const initialCommit = await request.post(`/api/v1/publications/${(await initial.json()).publication.id}/commit`, {
      headers: initialHeaders,
      data: {},
    });
    expect(initialCommit.ok(), await initialCommit.text()).toBeTruthy();

    const first = await prepare();
    expect(first.upload_targets).toHaveLength(2);
    expect(new Set(first.upload_targets.map((target) => target.path)).size).toBe(2);
    const repeated = await prepare();
    expect(repeated.publication.id).toBe(first.publication.id);
    expect(repeated.upload_targets.map((target) => target.path)).toEqual(
      first.upload_targets.map((target) => target.path),
    );
    await upload(first.upload_targets[0]!);
    const resumed = await prepare();
    expect(resumed.upload_targets.map((target) => target.reference)).toEqual([references[1]]);
    expect(resumed.upload_targets[0]!.path).toBe(first.upload_targets[1]!.path);
    await upload(resumed.upload_targets[0]!);
    expect((await prepare()).upload_targets).toHaveLength(0);

    const commit = async () => {
      const response = await request.post(`/api/v1/publications/${first.publication.id}/commit`, { headers, data: {} });
      expect(response.ok(), await response.text()).toBeTruthy();
      return (await response.json()) as { round_id: string };
    };
    const committed = await commit();
    expect((await commit()).round_id).toBe(committed.round_id);
    const response = await request.get(`/api/v1/rounds/${committed.round_id}`, { headers });
    expect(response.ok()).toBeTruthy();
    const { round } = await response.json();
    expect(round.assets).toHaveLength(2);
    expect(round.assets.map((asset: { original_reference: string }) => asset.original_reference).sort()).toEqual(
      references,
    );
    for (const asset of round.assets) {
      const image = await request.get(`/api/v1/assets/${asset.id}`, { headers });
      expect(image.ok()).toBeTruthy();
      expect(await image.body()).toEqual(bytes);
    }
    const sessionResponse = await request.get(`/api/v1/sessions/chatgpt/${session}`, { headers });
    expect((await sessionResponse.json()).rounds).toHaveLength(2);
  } finally {
    const removed = await request.delete(`/api/v1/sessions/chatgpt/${session}`, { headers });
    expect([200, 404]).toContain(removed.status());
  }
});
