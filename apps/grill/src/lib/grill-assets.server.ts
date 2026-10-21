type Asset = { object_path: string; media_type: string; sha256: string };
type Storage = {
  createSignedUrl(path: string, expiresIn: number): Promise<{ data: { signedUrl: string } | null; error: unknown }>;
  download(path: string): Promise<{ data: Blob | null; error: unknown }>;
};

export async function assetResponse(asset: Asset, storage: Storage, method: string): Promise<Response> {
  const unavailable = () =>
    Response.json(
      { error: { code: "asset_missing", message: "Asset is unavailable." } },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  if (asset.media_type.startsWith("video/")) {
    // Storage handles ranges and seeking directly; video bytes never pass through a Vercel response.
    const { data, error } = await storage.createSignedUrl(asset.object_path, 60 * 60);
    if (error || !data) return unavailable();
    return new Response(null, {
      status: 307,
      headers: { Location: data.signedUrl, "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" },
    });
  }
  const { data, error } = await storage.download(asset.object_path);
  if (error || !data) return unavailable();
  return new Response(method === "HEAD" ? null : data, {
    headers: { "Content-Type": asset.media_type, "Cache-Control": "private, no-store", ETag: `"${asset.sha256}"` },
  });
}

/** Container signatures complement the publisher's local FFmpeg validation. */
export function mediaMatches(bytes: Buffer, type: string): boolean {
  if (type === "video/mp4")
    return (
      bytes.length >= 16 &&
      bytes.subarray(4, 8).toString("ascii") === "ftyp" &&
      ["isom", "iso2", "iso3", "iso4", "iso5", "iso6", "iso8", "iso9", "mp41", "mp42", "avc1", "M4V ", "dash"].includes(
        bytes.subarray(8, 12).toString("ascii"),
      )
    );
  if (type === "video/webm")
    return (
      bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) &&
      bytes.subarray(0, 4096).includes(Buffer.from("webm"))
    );
  if (type === "image/png") return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (type === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (type === "image/gif") return ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"));
  if (type === "image/webp")
    return bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  if (type === "image/avif")
    return (
      bytes.subarray(4, 8).toString("ascii") === "ftyp" &&
      ["avif", "avis"].includes(bytes.subarray(8, 12).toString("ascii"))
    );
  if (type === "image/svg+xml") return /<svg(?:\s|>)/iu.test(bytes.subarray(0, 4096).toString("utf8"));
  return false;
}
