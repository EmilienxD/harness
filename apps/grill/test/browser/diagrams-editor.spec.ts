import { randomUUID } from "node:crypto";
import { expect, test, type Locator, type Page } from "@playwright/test";

test.use({ actionTimeout: 8_000 });

const figure = (id: string, source: string) =>
  `<figure data-grill-diagram="${id}"><pre class="mermaid">${source.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</pre><figcaption>${id} diagram</figcaption></figure>`;

test("pinned converter produces native editable supported diagrams, measured multiline text, and image fallback", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.goto("/");
  const results = await page.evaluate(async () => {
    const modulePath = "/src/lib/diagram-conversion.ts";
    const { convertDiagram, exportDiagramPng } = await import(modulePath);
    const sources = [
      'flowchart LR\n A["Write<br/>assets"] --> B[Publish]',
      "sequenceDiagram\n Alice->>Bob: Hello\n Bob-->>Alice: Done",
      "classDiagram\n Animal <|-- Duck\n Animal : +int age",
      "erDiagram\n CUSTOMER ||--o{ ORDER : places",
      "stateDiagram-v2\n [*] --> Ready\n Ready --> Done",
      'pie title Priorities\n "Work" : 70\n "Rest" : 30',
    ];
    const output = [];
    for (const source of sources) {
      const record = await convertDiagram(source);
      const elements = record.scene.elements as Array<{
        type: string;
        text?: string;
        width: number;
        height: number;
        containerId?: string;
        id: string;
      }>;
      const png = await exportDiagramPng(record.scene);
      output.push({
        imageFallback: record.imageFallback,
        types: elements.map((element) => element.type),
        texts: elements.filter((element) => element.type === "text").map((element) => element.text),
        files: Object.keys(record.scene.files).length,
        bytes: png.size,
        multilineFits: elements
          .filter((element) => element.text?.includes("\n") && element.containerId)
          .every((text) => {
            const container = elements.find((element) => element.id === text.containerId)!;
            return text.width <= container.width && text.height <= container.height;
          }),
      });
    }
    return output;
  });
  for (const result of results.slice(0, 5)) {
    expect(result.imageFallback).toBe(false);
    expect(result.types).toContain("text");
    expect(result.types).toContain("rectangle");
    expect(result.bytes).toBeGreaterThan(500);
  }
  expect(results[0]!.texts).toContain("Write\nassets");
  expect(results[0]!.multilineFits).toBe(true);
  expect(results[5]!.imageFallback).toBe(true);
  expect(results[5]!.files).toBeGreaterThan(0);
  expect(results[5]!.bytes).toBeGreaterThan(500);
});

async function clipboardScene(page: Page, editor: Locator) {
  await editor.locator(".excalidraw").click({ position: { x: 12, y: 180 } });
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("ControlOrMeta+c");
  return JSON.parse(
    await page.evaluate(() =>
      Promise.race([
        navigator.clipboard.readText(),
        new Promise<string>((_, reject) => setTimeout(() => reject(new Error("Clipboard read timed out")), 3000)),
      ]),
    ),
  ) as {
    elements: Array<{ id: string; type: string; text?: string; x: number; y: number; points?: number[][] }>;
  };
}

