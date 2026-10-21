import { randomUUID } from "node:crypto";
import { expect, test, type Locator } from "@playwright/test";
import { meaningfulScene } from "../../src/lib/diagram-feedback";

test("feedback waits for review and reset restores the original native and fallback drawings", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const headers = { Authorization: "Bearer 1234" };
  const session = `diagram-reset-${randomUUID()}`;
  const key = randomUUID();
  const figure = (id: string, source: string) =>
    `<figure data-grill-diagram="${id}"><pre class="mermaid">${source}</pre><figcaption>${id}</figcaption></figure>`;
  let previews = 0;
  page.on("request", (req) => {
    if (req.url().endsWith("/prompt-preview")) previews++;
  });
  try {
    const prepared = await request.post("/api/v1/publications/prepare", {
      headers: { ...headers, "Idempotency-Key": key },
      data: {
        provider: "chatgpt",
        session_id: session,
        title: "Review and reset diagrams",
        schema_version: 1,
        payload: {
          image_command: "python fixture-grill-images.py",
          questions: [
            {
              id: "Q1",
              question: "Review the final drawing",
              recommendation: "A",
              options: [{ letter: "A", label: "Proceed", detail: "Use this design" }],
              explanation_html:
                figure("flow", "flowchart LR\n A[Start] --&gt; B[Finish]") +
                figure("fallback", 'pie\n "Work" : 70\n "Rest" : 30'),
            },
          ],
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
    const roundId = (await committed.json()).round_id;
    const scenes = async () =>
      (await (await request.get(`/api/v1/rounds/${roundId}/scenes`, { headers })).json()).scenes;
    const drawing = async (id: string) => (await scenes()).find((row: { diagram_id: string }) => row.diagram_id === id);
    await request.post("/api/v1/access", { data: { code: "1234" } });
    await page.context().addCookies((await request.storageState()).cookies);
    await page.goto(`/?session=${encodeURIComponent(`chatgpt:${session}`)}`);
    const card = page.locator("article.question:visible");
    const flow = card.locator('[data-diagram-editor="flow"]');
    const fallback = card.locator('[data-diagram-editor="fallback"]');
    await expect(flow.locator("canvas").first()).toBeVisible({ timeout: 30_000 });
    await expect(fallback.locator("canvas").first()).toBeVisible();
    await expect.poll(async () => (await scenes()).length).toBe(2);
    const original = await drawing("flow");
    const originalFallback = await drawing("fallback");
    const selectAll = async (editor: Locator) => {
      await editor.locator(".excalidraw").click({ position: { x: 12, y: 180 } });
      await page.keyboard.press("ControlOrMeta+a");
    };
    const noFeedback = async () => {
      await expect(page.getByLabel("Diagram feedback", { exact: true })).toHaveCount(0);
      await expect(page.getByLabel("Generated diagram feedback", { exact: true })).toHaveCount(0);
    };
    await noFeedback();
    await flow.getByRole("button", { name: "Edit diagram", exact: true }).click();
    await selectAll(flow);
    await page.keyboard.press("ArrowRight");
    await expect
      .poll(async () => meaningfulScene((await drawing("flow")).scene))
      .not.toBe(meaningfulScene(original.baseline));
    await noFeedback();
    // Repeated edits and navigation are autosaved, never turned into a visible event log.
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await flow.getByRole("button", { name: "Done editing", exact: true }).click();
    await card.getByRole("radio").first().check();
    await card.getByRole("textbox").first().fill("Keep my written feedback.");
    expect(previews).toBe(0);
    await noFeedback();
    await card.getByRole("button", { name: "Review prompt", exact: true }).click();
    const review = page.getByRole("dialog", { name: "Prompt review" });
    await expect(review).toBeVisible();
    await expect(review.locator("pre")).toContainText("Moved");
    expect((await review.locator("pre").innerText()).match(/Moved rectangle "Start"/g)).toHaveLength(1);
    await expect(review.locator("pre")).toContainText("Keep my written feedback.");
    await expect(review.locator("pre")).toContainText("No changes were made to the diagram.");
    expect(previews).toBe(1);
    await review.getByRole("button", { name: "Back to questions", exact: true }).last().click();
    await noFeedback();
    // Load a saved appearance/label edit as well, so reset must restore more than positions.
    const styled = await drawing("flow");
    styled.scene.appState.viewBackgroundColor = "#ff0000";
    styled.scene.elements[0].strokeColor = "#00ff00";
    const label = styled.scene.elements.find((element: { type: string }) => element.type === "text");
    label.text = label.originalText = "Replacement label";
    const savedStyle = await request.put(`/api/v1/rounds/${roundId}/scenes/Q1/flow`, {
      headers,
      data: { ...styled, expected_revision: styled.revision },
    });
    expect(savedStyle.ok(), await savedStyle.text()).toBeTruthy();
    await page.reload();
    await expect(flow.locator("canvas").first()).toBeVisible();
    // Reset is available in fullscreen and persists as the original (not an empty drawing).
    await flow.getByRole("button", { name: "Fullscreen", exact: true }).click();
    const full = page.locator(".diagram-shell.is-fullscreen");
    await full.getByRole("button", { name: "Reset to original", exact: true }).click();
    await expect
      .poll(async () => meaningfulScene((await drawing("flow")).scene))
      .toBe(meaningfulScene(original.baseline));
    await full.getByRole("button", { name: "Close fullscreen", exact: true }).click();
    // Clear all original elements, then restore them through the new inline control.
    await flow.getByRole("button", { name: "Edit diagram", exact: true }).click();
    await selectAll(flow);
    await page.keyboard.press("Backspace");
    await expect
      .poll(
        async () => (await drawing("flow")).scene.elements.filter((el: { isDeleted: boolean }) => !el.isDeleted).length,
      )
      .toBe(0);
    await flow.getByRole("button", { name: "Reset to original", exact: true }).click();
    await expect
      .poll(async () => meaningfulScene((await drawing("flow")).scene))
      .toBe(meaningfulScene(original.baseline));
    await flow.locator(".excalidraw").click({ position: { x: 12, y: 180 } });
    await page.keyboard.press("ControlOrMeta+z");
    await expect
      .poll(
        async () => (await drawing("flow")).scene.elements.filter((el: { isDeleted: boolean }) => !el.isDeleted).length,
      )
      .toBe(0);
    await flow.getByRole("button", { name: "Reset to original", exact: true }).click();
    await expect
      .poll(async () => meaningfulScene((await drawing("flow")).scene))
      .toBe(meaningfulScene(original.baseline));
    await flow.getByRole("button", { name: "Done editing", exact: true }).click();
    // Image fallbacks also restore their original image and file data.
    await fallback.getByRole("button", { name: "Edit diagram", exact: true }).click();
    await selectAll(fallback);
    await page.keyboard.press("Backspace");
    await expect
      .poll(
        async () =>
          (await drawing("fallback")).scene.elements.filter((el: { isDeleted: boolean }) => !el.isDeleted).length,
      )
      .toBe(0);
    await fallback.getByRole("button", { name: "Reset to original", exact: true }).click();
    await expect
      .poll(async () => meaningfulScene((await drawing("fallback")).scene))
      .toBe(meaningfulScene(originalFallback.baseline));
    await page.reload();
    await expect(flow.locator("canvas").first()).toBeVisible();
    await expect(fallback.locator("canvas").first()).toBeVisible();
    await expect(card.getByRole("textbox").first()).toHaveValue("Keep my written feedback.");
    await noFeedback();
    await card.getByRole("button", { name: "Review prompt", exact: true }).click();
    await expect(review).toBeVisible();
    const prompt = await review.locator("pre").innerText();
    expect(prompt.match(/No changes were made to the diagram\./g)).toHaveLength(2);
    expect(prompt).not.toContain("Moved");
    expect(prompt).not.toContain("authenticated Grill image");
  } finally {
    await request.delete(`/api/v1/sessions/chatgpt/${session}`, { headers });
  }
});
