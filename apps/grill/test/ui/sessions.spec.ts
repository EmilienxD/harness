import { expect, test, type Page, type Route } from "@playwright/test";

function session(id: string, finished = false) {
  return {
    id,
    provider: "chatgpt",
    provider_session_id: id,
    display_title: `Session ${id}`,
    project_name: null,
    project_path: null,
    last_activity_at: "2026-10-21T12:00:00Z",
    finished_at: finished ? "2026-10-21T12:00:00Z" : null,
    expires_at: null,
    active_round_id: `round-${id}`,
    active_round_number: 1,
    answered_count: 0,
    question_count: 1,
    aboard: null,
  };
}

function round(id: string) {
  return {
    id: `round-${id}`,
    session_id: id,
    number: 1,
    status: "active",
    payload: {
      questions: [
        {
          id: "Q1",
          question: `Question for ${id}`,
          explanation_html: "<p>Context</p>",
          recommendation: "A",
          options: [{ letter: "A", label: "First option", detail: "Details" }],
        },
      ],
    },
    answers: [],
    prompt_snapshots: [],
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

function detail(id: string) {
  return { session: session(id), rounds: [{ id: `round-${id}`, number: 1, status: "active" }], aboard: null };
}

// Let the browser consume the released response and React commit before checking the DOM.
async function settle(page: Page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function board(page: Page, initial = [session("a"), session("b")]) {
  let sessions = initial;
  let revision = 0;
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace("/api/v1/", "");
    // These race fixtures deliberately change on every poll to exercise in-flight responses.
    if (path === "changes") return route.fulfill({ json: { content: String(++revision), presence: "online" } });
    if (path === "sessions") return route.fulfill({ json: { sessions } });
    if (path.startsWith("sessions/chatgpt/")) {
      const id = path.split("/")[2];
      const item = sessions.find((item) => item.id === id);
      if (route.request().method() === "DELETE") {
        sessions = sessions.filter((item) => item.id !== id);
        return route.fulfill({ json: { deleted: true } });
      }
      if (!item)
        return route.fulfill({
          status: 404,
          json: { error: { code: "session_not_found", message: "Session not found." } },
        });
      return route.fulfill({
        json: { session: item, rounds: [{ id: `round-${id}`, number: 1, status: "active" }], aboard: null },
      });
    }
    if (path.startsWith("rounds/round-")) {
      return route.fulfill({ json: { round: round(path.slice("rounds/round-".length)) } });
    }
    throw new Error(`Unexpected API request: ${route.request().method()} ${path}`);
  });
  return {
    setSessions(next: typeof initial) {
      sessions = next;
    },
  };
}

async function choose(page: Page, id: string) {
  const show = page.getByRole("button", { name: "Show sessions", exact: true });
  if (await show.isVisible()) await show.click();
  await page
    .getByRole("button", { name: `Session ${id}`, exact: false })
    .filter({ has: page.locator("b") })
    .click();
}

async function remove(page: Page, id: string) {
  const show = page.getByRole("button", { name: "Show sessions", exact: true });
  if (await show.isVisible()) await show.click();
  await page.getByRole("button", { name: `Delete Session ${id}`, exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete session", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
}

for (const stage of ["detail", "round"] as const) {
  test(`switch ignores a late ${stage} response from the previous session`, async ({ page }) => {
    await board(page);
    await page.goto("/?session=chatgpt%3Aa");
    await expect(page.getByRole("heading", { name: "Question for a" })).toBeVisible();
    const started = deferred();
    const release = deferred();
    const completed = deferred();
    const path = stage === "detail" ? "sessions/chatgpt/a" : "rounds/round-a";
    await page.route(
      `**/api/v1/${path}`,
      async (route) => {
        started.resolve();
        await release.promise;
        await route.fulfill({ json: stage === "detail" ? detail("a") : { round: round("a") } });
        completed.resolve();
      },
      { times: 1 },
    );
    await started.promise;
    await choose(page, "b");
    await expect(page.getByRole("heading", { name: "Question for b" })).toBeVisible();
    // Hold B's next poll so it cannot conceal an incorrectly accepted A response.
    const hold = (route: Route) => route.abort();
    await page.route("**/api/v1/sessions/chatgpt/b", hold);
    release.resolve();
    await completed.promise;
    await settle(page);
    await expect(page.getByRole("heading", { name: "Question for b" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Question for a" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Copy session ID: b", exact: true })).toBeVisible();
  });
}

test("refresh preserves the URL selection even when another session is preferred", async ({ page }) => {
  await board(page);
  await page.goto("/?session=chatgpt%3Ab");
  await expect(page.getByRole("heading", { name: "Question for b" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Question for b" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Question for a" })).toHaveCount(0);
  await expect(page).toHaveURL(/session=chatgpt%3Ab/);
});

test("the default selection survives refresh after session activity reorders the list", async ({ page }) => {
  const fixture = await board(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Question for a" })).toBeVisible();
  await expect(page).toHaveURL(/session=chatgpt%3Aa/);
  fixture.setSessions([session("b"), session("a")]);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Question for a" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Question for b" })).toHaveCount(0);
});

test("deleting the selection prefers an active session over finished sessions", async ({ page }) => {
  await board(page, [session("a"), session("archived", true), session("b")]);
  await page.goto("/?session=chatgpt%3Aa");
  await expect(page.getByRole("heading", { name: "Question for a" })).toBeVisible();
  const started = deferred();
  const release = deferred();
  const completed = deferred();
  await page.route("**/api/v1/sessions/chatgpt/a", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    started.resolve();
    await release.promise;
    await route.fulfill({
      status: 404,
      json: { error: { code: "session_not_found", message: "Session not found." } },
    });
    completed.resolve();
  });
  await started.promise;
  await remove(page, "a");
  await expect(page.getByRole("heading", { name: "Question for b" })).toBeVisible();
  release.resolve();
  await completed.promise;
  await settle(page);
  expect(await page.locator(".banner").count()).toBe(0);
  await expect(page).toHaveURL(/session=chatgpt%3Ab/);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Question for b" })).toBeVisible();
});