test("published diagrams share inline/fullscreen edits, isolate navigation, scroll in view mode and freeze in history", async ({
  page,
  request,
}, info) => {
  test.setTimeout(90_000);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const session = `diagram-editor-${randomUUID()}`;
  const headers = { Authorization: "Bearer 1234" };
  const publish = async () => {
    const key = randomUUID();
    const prepared = await request.post("/api/v1/publications/prepare", {
      headers: { ...headers, "Idempotency-Key": key },
      data: {
        provider: "chatgpt",
        session_id: session,
        title: "Diagram editor acceptance",
        schema_version: 1,
        payload: {
          questions: [1, 2].map((index) => ({
            id: `Q${index}`,
            question: `Diagram question ${index}`,
            explanation_html: `<p>Keep this explanation intact.</p>${figure("flow", "flowchart LR\n A[Start] --> B[Finish]")}${index === 1 ? figure("fallback", 'pie\n "First" : 70\n "Second" : 30') : ""}<p style="height: 600px">More context below.</p><button class="custom-init">Interactive content</button>`,
            init_js:
              'root.querySelector(".custom-init").addEventListener("click", (event) => { event.target.textContent = "Still interactive"; });',
            recommendation: "A",
            options: [{ letter: "A", label: "Proceed", detail: "Continue with this design" }],
          })),
        },
      },
    });
    expect(prepared.ok()).toBeTruthy();
    const { publication } = await prepared.json();
    const committed = await request.post(`/api/v1/publications/${publication.id}/commit`, {
      headers: { ...headers, "Idempotency-Key": key },
      data: {},
    });
    expect(committed.ok(), await committed.text()).toBeTruthy();
    return (await committed.json()).round_id as string;
  };
  try {
    await publish();
    await request.post("/api/v1/access", { data: { code: "1234" } });
    await page.context().addCookies((await request.storageState()).cookies);
    await page.goto(`/?session=${encodeURIComponent(`chatgpt:${session}`)}`);
    const card = page.locator("article.question:visible");
    let editor = card.locator('[data-diagram-editor="flow"]');
    await expect(editor.locator("canvas").first()).toBeVisible({ timeout: 30_000 });
    await expect(editor.getByText("Viewing diagram", { exact: true })).toBeVisible();
    await expect(
      card.locator('[data-diagram-editor="fallback"]').getByText("This diagram is an image.", { exact: false }),
    ).toBeVisible();
    const surface = editor.locator(".diagram-scroll-surface");
    await surface.hover();
    const before = await page.locator(".page").evaluate((element) => element.scrollTop);
    if (info.project.name === "mobile") {
      const touch = await page.context().newCDPSession(page);
      const box = await surface.boundingBox();
      await touch.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: box!.x + box!.width / 2, y: box!.y + 220 }],
      });
      for (const delta of [30, 60, 90, 120, 150])
        await touch.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x: box!.x + box!.width / 2, y: box!.y + 220 - delta }],
        });
      await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } else await page.mouse.wheel(0, 180);
    await expect.poll(() => page.locator(".page").evaluate((element) => element.scrollTop)).toBeGreaterThan(before);
    await editor.getByRole("button", { name: "Edit diagram", exact: true }).click();
    const original = await clipboardScene(page, editor);
    expect(original.elements.filter((element) => element.type === "rectangle")).toHaveLength(2);
    expect(original.elements.filter((element) => element.type === "arrow")).toHaveLength(1);
    // Move the native selection; the board's ArrowRight shortcut must stay out of the editor.
    await page.keyboard.press("ArrowRight");
    const moved = await clipboardScene(page, editor);
    expect(moved.elements[0]!.x).toBeGreaterThan(original.elements[0]!.x);
    await expect(card.getByRole("heading", { name: "Diagram question 1" })).toBeVisible();
    await page.keyboard.press("Escape");
    await editor.screenshot({ path: info.outputPath("before-rename.png") });
    // Double-click the converted node's existing label in the native canvas.
    const nativeCanvas = editor.locator("canvas").last();
    const nativeBounds = await nativeCanvas.boundingBox();
    await nativeCanvas.dblclick({ position: { x: nativeBounds!.width / 2 - 75, y: nativeBounds!.height / 2 } });
    const labelEditor = page.locator("textarea.excalidraw-wysiwyg");
    await expect(labelEditor).toBeVisible();
    await expect(labelEditor).toHaveValue("Start");
    await labelEditor.fill("Revised start");
    await page.keyboard.press("Escape");
    const renamed = await clipboardScene(page, editor);
    const originalLabel = original.elements.find((element) => element.text === "Start")!;
    expect(renamed.elements.find((element) => element.id === originalLabel.id)?.text?.replace(/\s+/gu, " ")).toBe(
      "Revised start",
    );
    await expect(page.getByLabel("Diagram feedback", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("Generated diagram feedback", { exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");
    // Add a native arrow using the editor tool and drag gesture.
    await page.keyboard.press("a");
    const canvasBox = await editor.locator(".excalidraw").boundingBox();
    await page.mouse.move(canvasBox!.x + 70, canvasBox!.y + 150);
    await page.mouse.down();
    await page.mouse.move(canvasBox!.x + 180, canvasBox!.y + 150, { steps: 5 });
    await page.mouse.up();
    await page.keyboard.press("Escape");
    const connected = await clipboardScene(page, editor);
    expect(connected.elements.filter((element) => element.type === "arrow")).toHaveLength(2);
    await page.keyboard.press("Escape");
    // Add a text annotation through the editor's actual tool and text input.
    await page.keyboard.press("t");
    await editor.locator(".excalidraw").click({ position: { x: 80, y: 290 } });
    await page.locator("textarea.excalidraw-wysiwyg").fill("Revised design");
    await page.keyboard.press("Escape");
    const inline = await clipboardScene(page, editor);
    expect(inline.elements.some((element) => element.text === "Revised design")).toBe(true);
    await editor.getByRole("button", { name: "Fullscreen", exact: true }).click();
    editor = page.locator(".diagram-shell.is-fullscreen");
    await expect(editor).toBeVisible();
    const full = await clipboardScene(page, editor);
    expect(full.elements.map((element) => [element.id, element.text, element.x, element.y])).toEqual(
      inline.elements.map((element) => [element.id, element.text, element.x, element.y]),
    );
    await page.keyboard.press("ArrowDown");
    const fullscreenEdit = await clipboardScene(page, editor);
    await editor.getByRole("button", { name: "Close fullscreen", exact: true }).click();
    editor = card.locator('[data-diagram-editor="flow"]');
    expect((await clipboardScene(page, editor)).elements.map((element) => [element.id, element.y])).toEqual(
      fullscreenEdit.elements.map((element) => [element.id, element.y]),
    );
    await editor.getByRole("button", { name: "Done editing", exact: true }).click();
    await card.getByRole("button", { name: "Q2", exact: true }).click();
    await expect(card.getByRole("heading", { name: "Diagram question 2" })).toBeVisible();
    await card.getByRole("button", { name: "Q1", exact: true }).click();
    await editor.getByRole("button", { name: "Edit diagram", exact: true }).click();
    expect((await clipboardScene(page, editor)).elements.some((element) => element.text === "Revised design")).toBe(
      true,
    );
    await editor.getByRole("button", { name: "Done editing", exact: true }).click();
    await card.getByRole("button", { name: "Interactive content", exact: true }).click();
    await expect(card.getByRole("button", { name: "Still interactive", exact: true })).toBeVisible();
    await card.getByRole("radio").first().check();
    await card.getByRole("button", { name: "Review prompt", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Prompt review" })).toBeVisible();
    await page
      .getByRole("dialog", { name: "Prompt review" })
      .getByRole("button", { name: "Back to questions", exact: true })
      .last()
      .click();
    await publish();
    await page.reload();
    const historical = page.locator(".round-card").first();
    await expect(
      historical.locator('[data-diagram-editor="flow"]').getByText("Read only", { exact: true }),
    ).toBeVisible();
    await expect(historical.getByRole("button", { name: "Edit diagram", exact: true })).toHaveCount(0);
    await expect(historical.getByRole("button", { name: "Reset to original", exact: true })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath("historical-diagrams.png"), fullPage: true });
  } finally {
    await request.delete(`/api/v1/sessions/chatgpt/${session}`, { headers });
  }
});
