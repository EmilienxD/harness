import assert from "node:assert/strict";
import { test } from "node:test";
import { assetResponse, mediaMatches } from "../src/lib/grill-assets.server.ts";
import { assetManifestSchema, publicationSchema, MAX_IMAGE_BYTES, MAX_VIDEO_BYTES } from "../src/lib/grill-contract.ts";
import { localAssetReferences } from "../src/lib/grill-media.ts";

const asset = { object_path: "session/publication/digest", media_type: "video/mp4", sha256: "a".repeat(64) };

function imagePublication(html: string, references: string[]) {
  return {
    provider: "chatgpt",
    session_id: "dynamic-previews",
    schema_version: 1,
    payload: {
      questions: [
        {
          id: "Q1",
          question: "Choose a preview",
          explanation_html: html,
          recommendation: "A",
          options: [{ letter: "A", label: "Continue", detail: "Use this layout" }],
        },
      ],
    },
    assets: references.map((reference) => ({
      reference,
      media_type: "image/png",
      byte_size: 100,
      sha256: asset.sha256,
    })),
  };
}

test("publication requires assets used only by dropdowns, full-size links, or lazy previews", () => {
  for (const html of [
    '<select><option value="A">Choice</option><option value="assets/round-001/alternate.png">Preview</option></select>',
    '<a href="assets/round-001/alternate.png">Full size</a>',
    '<button data-preview="assets/round-001/alternate.png">Load preview</button>',
  ]) {
    assert.equal(publicationSchema.safeParse(imagePublication(html, [])).success, false);
    assert.equal(publicationSchema.safeParse(imagePublication(html, ["assets/round-001/alternate.png"])).success, true);
  }
});

test("media validation decodes attributes and srcsets while ignoring escaped examples and external URLs", () => {
  const html =
    '<picture><source srcset="data:image/png;base64,AAAA 1x, assets/round-001/a&amp;b.png 2x">' +
    '<img src="https://example.test/image.png"></picture>' +
    '<option value="assets/round-001/a&amp;b.png">Same image</option>' +
    '<pre>&lt;img src="assets/round-001/example.png"&gt;</pre>';
  assert.deepEqual(localAssetReferences(html), ["assets/round-001/a&b.png"]);
  assert.equal(publicationSchema.safeParse(imagePublication(html, [])).success, false);
  assert.equal(publicationSchema.safeParse(imagePublication(html, ["assets/round-001/a&b.png"])).success, true);
});

test("publication accepts 30 media references and rejects a 31st", () => {
  const references = Array.from({ length: 30 }, (_, index) => `assets/round-001/preview-${index}.png`);
  const html = "<select>" + references.map((ref) => `<option value="${ref}">Preview</option>`).join("") + "</select>";
  assert.equal(publicationSchema.safeParse(imagePublication(html, references)).success, true);
  assert.equal(
    publicationSchema.safeParse(imagePublication(html, [...references, "assets/round-001/extra.png"])).success,
    false,
  );
});

for (const method of ["GET", "HEAD"]) {
  test(`video ${method} redirects to private Storage without downloading video through the app`, async () => {
    const response = await assetResponse(
      asset,
      {
        async createSignedUrl(path, expiresIn) {
          assert.equal(path, asset.object_path);
          assert.equal(expiresIn, 3600);
          return { data: { signedUrl: "https://storage.example/video?token=temporary" }, error: null };
        },
        async download() {
          throw new Error("Video bytes must bypass the app");
        },
      },
      method,
    );
    assert.equal(response.status, 307);
    assert.equal(response.headers.get("location"), "https://storage.example/video?token=temporary");
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.body, null);
  });
}

test("unavailable private playback returns an uncached error", async () => {
  const response = await assetResponse(
    asset,
    {
      async createSignedUrl() {
        return { data: null, error: new Error("Storage unavailable") };
      },
      async download() {
        throw new Error("Unexpected download");
      },
    },
    "GET",
  );
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("image responses retain their content type and checksum", async () => {
  const storage = {
    async createSignedUrl() {
      throw new Error("Images keep their existing delivery");
    },
    async download() {
      return { data: new Blob(["image bytes"]), error: null };
    },
  };
  const response = await assetResponse({ ...asset, media_type: "image/png" }, storage, "GET");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(response.headers.get("etag"), `"${asset.sha256}"`);
  assert.equal(await response.text(), "image bytes");
  assert.equal((await assetResponse({ ...asset, media_type: "image/png" }, storage, "HEAD")).body, null);
});

test("publication accepts bounded videos while retaining the smaller image limit", () => {
  const manifest = {
    reference: "assets/round-001/demo.mp4",
    media_type: "video/mp4",
    byte_size: MAX_VIDEO_BYTES,
    sha256: asset.sha256,
  };
  assert.equal(assetManifestSchema.safeParse(manifest).success, true);
  assert.equal(assetManifestSchema.safeParse({ ...manifest, media_type: "video/webm" }).success, true);
  assert.equal(assetManifestSchema.safeParse({ ...manifest, byte_size: MAX_VIDEO_BYTES + 1 }).success, false);
  assert.equal(
    assetManifestSchema.safeParse({ ...manifest, media_type: "image/png", byte_size: MAX_IMAGE_BYTES + 1 }).success,
    false,
  );
  const publication = {
    provider: "claude",
    session_id: "session",
    schema_version: 1,
    payload: {
      questions: [
        {
          id: "Q1",
          question: "Choose?",
          explanation_html: "<video></video>",
          recommendation: "A",
          options: [{ letter: "A", label: "A", detail: "A" }],
        },
      ],
    },
    assets: [manifest, { ...manifest, reference: "assets/round-001/second.mp4" }],
  };
  assert.equal(publicationSchema.safeParse(publication).success, true);
  assert.equal(
    publicationSchema.safeParse({
      ...publication,
      assets: [...publication.assets, { ...manifest, reference: "assets/round-001/third.mp4" }],
    }).success,
    false,
  );
});

test("video signatures reject images, other containers, and truncated headers", () => {
  assert.equal(mediaMatches(Buffer.from("0000ftypisom0000"), "video/mp4"), true);
  assert.equal(mediaMatches(Buffer.from("0000ftypavif0000"), "video/mp4"), false);
  assert.equal(mediaMatches(Buffer.from("0000ftypisom"), "video/mp4"), false);
  assert.equal(mediaMatches(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, ...Buffer.from("webm")]), "video/webm"), true);
  assert.equal(mediaMatches(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, ...Buffer.from("matroska")]), "video/webm"), false);
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(mediaMatches(png, "image/png"), true);
  assert.equal(mediaMatches(png, "video/mp4"), false);
  assert.equal(mediaMatches(png, "video/webm"), false);
});