test("deleting the last session stays empty when an old list response arrives", async ({ page }) => {
  await board(page, [session("a")]);
  await page.goto("/?session=chatgpt%3Aa");
  await expect(page.getByRole("heading", { name: "Question for a" })).toBeVisible();
  const started = deferred();
  const release = deferred();
  const completed = deferred();
  await page.route(
    "**/api/v1/sessions",
    async (route) => {
      started.resolve();
      await release.promise;
      await route.fulfill({ json: { sessions: [session("a")] } });
      completed.resolve();
    },
    { times: 1 },
  );
  await started.promise;
  await remove(page, "a");
  await expect(page.getByRole("heading", { name: "No grill session selected" })).toBeVisible();
  release.resolve();
  await completed.promise;
  await settle(page);
  await expect(page.getByRole("heading", { name: "No grill session selected" })).toBeVisible();
  await expect(page.locator(".banner")).toHaveCount(0);
  await expect(page.locator(".session-row")).toHaveCount(0);
  await expect(page).toHaveURL("/");
  await page.reload();
  await expect(page.getByRole("heading", { name: "No grill session selected" })).toBeVisible();
});

test("deleting another session keeps the current selection", async ({ page }) => {
  await board(page);
  await page.goto("/?session=chatgpt%3Ab");
  await expect(page.getByRole("heading", { name: "Question for b" })).toBeVisible();
  await remove(page, "a");
  await expect(page.getByRole("heading", { name: "Question for b" })).toBeVisible();
  await expect(page).toHaveURL(/session=chatgpt%3Ab/);
  await expect(page.locator(".banner")).toHaveCount(0);
});

