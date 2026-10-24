import { execFile, execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";

test("the shipped publisher uploads every dynamic preview and the board renders each selection", async ({
  page,
  request,
  baseURL,
}, info) => {
  test.skip(info.project.name !== "desktop", "Publication is viewport independent");
  test.setTimeout(120_000);
  const session = `dynamic-media-${randomUUID()}`;
  const directory = await mkdtemp(join(tmpdir(), "grill-dynamic-media-"));
  const headers = { Authorization: "Bearer 1234" };
  const publisher = `
import json,struct,sys,zlib
from pathlib import Path
sys.path.insert(0, str(Path('harness/planning/grill-me-in-cloud').resolve()))
from grill_me_in_cloud_hook import HostedClient, InterviewRuntime
root=Path(sys.argv[1])
project=root/'project'
project.mkdir()
runtime=InterviewRuntime(root/'runtime', HostedClient(sys.argv[2], '1234'))
interview=runtime.start('chatgpt', sys.argv[3], project)
references=[interview.assets_url+f'preview-{index}.png' for index in range(23)]
def chunk(tag,body):
 return struct.pack('>I',len(body))+tag+body+struct.pack('>I',zlib.crc32(tag+body))
for index,reference in enumerate(references):
 pixels=(b'\\x00'+bytes([index*10,100,200])*2)*2
 png=b'\\x89PNG\\r\\n\\x1a\\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',2,2,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(pixels))+chunk(b'IEND',b'')
 (interview.directory/reference).write_bytes(png)
html='<label for="Q1-preview">Preview</label><select id="Q1-preview">'+''.join(f'<option value="{ref}">Preview {index}</option>' for index,ref in enumerate(references[:21]))+'</select>'
html+=f'<a data-full href="{references[0]}"><img src="{references[0]}" alt="Selected preview"></a>'
html+=f'<a data-link-only href="{references[21]}">Linked preview</a><button data-preview="{references[22]}">Lazy preview</button>'
js="const select=root.querySelector('select'); const show=url=>{root.querySelector('img').src=url;root.querySelector('[data-full]').href=url;}; select.addEventListener('change',()=>show(select.value)); root.querySelector('button').addEventListener('click',e=>show(e.currentTarget.dataset.preview));"
payload={'questions':[{'id':'Q1','question':'Compare previews','explanation_html':html,'init_js':js,'recommendation':'A','options':[{'letter':'A','label':'Continue','detail':'Use this layout'}]}]}
interview.source.write_text(json.dumps(payload),encoding='utf-8')
print(json.dumps(runtime.publish('chatgpt', sys.argv[3])))
`;
  try {
    const result = await promisify(execFile)("uv", ["run", "python", "-c", publisher, directory, baseURL!, session], {
      cwd: resolve("../.."),
      windowsHide: true,
      timeout: 60_000,
    });
    const { round_id: roundId } = JSON.parse(result.stdout);
    const response = await request.get(`/api/v1/rounds/${roundId}`, { headers });
    expect(response.ok()).toBeTruthy();
    const { round } = await response.json();
    expect(round.assets).toHaveLength(23);
    const access = await request.post("/api/v1/access", { data: { code: "1234" } });
    expect(access.ok()).toBeTruthy();
    await page.context().addCookies((await request.storageState()).cookies);
    await page.goto(`/?session=${encodeURIComponent(`chatgpt:${session}`)}`);
    const card = page.locator("article.question:visible");
    const select = card.getByLabel("Preview", { exact: true });
    await expect(select.locator("option")).toHaveCount(21);
    const choices = await select
      .locator("option")
      .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
    expect(choices).toHaveLength(21);
    const image = card.getByRole("img", { name: "Selected preview" });
    for (const value of choices) {
      expect(value).toMatch(/^\/api\/v1\/assets\/[0-9a-f-]+$/u);
      await select.selectOption(value);
      await expect(image).toHaveAttribute("src", value);
      await expect(card.locator("[data-full]")).toHaveAttribute("href", value);
      await expect
        .poll(() =>
          image.evaluate((img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth),
        )
        .toBe(2);
    }
    await card.getByRole("button", { name: "Lazy preview" }).click();
    const lazy = await card.locator("button[data-preview]").getAttribute("data-preview");
    expect(lazy).toMatch(/^\/api\/v1\/assets\/[0-9a-f-]+$/u);
    await expect(image).toHaveAttribute("src", lazy!);
    await expect
      .poll(() => image.evaluate((img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth))
      .toBe(2);
    const linked = await card.getByRole("link", { name: "Linked preview" }).getAttribute("href");
    expect(linked).toMatch(/^\/api\/v1\/assets\/[0-9a-f-]+$/u);
    const fullSize = await request.get(linked!);
    expect(fullSize.ok()).toBeTruthy();
    expect(fullSize.headers()["content-type"]).toBe("image/png");
  } finally {
    const removed = await request.delete(`/api/v1/sessions/chatgpt/${session}`, { headers });
    expect([200, 404]).toContain(removed.status());
    expect(resolve(directory).startsWith(resolve(tmpdir()) + sep)).toBeTruthy();
    expect(basename(directory).startsWith("grill-dynamic-media-")).toBeTruthy();
    await rm(directory, { recursive: true, force: true });
  }
});

test("prepare and legacy commit reject missing dropdown assets before making a round visible", async ({
  request,
}, info) => {
  test.skip(info.project.name !== "desktop", "Publication is viewport independent");
  const local = JSON.parse(execSync("npx supabase status -o json", { encoding: "utf8" }));
  expect(["127.0.0.1", "localhost"]).toContain(new URL(local.API_URL).hostname);
  const admin = createClient(local.API_URL, local.SERVICE_ROLE_KEY);
  const session = `incomplete-media-${randomUUID()}`;
  const headers = { Authorization: "Bearer 1234", "Idempotency-Key": randomUUID() };
  const question = {
    id: "Q1",
    question: "Choose a preview",
    explanation_html: "<p>Choose a preview.</p>",
    recommendation: "A",
    options: [{ letter: "A", label: "Continue", detail: "Use this layout" }],
  };
  const broken = {
    ...question,
    explanation_html: '<select><option value="assets/round-001/missing.png">Alternate</option></select>',
  };
  const publication = {
    provider: "chatgpt",
    session_id: session,
    schema_version: 1,
    payload: { questions: [question] },
  };
  let publicationId: string | undefined;
  try {
    const rejected = await request.post("/api/v1/publications/prepare", {
      headers,
      data: { ...publication, payload: { questions: [broken] } },
    });
    expect(rejected.status()).toBe(422);
    expect((await rejected.json()).error.code).toBe("invalid_payload");
    const prepared = await request.post("/api/v1/publications/prepare", { headers, data: publication });
    expect(prepared.ok()).toBeTruthy();
    publicationId = (await prepared.json()).publication.id;
    // Recreate a publication accepted by the old server without uploading an unrelated file.
    const { error } = await admin
      .from("grill_publications")
      .update({ original_payload: { payload: { questions: [broken] } } })
      .eq("id", publicationId!)
      .eq("provider_session_id", session);
    expect(error).toBeNull();
    const committed = await request.post(`/api/v1/publications/${publicationId}/commit`, { headers, data: {} });
    expect(committed.status()).toBe(422);
    expect((await committed.json()).error.code).toBe("invalid_payload");
    const visible = await request.get(`/api/v1/sessions/chatgpt/${session}`, { headers });
    expect(visible.status()).toBe(404);
  } finally {
    if (publicationId) {
      const { error } = await admin
        .from("grill_publications")
        .delete()
        .eq("id", publicationId)
        .eq("provider_session_id", session);
      expect(error).toBeNull();
    }
  }
});
