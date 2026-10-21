import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

test("round notes autosave, survive reload, flush for review, and freeze with history", async ({
  page,
  request,
}, testInfo) => {
  const session = `notes-e2e-${randomUUID()}`;
  const headers = { Authorization: "Bearer 1234" };
  const publish = async () => {
    const key = randomUUID();
    const prepared = await request.post("/api/v1/publications/prepare", {
      headers: { ...headers, "Idempotency-Key": key },
      data: {
        provider: "chatgpt",
        session_id: session,
        title: "Notes browser acceptance",
        schema_version: 1,
        payload: {
          questions: [
            {
              id: "Q18",
              question: "First question",
              explanation_html: "<p>Context</p>",
              recommendation: "A",
              options: [{ letter: "A", label: "First option", detail: "Details" }],
            },
            {
              id: "Q19",
              question: "Last question",
              explanation_html: "<p>Context</p>",
              recommendation: "A",
              options: [{ letter: "A", label: "Last option", detail: "Details" }],
            },
          ],
        },
      },
    });
    expect(prepared.ok()).toBeTruthy();
    const publication = await prepared.json();
    const committed = await request.post(`/api/v1/publications/${publication.publication.id}/commit`, {
      headers: { ...headers, "Idempotency-Key": key },
      data: {},
    });
    expect(committed.ok()).toBeTruthy();
    return await committed.json();
  };
  try {
    const first = await publish();
    await page.goto(`/`);
    const access = await request.post("/api/v1/access", { data: { code: "1234" } });
    expect(access.ok()).toBeTruthy();
    await page.context().addCookies(await request.storageState().then((state) => state.cookies));
    await page.goto(`/?session=${encodeURIComponent(`chatgpt:${session}`)}`);
    const card = page.locator("article.question:visible");
    await expect(card.getByRole("heading", { name: "First question" })).toBeVisible();
    await card.getByRole("button", { name: "Next question" }).click();
    await expect(card.getByRole("heading", { name: "Last question" })).toBeVisible();
    await expect(card.getByRole("button", { name: "Next question" })).toHaveCount(0);
    await card.getByRole("radio").first().check();
    await card.getByRole("button", { name: "Add Additional Notes" }).click();
    await expect(card.getByRole("heading", { name: "Notes", exact: true })).toBeVisible();
    await expect(card.getByRole("radio")).toHaveCount(0);
    const notes = card.getByRole("textbox", { name: "Additional notes", exact: true });
    await notes.fill("Remember this independent round context.");
    await expect
      .poll(async () => {
        const response = await request.get(`/api/v1/rounds/${first.round_id}`, { headers });
        const { round } = await response.json();
        return round.answers.find((answer: { question_id: string }) => answer.question_id === "Notes")?.note;
      })
      .toBe("Remember this independent round context.");
    await page.reload();
    await card.getByRole("button", { name: "Notes", exact: true }).click();
    await expect(notes).toHaveValue("Remember this independent round context.");
    await notes.fill("");
    await card.getByRole("button", { name: "Q19", exact: true }).click();
    await expect
      .poll(async () => {
        const { round } = await request
          .get(`/api/v1/rounds/${first.round_id}`, { headers })
          .then((response) => response.json());
        return round.answers.some((answer: { question_id: string }) => answer.question_id === "Notes");
      })
      .toBe(false);
    await card.getByRole("button", { name: "Add Additional Notes" }).click();
    await page.route(`**/rounds/${first.round_id}/answers/Notes`, (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "save_failed", message: "Temporary save failure" } }),
      }),
    );
    await notes.fill("Preserve this edit through a failed save.");
    await card.getByRole("button", { name: "Review prompt", exact: true }).click();
    await expect(card.getByRole("alert")).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Prompt review" })).toHaveCount(0);
    await expect(notes).toHaveValue("Preserve this edit through a failed save.");
    await page.unroute(`**/rounds/${first.round_id}/answers/Notes`);
    await card.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(card.getByRole("alert")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("notes.png"), fullPage: true });
    await notes.fill("A fresh edit immediately before review.");
    await card.getByRole("button", { name: "Review prompt", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Prompt review" })).toBeVisible();
    const saved = await request
      .get(`/api/v1/rounds/${first.round_id}`, { headers })
      .then((response) => response.json());
    expect(saved.round.answers.find((answer: { question_id: string }) => answer.question_id === "Notes").note).toBe(
      "A fresh edit immediately before review.",
    );
    const sessions = await request.get("/api/v1/sessions", { headers }).then((response) => response.json());
    expect(
      sessions.sessions.find((item: { provider_session_id: string }) => item.provider_session_id === session)
        .answered_count,
    ).toBe(1);
    const second = await publish();
    const frozen = await request.put(`/api/v1/rounds/${first.round_id}/answers/Notes`, {
      headers,
      data: { selected_option: null, note: "Forbidden historical edit", state: "queued" },
    });
    expect(frozen.status()).toBe(409);
    await page.reload();
    const historical = page.locator(".round-card").first();
    await historical.getByRole("button", { name: "Notes", exact: true }).click();
    await expect(historical.getByRole("textbox", { name: "Additional notes", exact: true })).toBeDisabled();
    const current = page.locator(".round-card.is-active");
    await current.getByRole("button", { name: "Notes", exact: true }).click();
    const freshNotes = current.getByRole("textbox", { name: "Additional notes", exact: true });
    await expect(freshNotes).toHaveValue("");
    await freshNotes.fill("Notes without answering any questions.");
    await current.getByRole("button", { name: "Review prompt", exact: true }).click();
    const preview = await request
      .post(`/api/v1/rounds/${second.round_id}/prompt-preview`, { headers, data: {} })
      .then((response) => response.json());
    const snapshot = await request.post(`/api/v1/rounds/${second.round_id}/prompt-snapshots`, {
      headers,
      data: { reason: "copy", expected_prompt: preview.prompt },
    });
    expect(snapshot.ok()).toBeTruthy();
    const invalidOption = await request.put(`/api/v1/rounds/${second.round_id}/answers/Notes`, {
      headers,
      data: { selected_option: "A", note: "Invalid option", state: "queued" },
    });
    expect(invalidOption.status()).toBe(422);
  } finally {
    const removed = await request.delete(`/api/v1/sessions/chatgpt/${session}`, { headers });
    expect(removed.ok()).toBeTruthy();
  }
});
