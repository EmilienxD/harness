import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname } from "node:path";
import { parseMessagesRequest, ScenarioMismatch, transition, type MessagesRequest, type ScenarioResponse, isRecord } from "./scenario.js";

const API_VERSION = "2023-06-01";
const MAX_BODY_BYTES = 32 * 1024 * 1024;

export interface StructuralObservation {
  readonly sequence: number;
  readonly method: string;
  readonly path: string;
  readonly queryKeys: readonly string[];
  readonly sessionHash: string | null;
  readonly anthropicVersion: string | null;
  readonly betaNames: readonly string[];
  readonly model: string | null;
  readonly stream: boolean | null;
  readonly messageRoles: readonly string[];
  readonly contentBlockTypes: readonly string[];
  readonly toolNamesOffered: readonly string[];
  readonly requestBodySha256: string | null;
  readonly requestBytes: number;
  readonly scenario: "single-file-success" | null;
  readonly checkpoint: string | null;
  readonly result: "success" | "rejected";
  readonly httpStatus: number;
  readonly diagnostic?: string;
}

export interface ServerAssertions {
  readonly checkpoints: readonly string[];
  readonly unexpectedRequests: number;
  readonly inferenceRequests: number;
  readonly tokenCountRequests: number;
  readonly observations: readonly StructuralObservation[];
}

export interface FakeAnthropicServer {
  readonly baseUrl: string;
  readonly authToken: string;
  readonly assertions: () => ServerAssertions;
  readonly close: () => Promise<void>;
}

export async function startFakeAnthropicServer(options: {
  readonly repoRoot: string;
  readonly diagnosticsPath?: string;
  readonly readinessPath?: string;
}): Promise<FakeAnthropicServer> {
  const authToken = `aboard-e2e-${randomBytes(24).toString("hex")}`;
  const sessionSalt = randomBytes(32);
  const observations: StructuralObservation[] = [];
  const checkpoints = new Set<string>();
  let unexpectedRequests = 0;
  let inferenceRequests = 0;
  let tokenCountRequests = 0;
  let sequence = 0;

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "HEAD" && url.pathname === "/api/hello") {
      response.writeHead(204).end();
      return;
    }
    if (request.method !== "POST" || (url.pathname !== "/v1/messages" && url.pathname !== "/v1/messages/count_tokens")) {
      unexpectedRequests += 1;
      jsonError(response, 404, "not_found_error", "Unexpected endpoint");
      return;
    }

    let raw: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let parsed: unknown;
    let messageRequest: MessagesRequest | undefined;
    try {
      authenticate(request, authToken);
      requireApiVersion(request);
      raw = await readBody(request);
      parsed = JSON.parse(raw.toString("utf8")) as unknown;
      messageRequest = parseMessagesRequest(parsed, url.pathname === "/v1/messages");
      if (url.pathname === "/v1/messages/count_tokens") {
        tokenCountRequests += 1;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ input_tokens: 1000 }));
        observations.push(observation(request, url, raw, messageRequest, sessionSalt, ++sequence, 200, "success", null, null));
        await persist(options.diagnosticsPath, observations);
        return;
      }

      inferenceRequests += 1;
      const scenarioResponse = transition(messageRequest, options.repoRoot);
      checkpoints.add(scenarioResponse.checkpoint);
      writeMessage(response, messageRequest.model, scenarioResponse, messageRequest.stream);
      observations.push(observation(request, url, raw, messageRequest, sessionSalt, ++sequence, 200, "success", scenarioResponse.checkpoint, null));
      await persist(options.diagnosticsPath, observations);
    } catch (error) {
      unexpectedRequests += 1;
      const status = error instanceof AuthenticationError ? 401 : 400;
      const diagnostic = sanitizeDiagnostic(error);
      jsonError(response, status, status === 401 ? "authentication_error" : "invalid_request_error", diagnostic);
      observations.push(observation(request, url, raw, messageRequest, sessionSalt, ++sequence, status, "rejected", null, diagnostic));
      await persist(options.diagnosticsPath, observations);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  if (options.readinessPath) {
    await mkdir(dirname(options.readinessPath), { recursive: true });
    await writeFile(options.readinessPath, `${JSON.stringify({ port: address.port, processId: process.pid, scenarioCatalogHash: hash("single-file-success:v1"), protocolVersion: 1 }, null, 2)}\n`, "utf8");
  }
  return {
    baseUrl,
    authToken,
    assertions: () => ({
      checkpoints: [...checkpoints], unexpectedRequests, inferenceRequests, tokenCountRequests, observations: [...observations],
    }),
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await persist(options.diagnosticsPath, observations);
    },
  };
}

