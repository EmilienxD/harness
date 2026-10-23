import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Duplex } from "node:stream";

/** Replace only Discord's HTTPS boundary. Real urllib and TLS validation stay intact. */
export async function startDiscordFixture(root: string) {
  const key = join(root, "discord-key.pem");
  const cert = join(root, "discord-cert.pem");
  await promisify(execFile)("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert,
    "-subj", "/CN=discord.com", "-addext", "subjectAltName=DNS:discord.com", "-days", "1"], { windowsHide: true, timeout: 15_000 });
  const accepted: Array<{ content: string; allowed_mentions: { parse: string[] } }> = [];
  let attempts = 0;
  let rejectAfter = Infinity;
  let rateLimit = false;
  let rateLimits = 0;
  let unexpected = 0;
  const sockets = new Set<Duplex>();
  const tls = createHttpsServer({ key: await readFile(key), cert: await readFile(cert) }, async (req, res) => {
    if (req.method !== "POST" || req.url !== "/api/webhooks/fixture/dummy?wait=true") { unexpected++; res.writeHead(400).end(); return; }
    let body = "";
    for await (const chunk of req) { body += chunk; if (body.length > 20_000) { req.destroy(); return; } }
    let payload: { content: string; allowed_mentions: { parse: string[] } };
    try {
      payload = JSON.parse(body);
      if (typeof payload.content !== "string" || JSON.stringify(payload.allowed_mentions) !== '{"parse":[]}') throw new Error("shape");
    } catch { unexpected++; res.writeHead(400).end(); return; }
    attempts++;
    res.setHeader("Content-Type", "application/json");
    if (rateLimit) { rateLimit = false; rateLimits++; res.writeHead(429).end('{"retry_after":0.1}'); return; }
    if (accepted.length >= rejectAfter) { res.writeHead(400).end('{}'); return; }
    accepted.push(payload);
    res.end('{"id":"fixture"}');
  });
  tls.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise<void>((resolve) => tls.listen(0, "127.0.0.1", resolve));
  const tlsPort = (tls.address() as { port: number }).port;
  const proxy = createHttpServer((_req, res) => { unexpected++; res.writeHead(400).end(); });
  proxy.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  proxy.on("connect", (req, socket, head) => {
    if (req.url !== "discord.com:443") { unexpected++; socket.destroy(); return; }
    const upstream = connect(tlsPort, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
    });
    socket.on("error", () => upstream.destroy());
    upstream.on("error", () => socket.destroy());
    socket.on("close", () => upstream.destroy());
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  return {
    url: "https://discord.com/api/webhooks/fixture/dummy",
    env: { HTTPS_PROXY: `http://127.0.0.1:${(proxy.address() as { port: number }).port}`, SSL_CERT_FILE: cert },
    accepted,
    get attempts() { return attempts; }, get rateLimits() { return rateLimits; }, get unexpected() { return unexpected; },
    failAfter(count: number) { rejectAfter = count; },
    recover() { rejectAfter = Infinity; },
    rateLimitOnce() { rateLimit = true; },
    async close() {
      for (const socket of sockets) socket.destroy();
      await Promise.all([new Promise<void>((resolve) => proxy.close(() => resolve())), new Promise<void>((resolve) => tls.close(() => resolve()))]);
    },
  };
}
