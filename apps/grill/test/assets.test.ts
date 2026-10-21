import assert from "node:assert/strict";
import { test } from "node:test";
import { assetResponse, mediaMatches } from "../src/lib/grill-assets.server.ts";
import { assetManifestSchema, publicationSchema, MAX_IMAGE_BYTES, MAX_VIDEO_BYTES } from "../src/lib/grill-contract.ts";

const asset = { object_path: "session/publication/digest", media_type: "video/mp4", sha256: "a".repeat(64) };

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
