import { createHash, randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { meaningfulScene } from "../../src/lib/diagram-feedback";

const headers = { Authorization: "Bearer 1234" };
const figure = (id: string) =>
  `<figure data-grill-diagram="${id}"><pre class="mermaid">flowchart LR\n A[Start] --&gt; B[Finish]</pre><figcaption>${id}</figcaption></figure>`;

test("durable drawings, undo, retry, immutable reviewed images, authenticated metadata and lifecycle", async ({
  page,
  request,
  playwright,
}) => {
  test.setTimeout(120_000);
  const session = `diagram-durable-${randomUUID()}`;
  const publish = async () => {
    const key = randomUUID();
    const prepared = await request.post("/api/v1/publications/prepare", {
      headers: { ...headers, "Idempotency-Key": key },
      data: {
        provider: "chatgpt",
        session_id: session,
        title: "Durable diagram acceptance",
        schema_version: 1,
        payload: {
          questions: [1, 2].map((index) => ({
            id: `Q${index}`,
            question: `Durable ${index}`,
            explanation_html: figure("flow") + (index === 1 ? figure("second") : ""),
            recommendation: "A",
            options: [{ letter: "A", label: "Proceed", detail: "Continue" }],
          })),
        },
      },
    });
    expect(prepared.ok(), await prepared.text()).toBeTruthy();
    const { publication } = await prepared.json();
    const committed = await request.post(`/api/v1/publications/${publication.id}/commit`, {
      headers: { ...headers, "Idempotency-Key": key },
      data: {},
    });
    expect(committed.ok(), await committed.text()).toBeTruthy();
    return (await committed.json()).round_id as string;
  };
  const anonymous = await playwright.request.newContext({ baseURL: "http://localhost:8087" });
  try {
    const roundId = await publish();
    const scenePath = `/api/v1/rounds/${roundId}/scenes`;
    const scenes = async () => (await (await request.get(scenePath, { headers })).json()).scenes;
    await request.post("/api/v1/access", { data: { code: "1234" } });
    await page.context().addCookies((await request.storageState()).cookies);
    await page.goto(`/?session=${encodeURIComponent(`chatgpt:${session}`)}`);
    const card = page.locator("article.question:visible");
    const editor = card.locator('[data-diagram-editor="flow"]');
    await expect(editor.locator("canvas").first()).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => (await scenes()).length).toBe(2);
    const baselineRows = await scenes();
    const original = baselineRows.find(
      (row: { question_id: string; diagram_id: string }) => row.question_id === "Q1" && row.diagram_id === "flow",
    );
    const initialRevision = original.revision;
    const savedFlow = async () =>
      (await scenes()).find(
        (row: { question_id: string; diagram_id: string }) => row.question_id === "Q1" && row.diagram_id === "flow",
      );
    const liveCount = (scene: typeof original.scene) =>
      scene.elements.filter((element: { isDeleted: boolean }) => !element.isDeleted).length;
    const viewportOnly = structuredClone(original);
    Object.assign(viewportOnly.scene.appState, {
      scrollX: 300,
      scrollY: 800,
      zoom: { value: 2 },
      selectedElementIds: { A: true },
    });
    const viewportSaved = await request.put(`${scenePath}/Q1/flow`, {
      headers,
      data: { ...viewportOnly, expected_revision: initialRevision },
    });
    expect(viewportSaved.ok()).toBeTruthy();
    expect((await viewportSaved.json()).revision).toBe(initialRevision);

    // Select and move real native objects, then undo back to the immutable baseline.
    await editor.getByRole("button", { name: "Edit diagram", exact: true }).click();
    await editor.locator(".excalidraw").click({ position: { x: 12, y: 180 } });
    await page.keyboard.press("r");
    const canvas = await editor.locator(".excalidraw").boundingBox();
    await page.mouse.move(canvas!.x + 30, canvas!.y + 250);
    await page.mouse.down();
    await page.mouse.move(canvas!.x + 90, canvas!.y + 280, { steps: 5 });
    await page.mouse.up();
    await page.keyboard.press("Escape");
    await expect.poll(async () => liveCount((await savedFlow()).scene)).toBe(liveCount(original.scene) + 1);
    await expect
      .poll(
        async () =>
          (await scenes()).find(
            (row: { question_id: string; diagram_id: string }) => row.question_id === "Q1" && row.diagram_id === "flow",
          )?.revision,
      )
      .not.toBe(initialRevision);
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(async () => meaningfulScene((await savedFlow()).scene)).toBe(meaningfulScene(original.scene));
    await page.keyboard.press("ControlOrMeta+a");
    // Saving fails while the browser keeps a recoverable draft.
    await page.route(`**/rounds/${roundId}/scenes/Q1/flow`, (route) =>
      route.request().method() === "PUT"
        ? route.fulfill({ status: 503, json: { error: { message: "Forced drawing save failure" } } })
        : route.continue(),
    );
    await page.keyboard.press("ArrowRight");
    await expect(editor.getByRole("alert")).toContainText("Forced drawing save failure");
    await page.reload();
    await expect(editor.locator("canvas").first()).toBeVisible({ timeout: 30_000 });
    await expect(editor.getByLabel("Diagram feedback", { exact: true })).toHaveCount(0);
    await page.unroute(`**/rounds/${roundId}/scenes/Q1/flow`);
    await editor.getByRole("button", { name: "Retry diagram save" }).click();
    await expect
      .poll(
        async () =>
          (await scenes()).find(
            (row: { question_id: string; diagram_id: string }) => row.question_id === "Q1" && row.diagram_id === "flow",
          )?.revision,
      )
      .not.toBe(initialRevision);
    const moved = (await scenes()).find(
      (row: { question_id: string; diagram_id: string }) => row.question_id === "Q1" && row.diagram_id === "flow",
    );
    expect(moved.baseline).toEqual(original.baseline);
    // Navigation, independent diagrams, and refresh use persisted identities.
    await card.getByRole("button", { name: "Q2", exact: true }).click();
    await expect(card.getByRole("heading", { name: "Durable 2" })).toBeVisible();
    await card.getByRole("button", { name: "Q1", exact: true }).click();
    await expect(editor.locator("canvas").first()).toBeVisible();
    const second = (await scenes()).find(
      (row: { question_id: string; diagram_id: string }) => row.question_id === "Q1" && row.diagram_id === "second",
    );
    expect(meaningfulScene(second.scene)).toBe(meaningfulScene(second.baseline));
    await page.reload();
    await expect(editor.locator("canvas").first()).toBeVisible();
    expect(meaningfulScene((await savedFlow()).scene)).toBe(meaningfulScene(moved.scene));
    await card.getByRole("radio").first().check();
    const note = card.getByRole("textbox").first();
    await note.fill("My written notes stay separate.");
    // Invalidate the prior export with an appearance edit, then fail its upload during review.
    await expect
      .poll(async () => {
        const current = (await scenes()).find(
          (row: { question_id: string; diagram_id: string }) => row.question_id === "Q1" && row.diagram_id === "flow",
        );
        current.scene.elements[0].strokeColor = "#ff0000";
        const changed = await request.put(`${scenePath}/Q1/flow`, {
          headers,
          data: { ...current, expected_revision: current.revision },
        });
        return changed.status();
      })
      .toBe(200);
    await page.reload();
    await expect(editor.locator("canvas").first()).toBeVisible();
    await page.route(`**/rounds/${roundId}/scenes/Q1/flow/image`, (route) =>
      route.fulfill({ status: 503, json: { error: { message: "Forced image export failure" } } }),
    );
    await card.getByRole("button", { name: "Review prompt", exact: true }).click();
    await expect(page.getByRole("button", { name: "Retry review" })).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Prompt review" })).toHaveCount(0);
    await page.unroute(`**/rounds/${roundId}/scenes/Q1/flow/image`);
    await page.getByRole("button", { name: "Retry review" }).click();
    const review = page.getByRole("dialog", { name: "Prompt review" });
    await expect(review).toBeVisible();
    // Snapshot creation uses the server preview; image metadata is a structured contract.
    const preview = await request.post(`/api/v1/rounds/${roundId}/prompt-preview`, { headers, data: {} });
    expect(preview.ok(), await preview.text()).toBeTruthy();
    const firstSnapshotResponse = await request.post(`/api/v1/rounds/${roundId}/prompt-snapshots`, {
      headers,
      data: {
        reason: "copy",
        snapshot_id: (await preview.json()).snapshot_id,
        expected_prompt: (await preview.json()).prompt,
        expected_diagram_revisions: (await preview.json()).diagram_revisions,
      },
    });
    expect(firstSnapshotResponse.ok(), await firstSnapshotResponse.text()).toBeTruthy();
    const first = (await firstSnapshotResponse.json()).snapshot;
    const staleReview = await request.post(`/api/v1/rounds/${roundId}/prompt-snapshots`, {
      headers,
      data: {
        reason: "copy",
        snapshot_id: (await preview.json()).snapshot_id,
        expected_prompt: (await preview.json()).prompt,
        expected_diagram_revisions: {},
      },
    });
    expect(staleReview.status()).toBe(409);

    expect(first.images).toHaveLength(1);
    const image = first.images[0];
    expect(image).toMatchObject({ question_id: "Q1", diagram_id: "flow", media_type: "image/png" });
    expect(image.scene_revision).toBe(first.diagram_revisions["Q1/flow"]);
    expect(image.reference).toBe(image.asset_id);
    expect(first.prompt.slice(image.reference_start, image.reference_end)).toBe(image.reference);
    const png = await request.get(`/api/v1/assets/${image.asset_id}`, { headers });
    expect(png.status()).toBe(200);
    expect(png.headers()["content-type"]).toBe("image/png");
    const bytes = await png.body();
    expect(bytes.length).toBe(image.byte_size);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(image.sha256);
    expect((await anonymous.get(`/api/v1/assets/${image.asset_id}`)).status()).toBe(401);
    expect((await anonymous.get(`/api/v1/prompt-snapshots/${first.id}`)).status()).toBe(401);
    const cookieImage = await page.request.get(`/api/v1/assets/${image.asset_id}`);
    expect(cookieImage.status()).toBe(200);
    // A later revision cannot mutate the original baseline or a reviewed PNG.
    const latest = (await scenes()).find(
      (row: { question_id: string; diagram_id: string }) => row.question_id === "Q1" && row.diagram_id === "flow",
    );
    const alteredBaseline = structuredClone(latest.baseline);
    alteredBaseline.elements[0].x += 999;
    latest.scene.appState.viewBackgroundColor = "#ffffcc";
    const later = await request.put(`${scenePath}/Q1/flow`, {
      headers,
      data: { ...latest, baseline: alteredBaseline, expected_revision: latest.revision },
    });
    expect(later.ok()).toBeTruthy();
    expect((await later.json()).baseline).toEqual(original.baseline);
    expect(
      (
        await request.put(`${scenePath}/Q1/flow`, { headers, data: { ...latest, expected_revision: latest.revision } })
      ).status(),
    ).toBe(409);
    const invalidSource = await request.put(`${scenePath}/Q1/flow`, {
      headers,
      data: { ...latest, source: "flowchart LR\n Z --> Y", expected_revision: latest.revision },
    });
    expect(invalidSource.status()).toBe(409);
    expect((await request.post(`/api/v1/rounds/${roundId}/prompt-preview`, { headers, data: {} })).status()).toBe(409);
    const storedSnapshot = await request.get(`/api/v1/prompt-snapshots/${first.id}`, { headers });
    expect((await storedSnapshot.json()).snapshot.images).toEqual(first.images);
    expect(await (await request.get(`/api/v1/assets/${image.asset_id}`, { headers })).body()).toEqual(bytes);
    // Relay metadata is copied from the immutable snapshot, even after editing again.
    const sync = {
      instance_id: `durable-${randomUUID()}`,
      sessions: [{ provider: "chatgpt", session_id: session }],
      acknowledgements: [],
    };
    expect((await request.post("/api/v1/aboard/sync", { headers, data: sync })).ok()).toBeTruthy();
    const delivery = await request.post(`/api/v1/prompt-snapshots/${first.id}/deliveries`, { headers, data: {} });
    expect(delivery.ok()).toBeTruthy();
    const claimed = await request.post("/api/v1/aboard/sync", { headers, data: sync });
    const deliveries = (await claimed.json()).deliveries;
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].snapshot_id).toBe(first.id);
    expect(deliveries[0].images).toEqual(first.images);
    const originalDelivery = (await delivery.json()).delivery;
    await request.post("/api/v1/aboard/sync", {
      headers,
      data: {
        ...sync,
        acknowledgements: [
          { delivery_id: originalDelivery.id, status: "failed", failure_message: "Fixture preparation failed" },
        ],
      },
    });
    const retryId = randomUUID();
    const retryRequest = { headers, data: { delivery_id: retryId } };
    const retried = await request.post(`/api/v1/prompt-snapshots/${first.id}/deliveries`, retryRequest);
    expect(retried.ok()).toBeTruthy();
    expect((await retried.json()).delivery.id).toBe(retryId);
    expect(retryId).not.toBe(originalDelivery.id);
    const repeated = await request.post(`/api/v1/prompt-snapshots/${first.id}/deliveries`, retryRequest);
    expect((await repeated.json()).delivery.id).toBe(retryId);
    expect(
      (await (await request.get(`/api/v1/prompt-snapshots/${first.id}`, { headers })).json()).snapshot.images,
    ).toEqual(first.images);

    await publish();
    await page.reload();
    const historical = page.locator(".round-card").first();
    await expect(
      historical.locator('[data-diagram-editor="flow"]').getByText("Read only", { exact: true }),
    ).toBeVisible();
    expect(
      (
        await request.put(`${scenePath}/Q1/flow`, { headers, data: { ...latest, expected_revision: latest.revision } })
      ).status(),
    ).toBe(409);
    // Existing session deletion also removes scene rows and every private export object.
    const local = JSON.parse(execSync("npx supabase status -o json", { encoding: "utf8" }));
    const objectUrl = `${local.API_URL}/storage/v1/object/authenticated/grill-assets/${roundId}/diagrams/${image.asset_id}.png`;
    const storageHeaders = { Authorization: `Bearer ${local.SERVICE_ROLE_KEY}`, apikey: local.SERVICE_ROLE_KEY };
    expect((await request.get(objectUrl, { headers: storageHeaders })).status()).toBe(200);
    expect((await request.delete(`/api/v1/sessions/chatgpt/${session}`, { headers })).ok()).toBeTruthy();
    expect((await request.get(`/api/v1/assets/${image.asset_id}`, { headers })).status()).toBe(404);
    expect((await request.get(`/api/v1/prompt-snapshots/${first.id}`, { headers })).status()).toBe(404);
    expect((await request.get(scenePath, { headers })).status()).toBe(404);
    expect((await request.get(objectUrl, { headers: storageHeaders })).status()).not.toBe(200);
  } finally {
    await anonymous.dispose();
    await request.delete(`/api/v1/sessions/chatgpt/${session}`, { headers });
  }
});