function authenticate(request: IncomingMessage, expected: string): void {
  const authorization = request.headers.authorization;
  if (authorization !== `Bearer ${expected}`) throw new AuthenticationError("Missing or invalid dummy bearer credential");
  if (request.headers["x-api-key"] !== undefined) throw new AuthenticationError("x-api-key is forbidden in the E2E harness");
}

function requireApiVersion(request: IncomingMessage): void {
  if (request.headers["anthropic-version"] !== API_VERSION) throw new ScenarioMismatch("headers.anthropic-version", `expected ${API_VERSION}`);
}

class AuthenticationError extends Error {}

async function readBody(request: IncomingMessage): Promise<Buffer<ArrayBufferLike>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new ScenarioMismatch("$", "request exceeds 32 MB");
    chunks.push(buffer);
  }
  const contentType = request.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().includes("application/json")) throw new ScenarioMismatch("headers.content-type", "must be application/json");
  return Buffer.concat(chunks);
}

function writeMessage(response: ServerResponse, model: string, value: ScenarioResponse, streaming: boolean): void {
  const usage = { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 16 };
  if (!streaming) {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ id: value.messageId, type: "message", role: "assistant", content: value.content, model, stop_reason: value.stopReason, stop_sequence: null, usage }));
    return;
  }
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  event(response, "message_start", { type: "message_start", message: { id: value.messageId, type: "message", role: "assistant", content: [], model, stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } });
  value.content.forEach((block, index) => {
    if (block.type === "tool_use") {
      event(response, "content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } });
      event(response, "content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
    } else {
      event(response, "content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
      event(response, "content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
    }
    event(response, "content_block_stop", { type: "content_block_stop", index });
  });
  event(response, "message_delta", { type: "message_delta", delta: { stop_reason: value.stopReason, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
  event(response, "message_stop", { type: "message_stop" });
  response.end();
}

function event(response: ServerResponse, name: string, data: unknown): void {
  response.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
}

function jsonError(response: ServerResponse, status: number, type: string, message: string): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ type: "error", error: { type, message }, request_id: `req_e2e_${hash(`${status}:${message}`).slice(0, 16)}` }));
}

function observation(request: IncomingMessage, url: URL, raw: Buffer, body: MessagesRequest | undefined, salt: Buffer, sequence: number, status: number, result: "success" | "rejected", checkpoint: string | null, diagnostic: string | null): StructuralObservation {
  const messages = body?.messages ?? [];
  const blocks = messages.flatMap((message) => Array.isArray(message.content) ? message.content.filter(isRecord) : []);
  const beta = request.headers["anthropic-beta"];
  return {
    sequence, method: request.method ?? "", path: url.pathname, queryKeys: [...url.searchParams.keys()].sort(),
    sessionHash: typeof request.headers["x-claude-code-session-id"] === "string" ? `sha256:${createHash("sha256").update(salt).update(request.headers["x-claude-code-session-id"]).digest("hex")}` : null,
    anthropicVersion: typeof request.headers["anthropic-version"] === "string" ? request.headers["anthropic-version"] : null,
    betaNames: typeof beta === "string" ? beta.split(",").map((item) => item.trim()).filter(Boolean).sort() : [],
    model: body?.model ?? null, stream: body?.stream ?? null,
    messageRoles: messages.map((message) => typeof message.role === "string" ? message.role : "unknown"),
    contentBlockTypes: blocks.map((block) => typeof block.type === "string" ? block.type : "unknown"),
    toolNamesOffered: body?.tools.map((tool) => tool.name).filter((name): name is string => typeof name === "string").sort() ?? [],
    requestBodySha256: raw.length > 0 ? hash(raw) : null, requestBytes: raw.length,
    scenario: body ? "single-file-success" : null, checkpoint, result, httpStatus: status,
    ...(diagnostic ? { diagnostic } : {}),
  };
}

function sanitizeDiagnostic(error: unknown): string {
  if (error instanceof ScenarioMismatch || error instanceof AuthenticationError) return error.message;
  if (error instanceof SyntaxError) return "request body is not valid JSON";
  return "internal structural validation failure";
}

async function persist(path: string | undefined, observations: readonly StructuralObservation[]): Promise<void> {
  if (!path) return;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ schemaVersion: 1, upstreamMode: "forbidden", observations }, null, 2)}\n`, "utf8");
}

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
