import { expect, test } from "@playwright/test";

const figure = (id: string, source: string) =>
  `<figure data-grill-diagram="${id}"><pre class="mermaid">${source.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</pre><figcaption>${id}</figcaption></figure>`;

test("conversion failure retries locally while other diagrams and authored controls remain usable", async ({
  page,
}) => {
  const savedColors: { type: string; backgroundColor: string; strokeColor: string }[] = [];
  const session = {
    id: "failure-session",
    provider: "chatgpt",
    provider_session_id: "failure-session",
    display_title: "Diagram failure fixture",
    project_name: null,
    project_path: null,
    last_activity_at: "2026-10-21T12:00:00Z",
    finished_at: null,
    expires_at: null,
    active_round_id: "failure-round",
    active_round_number: 1,
    answered_count: 0,
    question_count: 1,
    aboard: null,
  };
  const round = {
    id: "failure-round",
    session_id: session.id,
    number: 1,
    status: "active",
    answers: [],
    prompt_snapshots: [],
    payload: {
      questions: [
        {
          id: "Q1",
          question: "Recover one diagram",
          recommendation: "A",
          options: [{ letter: "A", label: "Continue", detail: "Usable despite a failed diagram" }],
          explanation_html:
            '<button class="independent">Independent content</button>' +
            figure("retry", "flowchart LR\n A[Recover] --> B[Ready]") +
            figure(
              "valid",
              "flowchart LR\n A[Valid] --> B[Usable]\n style A fill:#dcfce7,stroke:#16a34a,color:#052e16",
            ) +
            figure("invalid", "this is not valid Mermaid"),
          init_js:
            'root.querySelector(".independent").onclick = (event) => { event.target.textContent = "Content still works"; };',
        },
      ],
    },
  };
  await page.route("**/api/v1/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/v1/changes") return route.fulfill({ json: { content: "1", presence: "online" } });
    if (path === "/api/v1/sessions") return route.fulfill({ json: { sessions: [session] } });
    if (path === "/api/v1/sessions/chatgpt/failure-session")
      return route.fulfill({
        json: { session, rounds: [{ id: round.id, number: 1, status: "active" }], aboard: null },
      });
    if (path === "/api/v1/rounds/failure-round") return route.fulfill({ json: { round } });
    if (path === "/api/v1/rounds/failure-round/scenes") return route.fulfill({ json: { scenes: [] } });
    if (path.includes("/scenes/") && route.request().method() === "PUT") {
      const body = route.request().postDataJSON();
      savedColors.push(...body.scene.elements);
      return route.fulfill({ json: { revision: "a".repeat(64), baseline: body.baseline } });
    }
    throw new Error(`Unexpected API request ${path}`);
  });
  // A transient font-loading failure exercises the actual conversion error path without replacing the converter.
  await page.addInitScript(() => {
    Object.defineProperty(document.fonts, "ready", {
      configurable: true,
      get() {
        return Promise.reject(new Error("Temporary font loading failure"));
      },
    });
  });
  await page.goto("/?session=chatgpt%3Afailure-session");
  const retry = page.locator('[data-diagram-editor="retry"]');
  const valid = page.locator('[data-diagram-editor="valid"]');
  const invalid = page.locator('[data-diagram-editor="invalid"]');
  await expect(retry.getByRole("alert")).toContainText("Temporary font loading failure");
  await page.evaluate(() => {
    Reflect.deleteProperty(document.fonts, "ready");
  });
  await expect(invalid.getByRole("alert")).toContainText("could not be loaded or prepared");
  await retry.getByRole("button", { name: "Retry diagram", exact: true }).click();
  await expect(retry.locator("canvas").first()).toBeVisible();
  await expect(retry.getByRole("alert")).toHaveCount(0);
  await invalid.getByRole("button", { name: "Retry diagram", exact: true }).click();
  await expect(invalid.getByRole("alert")).toContainText("could not be loaded or prepared");
  if (await valid.getByRole("button", { name: "Retry diagram", exact: true }).isVisible())
    await valid.getByRole("button", { name: "Retry diagram", exact: true }).click();
  await expect(valid.locator("canvas").first()).toBeVisible();
  await expect
    .poll(() =>
      savedColors.some(
        (element) =>
          element.type === "rectangle" &&
          element.backgroundColor === "transparent" &&
          element.strokeColor === "#1e1e1e",
      ),
    )
    .toBe(true);
  expect(
    savedColors.some((element) => element.backgroundColor === "#dcfce7" && element.strokeColor === "#16a34a"),
  ).toBe(true);
  // Viewing must retain native navigation, both inline and in the fullscreen dialog.
  for (const fullscreen of [false, true]) {
    if (fullscreen) await valid.getByRole("button", { name: "Fullscreen", exact: true }).click();
    const editor = page.locator('[data-diagram-editor="valid"]');
    const canvas = editor.locator("canvas.excalidraw__canvas.interactive");
    await expect(canvas).toBeVisible();
    const beforeZoom = await canvas.screenshot();
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -100);
    await page.keyboard.up("Control");
    await expect.poll(async () => (await canvas.screenshot()).equals(beforeZoom)).toBe(false);
    const beforePan = await canvas.screenshot();
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2 + 60, { steps: 10 });
    await page.mouse.up();
    await expect.poll(async () => (await canvas.screenshot()).equals(beforePan)).toBe(false);
    await expect(editor.getByRole("button", { name: "Edit diagram", exact: true })).toBeVisible();
    if (fullscreen) await editor.getByRole("button", { name: "Close fullscreen", exact: true }).click();
  }
  await valid.getByRole("button", { name: "Edit diagram", exact: true }).click();
  await expect(valid.getByRole("button", { name: "Done editing", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Independent content", exact: true }).click();
  await expect(page.getByRole("button", { name: "Content still works", exact: true })).toBeVisible();
  await expect(page.getByRole("radio").first()).toBeEnabled();
});

test("ordinary explanations do not load diagram runtime, converter, CSS or fonts", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.route("**/api/v1/sessions", (route) => route.fulfill({ json: { sessions: [] } }));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "No grill session selected", exact: true })).toBeVisible();
  expect(
    requests.filter((url) => /diagram-editor|diagram-conversion|mermaid|excalidraw|diagram-assets/.test(url)),
  ).toEqual([]);
});
