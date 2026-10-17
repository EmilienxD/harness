import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname } from "node:path";

const MAX_BODY_BYTES = 32 * 1024 * 1024;

export interface OpenAiResponsesRequest {
  readonly model: string;
  readonly instructions?: unknown;
  readonly input: readonly Record<string, unknown>[];
  readonly tools: readonly Record<string, unknown>[];
  readonly codeMode: boolean;
  readonly sessionId: string | null;
  readonly requestKind: string | null;
}

export type OpenAiResponseOutput =
  | { readonly type: "function_call"; readonly id: string; readonly call_id: string; readonly name: string; readonly arguments: string; readonly status: "completed" }
  | { readonly type: "custom_tool_call"; readonly id: string; readonly call_id: string; readonly name: string; readonly input: string; readonly status: "completed" }
  | { readonly type: "message"; readonly id: string; readonly role: "assistant"; readonly status: "completed"; readonly content: readonly [{ readonly type: "output_text"; readonly text: string; readonly annotations: readonly [] }] };

export interface OpenAiScenarioResponse {
  readonly scenario: string;
  readonly checkpoint: string;
  readonly output: OpenAiResponseOutput;
}

export class OpenAiProtocolError extends Error {
  constructor(readonly field: string, detail: string, scenario = "request") {
    super(`scenario ${scenario} at ${field}: ${detail}`);
    this.name = "OpenAiProtocolError";
  }
}

export async function startFakeOpenAiServer(options: {
  readonly diagnosticsPath?: string;
  readonly scenarioCatalogHash: string;
  readonly transition: (request: OpenAiResponsesRequest) => OpenAiScenarioResponse | Promise<OpenAiScenarioResponse>;
}) {
  const authToken = `harness-e2e-${randomBytes(24).toString("hex")}`;
  const sessionSalt = randomBytes(32);
  const observations: Record<string, unknown>[] = [];
  const checkpoints = new Set<string>();
  let unexpectedRequests = 0;
  let inferenceRequests = 0;
  let sequence = 0;
  const pending = new Set<Promise<void>>();
  let diagnosticsFailed = false;
  await persist(options.diagnosticsPath, observations);

  const server = createServer((request, response) => {
    const task = handleRequest(request, response);
    pending.add(task);
    void task.catch(() => { diagnosticsFailed = true; }).finally(() => pending.delete(task));
  });

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    let raw: Buffer = Buffer.alloc(0);
    let body: OpenAiResponsesRequest | undefined;
    try {
      if (request.method !== "POST" || url.pathname !== "/v1/responses") {
        throw new OpenAiProtocolError("request.path", "expected POST /v1/responses");
      }
      if (request.headers.authorization !== `Bearer ${authToken}`) {
        throw new OpenAiProtocolError("headers.authorization", "missing or invalid dummy bearer credential");
      }
      raw = await readBody(request);
      body = parseRequest(JSON.parse(raw.toString("utf8")) as unknown);
      inferenceRequests += 1;
      const result = await options.transition(body);
      checkpoints.add(result.checkpoint);
      writeResponse(response, body.model, raw, result.output);
      observations.push(observation(request, url, raw, body, sessionSalt, ++sequence, 200, "success", result.scenario, result.checkpoint));
    } catch (error) {
      unexpectedRequests += 1;
      const diagnostic = error instanceof OpenAiProtocolError ? error.message : error instanceof SyntaxError ? "request body is not valid JSON" : "internal structural validation failure";
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { type: "invalid_request_error", message: diagnostic } }));
      observations.push(observation(request, url, raw, body, sessionSalt, ++sequence, 400, "rejected", null, null, diagnostic));
    }
    await persist(options.diagnosticsPath, observations);
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    authToken,
    assertions: () => ({ checkpoints: [...checkpoints], unexpectedRequests, inferenceRequests, observations: [...observations] }),
    close: async () => {
      const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      server.closeAllConnections();
      await closed;
      await Promise.all([...pending]);
      if (diagnosticsFailed) throw new Error("OpenAI E2E structural diagnostics could not be persisted");
      await persist(options.diagnosticsPath, observations);
    },
  };
}

