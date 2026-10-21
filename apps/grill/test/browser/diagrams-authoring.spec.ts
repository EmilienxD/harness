import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

for (const provider of ["claude", "chatgpt", "pi"]) {
  test(`${provider} publishes identified Mermaid figures without assets or initialization`, async ({
    page,
    request,
  }) => {
    const session = `diagram-authoring-${randomUUID()}`;
    const headers = { Authorization: "Bearer 1234", "Idempotency-Key": randomUUID() };
    const explanation = `<p>Choose the publication order.</p>
<figure data-grill-diagram="publication"><pre class="mermaid">flowchart LR
 A[Write assets] --&gt; B[Publish round]</pre><figcaption>Assets precede publication.</figcaption></figure>
<figure data-grill-diagram="review"><pre class="mermaid">flowchart LR
 A[Read] --&gt; B[Review]</pre><figcaption>Review the result.</figcaption></figure>`;
    const question = {
      id: "Q1",
      question: "When should a round appear?",
      explanation_html: explanation,
      recommendation: "A",
      options: [{ letter: "A", label: "After assets", detail: "Keep references ready" }],
    };
    const publication = {
      provider,
      session_id: session,
      title: "Diagram authoring acceptance",
      schema_version: 1,
      payload: { questions: [question] },
    };
    try {
      const invalid = await request.post("/api/v1/publications/prepare", {
        headers: { ...headers, "Idempotency-Key": randomUUID() },
        data: {
          ...publication,
          payload: {
            questions: [
              {
                ...question,
                explanation_html: explanation.replace(
                  'data-grill-diagram="review"',
                  'data-grill-diagram="publication"',
                ),
              },
            ],
          },
        },
      });
      expect(invalid.status()).toBe(422);
      const prepared = await request.post("/api/v1/publications/prepare", { headers, data: publication });
      expect(prepared.ok()).toBeTruthy();
      const { publication: pending } = await prepared.json();
      const committed = await request.post(`/api/v1/publications/${pending.id}/commit`, { headers, data: {} });
      expect(committed.ok()).toBeTruthy();
      const { round_id: roundId } = await committed.json();
      const saved = await request.get(`/api/v1/rounds/${roundId}`, { headers }).then((response) => response.json());
      expect(saved.round.payload.questions).toEqual([question]);
      const access = await request.post("/api/v1/access", { data: { code: "1234" } });
      expect(access.ok()).toBeTruthy();
      await page.context().addCookies((await request.storageState()).cookies);
      await page.goto(`/?session=${encodeURIComponent(`${provider}:${session}`)}`);
      const card = page.locator("article.question:visible");
      await expect(card.getByRole("heading", { name: question.question })).toBeVisible();
      await expect(card.getByText("Assets precede publication.", { exact: true })).toBeVisible();
      await expect(card.getByText("Review the result.", { exact: true })).toBeVisible();
      await card.getByRole("radio").first().check();
      await card.getByRole("button", { name: "Review prompt", exact: true }).click();
      await expect(page.getByRole("dialog", { name: "Prompt review" })).toBeVisible();
    } finally {
      const removed = await request.delete(`/api/v1/sessions/${provider}/${session}`, { headers });
      expect(removed.ok()).toBeTruthy();
    }
  });
}