test("unchanged revisions avoid content reads; remote answers update without resetting authored controls", async ({
  page,
}) => {
  await board(page, [session("a")]);
  let content = "1";
  let checks = 0;
  let fullReads = 0;
  let stateReads = 0;
  let listReads = 0;
  await page.route("**/api/v1/changes", (route) => {
    checks += 1;
    return route.fulfill({ json: { content, presence: "online" } });
  });
  await page.route("**/api/v1/sessions", (route) => {
    listReads += 1;
    return route.fulfill({ json: { sessions: [session("a")] } });
  });
  await page.route("**/api/v1/rounds/round-a", (route) => {
    if (route.request().headers()["x-grill-content"] === "cached") {
      stateReads += 1;
      return route.fulfill({
        json: {
          round: {
            id: "round-a",
            status: "active",
            prompt_snapshots: [],
            answers:
              content === "1"
                ? []
                : [
                    {
                      question_id: "Q1",
                      selected_option: "A",
                      note: "A remote answer",
                      state: "queued",
                      updated_at: "2026-11-05T12:00:00Z",
                      queued_at: "2026-11-05T12:00:00Z",
                    },
                  ],
          },
        },
      });
    }
    fullReads += 1;
    const authored = round("a");
    authored.payload.questions[0]!.explanation_html =
      '<label>Preview setting<input aria-label="Preview setting"></label>';
    return route.fulfill({ json: { round: authored } });
  });
  await page.goto("/?session=chatgpt%3Aa");
  await expect(page.getByRole("heading", { name: "Question for a" })).toBeVisible();
  await page.getByRole("textbox", { name: "Preview setting" }).fill("Keep this setting");
  await expect.poll(() => checks, { timeout: 10_000 }).toBeGreaterThanOrEqual(3);
  expect(fullReads).toBe(1);
  expect(stateReads).toBe(1);
  expect(listReads).toBe(2);
  content = "2";
  await expect(page.getByRole("textbox", { name: "Add context or write your own answer" })).toHaveValue(
    "A remote answer",
  );
  await expect(page.getByRole("textbox", { name: "Preview setting" })).toHaveValue("Keep this setting");
  expect(fullReads).toBe(1);
  expect(stateReads).toBe(2);
});

test("hidden boards stop checking and refresh immediately on return", async ({ page }) => {
  await board(page, [session("a")]);
  let checks = 0;
  await page.route("**/api/v1/changes", (route) => {
    checks += 1;
    return route.fulfill({ json: { content: "1", presence: "online" } });
  });
  await page.goto("/?session=chatgpt%3Aa");
  await expect(page.getByRole("heading", { name: "Question for a" })).toBeVisible();
  await expect.poll(() => checks).toBeGreaterThanOrEqual(1);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const paused = checks;
  await page.waitForTimeout(4_500);
  expect(checks).toBe(paused);
  await page.evaluate(() => {
    Reflect.deleteProperty(document, "hidden");
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => checks, { timeout: 1_000 }).toBe(paused + 1);
});

test("a failed session switch retries even when the database revision stays unchanged", async ({ page }) => {
  await board(page);
  let checks = 0;
  await page.route("**/api/v1/changes", (route) => {
    checks += 1;
    return route.fulfill({ json: { content: "1", presence: "online" } });
  });
  await page.goto("/?session=chatgpt%3Aa");
  await expect(page.getByRole("heading", { name: "Question for a" })).toBeVisible();
  await expect.poll(() => checks).toBeGreaterThanOrEqual(1);
  await page.route(
    "**/api/v1/sessions/chatgpt/b",
    (route) =>
      route.fulfill({
        status: 503,
        json: { error: { code: "database_error", message: "Temporary session failure" } },
      }),
    { times: 1 },
  );
  await choose(page, "b");
  await expect(page.getByRole("heading", { name: "Question for b" })).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".banner")).toHaveCount(0);
});
