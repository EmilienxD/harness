import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export const PAGE = "# Fixture guide\n\nUnicode café 雪. Read the source before citing it.\n";
export const LONG = PAGE + Array.from({ length: 180 }, (_, n) => `\n## Section ${n}\n${"Details about the web toolkit. ".repeat(12)}\n`).join("");

/** Real HTTP fetches; Chrome's search-engine navigation is fulfilled at the network boundary. */
export async function startWebFixture() {
  const requests: string[] = [];
  let slowStarted!: () => void;
  let slowClosed!: () => void;
  const slow = new Promise<void>((resolve) => { slowStarted = resolve; });
  const disconnected = new Promise<void>((resolve) => { slowClosed = resolve; });
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    requests.push(path);
    if (path === "/slow") { res.on("close", slowClosed); slowStarted(); return; }
    if (path === "/redirect") { res.writeHead(302, { location: "/page" }); res.end(); return; }
    res.writeHead(path === "/missing" ? 404 : 200, { "content-type": "text/markdown; charset=utf-8" });
    res.end(path === "/long" ? LONG : path === "/missing" ? "Missing fixture page.\n" : PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin, requests, slow, disconnected,
    async close() {
      const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      server.closeAllConnections(); await closed;
    },
  };
}

/** Attach to the actual toolkit-owned Chrome, preserving real CLI extraction and filtering. */
export async function interceptSearch(endpoint: string, origin: string) {
  const socket = new WebSocket(endpoint);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("Search fixture CDP connection failed")), { once: true });
  });
  let sequence = 0;
  const queries: string[] = [];
  let failure = false;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  function call(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const deadline = setTimeout(() => { pending.delete(id); reject(new Error("Search fixture CDP deadline exceeded")); }, 10_000);
      deadline.unref();
      pending.set(id, { resolve(value) { clearTimeout(deadline); resolve(value); }, reject(error) { clearTimeout(deadline); reject(error); } });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id) {
      const waiter = pending.get(message.id); pending.delete(message.id);
      if (message.error) waiter?.reject(new Error("Search fixture CDP command failed"));
      else waiter?.resolve(message.result);
      return;
    }
    void (async () => {
      if (message.method === "Target.attachedToTarget") {
        const session = message.params.sessionId;
        await call("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, session);
        await call("Runtime.runIfWaitingForDebugger", {}, session);
      }
      if (message.method === "Fetch.requestPaused") {
        const { requestId, request } = message.params;
        const url = new URL(request.url);
        const search = url.hostname === "duckduckgo.com" && url.searchParams.has("q");
        if (search) queries.push(url.searchParams.get("q")!);
        const body = search ? `<html><head><title>Toolkit results</title></head><body>
          <article data-testid="result"><h2><a href="${origin}/page">Toolkit café 雪 guide</a></h2><div data-result="snippet">Toolkit source snippet.</div></article>
          <article data-testid="result"><h2><a href="https://excluded.invalid/page">Toolkit excluded result</a></h2></article>
          <article data-testid="result"><h2><a href="https://docs.example.test/page">Toolkit docs</a></h2></article>
          <article data-testid="result"><h2><a href="https://sub.docs.example.test/page">Toolkit subdomain</a></h2></article>
          <article data-testid="result"><h2><a href="https://other.example.test/page">Toolkit other domain</a></h2></article>
          <article data-testid="result"><h2><a href="https://blocked.docs.example.test/page">Toolkit blocked subdomain</a></h2></article>
          </body></html>` : "";
        await call("Fetch.fulfillRequest", {
          requestId, responseCode: search ? 200 : 404,
          responseHeaders: [{ name: "Content-Type", value: "text/html; charset=utf-8" }],
          body: Buffer.from(body).toString("base64"),
        }, message.sessionId);
      }
    })().catch(() => { failure = true; });
  });
  await call("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: "page" }] });
  return {
    assertions(expectedQueries: readonly string[]) {
      assert.equal(failure, false); assert.equal(queries.length, expectedQueries.length);
      assert.ok(queries.every((query, index) => query === expectedQueries[index]));
      return { searches: queries.length };
    },
    async close() {
      try { await call("Browser.close"); } finally { socket.close(); }
    },
  };
}