function parseRequest(value: unknown): OpenAiResponsesRequest {
  const body = record(value, "$");
  if (typeof body.model !== "string" || body.model.length === 0) throw new OpenAiProtocolError("$.model", "must be a nonempty string");
  if (body.stream !== true) throw new OpenAiProtocolError("$.stream", "must be true");
  if (body.store !== false) throw new OpenAiProtocolError("$.store", "must be false");
  if (!Array.isArray(body.input)) throw new OpenAiProtocolError("$.input", "must be an array");
  if (body.tools !== undefined && !Array.isArray(body.tools)) throw new OpenAiProtocolError("$.tools", "must be an array when present");
  const input = body.input.map((item, index) => record(item, `$.input[${index}]`));
  const topLevelTools = (body.tools ?? []).map((item, index) => record(item, `$.tools[${index}]`));
  const additionalTools = input.flatMap((item, index) => {
    if (item.type !== "additional_tools") return [];
    if (!Array.isArray(item.tools)) throw new OpenAiProtocolError(`$.input[${index}].tools`, "must be an array");
    return item.tools.map((tool, toolIndex) => record(tool, `$.input[${index}].tools[${toolIndex}]`));
  });
  const metadata = recordOrEmpty(body.client_metadata);
  let sessionId: string | null = null;
  let requestKind: string | null = null;
  const encoded = metadata["x-codex-turn-metadata"];
  if (typeof encoded === "string") {
    const turn = record(JSON.parse(encoded) as unknown, "$.client_metadata.x-codex-turn-metadata");
    sessionId = typeof turn.session_id === "string" ? turn.session_id : null;
    requestKind = typeof turn.request_kind === "string" ? turn.request_kind : null;
  }
  return {
    model: body.model,
    ...(body.instructions !== undefined ? { instructions: body.instructions } : {}),
    input,
    tools: [...topLevelTools, ...additionalTools],
    codeMode: additionalTools.length > 0,
    sessionId,
    requestKind,
  };
}

function writeResponse(response: ServerResponse, model: string, raw: Buffer, output: OpenAiResponseOutput): void {
  const responseId = `resp_${hash(raw).slice(0, 24)}`;
  const usage = { input_tokens: 100, input_tokens_details: { cached_tokens: 0 }, output_tokens: 16, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 116 };
  const completed = {
    id: responseId, object: "response", created_at: 0, status: "completed", error: null, incomplete_details: null,
    instructions: null, model, output: [output], parallel_tool_calls: false, previous_response_id: null,
    reasoning: { effort: null, summary: null }, store: false, temperature: 1, text: { format: { type: "text" } },
    tool_choice: "auto", tools: [], top_p: 1, truncation: "disabled", usage, metadata: {},
  };
  const pending = { ...completed, status: "in_progress", output: [], usage: null };
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  event(response, { type: "response.created", response: pending });
  event(response, { type: "response.in_progress", response: pending });
  event(response, {
    type: "response.output_item.added", output_index: 0,
    item: output.type === "function_call" ? { ...output, status: "in_progress", arguments: "" }
      : output.type === "message" ? { ...output, status: "in_progress", content: [] }
      : { ...output, status: "in_progress" },
  });
  if (output.type === "function_call") {
    event(response, { type: "response.function_call_arguments.delta", item_id: output.id, output_index: 0, delta: output.arguments });
    event(response, { type: "response.function_call_arguments.done", item_id: output.id, output_index: 0, arguments: output.arguments });
  } else if (output.type === "message") {
    const part = output.content[0];
    event(response, { type: "response.content_part.added", item_id: output.id, output_index: 0, content_index: 0, part: { ...part, text: "" } });
    event(response, { type: "response.output_text.delta", item_id: output.id, output_index: 0, content_index: 0, delta: part.text });
    event(response, { type: "response.output_text.done", item_id: output.id, output_index: 0, content_index: 0, text: part.text });
    event(response, { type: "response.content_part.done", item_id: output.id, output_index: 0, content_index: 0, part });
  }
  event(response, { type: "response.output_item.done", output_index: 0, item: output });
  event(response, { type: "response.completed", response: completed });
  response.write("data: [DONE]\n\n");
  response.end();
}

function event(response: ServerResponse, value: Record<string, unknown>): void {
  response.write(`event: ${String(value.type)}\ndata: ${JSON.stringify(value)}\n\n`);
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  if (!(request.headers["content-type"] ?? "").toLowerCase().includes("application/json")) throw new OpenAiProtocolError("headers.content-type", "must be application/json");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new OpenAiProtocolError("$", "request exceeds 32 MB");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function observation(request: IncomingMessage, url: URL, raw: Buffer, body: OpenAiResponsesRequest | undefined, salt: Buffer, sequence: number, httpStatus: number, result: "success" | "rejected", scenario: string | null, checkpoint: string | null, diagnostic?: string): Record<string, unknown> {
  return {
    sequence, method: request.method ?? "", path: url.pathname, model: body?.model ?? null,
    sessionHash: body?.sessionId ? `sha256:${createHash("sha256").update(salt).update(body.sessionId).digest("hex")}` : null,
    requestKind: body?.requestKind ?? null, inputTypes: body?.input.map((item) => typeof item.type === "string" ? item.type : "unknown") ?? [],
    toolNamesOffered: body?.tools.flatMap((tool) => typeof tool.name === "string" ? [tool.name] : []) ?? [],
    requestBodySha256: raw.length ? hash(raw) : null, requestBytes: raw.length, scenario, checkpoint, result, httpStatus,
    ...(diagnostic ? { diagnostic } : {}),
  };
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new OpenAiProtocolError(path, "must be an object");
  return value as Record<string, unknown>;
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function persist(path: string | undefined, observations: readonly Record<string, unknown>[]): Promise<void> {
  if (!path) return;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ schemaVersion: 1, upstreamMode: "forbidden", protocol: "openai-responses", observations }, null, 2)}\n`, "utf8");
}

function hash(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
