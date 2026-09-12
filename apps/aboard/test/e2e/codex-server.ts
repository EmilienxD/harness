import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { AFTER_CONTENT, AUTO_RUN_AFK_MARKER, AUTO_RUN_EXPLORE_REPORT, AUTO_RUN_FOLLOWUP_MARKER, AUTO_RUN_HITL_MARKER, AUTO_RUN_NESTED_CONTEXT, AUTO_RUN_PERMANENT_NOTE, BEFORE_CONTENT, FINAL_RESPONSE, HITL_ACCEPT_PROMPT, WORKER_COMMIT_COMMAND } from "./scenario.js";

const MAX_BODY_BYTES = 32 * 1024 * 1024;

type CodexScenario = "attended" | "explore" | "implement" | "review-approve" | "review-changes" | "process-failure" | "auto-run-afk" | "auto-run-hitl" | "auto-run-followup";

interface ResponsesRequest {
  readonly model: string;
  readonly stream: true;
  readonly store: false;
  readonly input: readonly Record<string, unknown>[];
  readonly tools: readonly Record<string, unknown>[];
  readonly codeMode: boolean;
  readonly sandboxMode: string | null;
  readonly sessionId: string | null;
  readonly requestKind: string | null;
  readonly outputSchemaProperties: readonly string[];
  readonly outputSchema: Record<string, unknown> | null;
}

export interface CodexStructuralObservation {
  readonly sequence: number;
  readonly method: string;
  readonly path: string;
  readonly model: string | null;
  readonly stream: boolean | null;
  readonly store: boolean | null;
  readonly sandboxMode: string | null;
  readonly sessionHash: string | null;
  readonly requestKind: string | null;
  readonly inputTypes: readonly string[];
  readonly toolNamesOffered: readonly string[];
  readonly requestBodySha256: string | null;
  readonly requestBytes: number;
  readonly scenario: CodexScenario | null;
  readonly checkpoint: string | null;
  readonly result: "success" | "rejected";
  readonly httpStatus: number;
  readonly diagnostic?: string;
}

export interface FakeOpenAiServer {
  readonly baseUrl: string;
  readonly authToken: string;
  readonly assertions: () => {
    readonly checkpoints: readonly string[];
    readonly inferenceRequests: number;
    readonly unexpectedRequests: number;
    readonly observations: readonly CodexStructuralObservation[];
  };
  readonly close: () => Promise<void>;
}

export async function startFakeOpenAiServer(options: { readonly diagnosticsPath?: string; readonly repoRoot?: string; readonly resolveRepoRoot?: () => Promise<string> }): Promise<FakeOpenAiServer> {
  const authToken = `aboard-e2e-${randomBytes(24).toString("hex")}`;
  const sessionSalt = randomBytes(32);
  const observations: CodexStructuralObservation[] = [];
  const checkpoints = new Set<string>();
  let inferenceRequests = 0;
  let unexpectedRequests = 0;
  let sequence = 0;
  await persist(options.diagnosticsPath, observations);

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    let raw: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let body: ResponsesRequest | undefined;
    let scenario: CodexScenario | null = null;
    let checkpoint: string | null = null;
    try {
      if (request.method !== "POST" || url.pathname !== "/v1/responses") throw new ProtocolMismatch("request.path", "expected POST /v1/responses");
      authenticate(request, authToken);
      raw = await readBody(request);
      body = parseRequest(JSON.parse(raw.toString("utf8")) as unknown);
      const structuredRequest = body.requestKind === "turn" && body.outputSchema !== null;
      if (structuredRequest || !body.codeMode && !body.tools.some((tool) => toolNames(tool).includes("exec_command"))) {
        const titleRequest = structuredRequest
          && body.outputSchemaProperties.length === 1
          && body.outputSchemaProperties[0] === "title";
        if (body.requestKind === "turn" && !structuredRequest) throw new ProtocolMismatch("$.tools", "agent turn must offer a supported shell tool");
        checkpoint = titleRequest ? "auxiliary:thread-title" : structuredRequest ? "auxiliary:structured" : `auxiliary:${body.requestKind ?? "unknown"}`;
        checkpoints.add(checkpoint);
        const auxiliaryOutput = body.outputSchema === null ? "Deterministic E2E task" : JSON.stringify(schemaFixture(body.outputSchema));
        writeResponse(response, body.model, raw, finalOutput(auxiliaryOutput));
        observations.push(observation(request, url, raw, body, sessionSalt, ++sequence, 200, "success", null, checkpoint));
        await persist(options.diagnosticsPath, observations);
        return;
      }
      inferenceRequests += 1;
      const selection = await selectScenario(body);
      scenario = selection.scenario;
      if (selection.spilled) checkpoints.add("prompt:spilled");
      const result = transition(body, scenario, selection.text, options.resolveRepoRoot ? await options.resolveRepoRoot() : options.repoRoot);
      checkpoint = result.checkpoint;
      checkpoints.add(`${scenario}:${checkpoint}`);
      if (scenario === "process-failure") {
        jsonError(response, 500, "deterministic E2E inference failure");
        observations.push(observation(request, url, raw, body, sessionSalt, ++sequence, 500, "success", scenario, checkpoint));
      } else {
        writeResponse(response, body.model, raw, result.output);
        observations.push(observation(request, url, raw, body, sessionSalt, ++sequence, 200, "success", scenario, checkpoint));
      }
    } catch (error) {
      unexpectedRequests += 1;
      const status = error instanceof AuthenticationError ? 401 : 400;
      const diagnostic = sanitizeDiagnostic(error);
      jsonError(response, status, diagnostic);
      observations.push(observation(request, url, raw, body, sessionSalt, ++sequence, status, "rejected", scenario, checkpoint, diagnostic));
    }
    await persist(options.diagnosticsPath, observations);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    authToken,
    assertions: () => ({ checkpoints: [...checkpoints], inferenceRequests, unexpectedRequests, observations: [...observations] }),
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await persist(options.diagnosticsPath, observations);
    },
  };
}

function parseRequest(value: unknown): ResponsesRequest {
  const body = record(value, "$");
  if (typeof body.model !== "string" || body.model.trim() === "") throw new ProtocolMismatch("$.model", "must be a nonempty string");
  if (body.stream !== true) throw new ProtocolMismatch("$.stream", "must be true");
  if (body.store !== false) throw new ProtocolMismatch("$.store", "must be false");
  if (!Array.isArray(body.input)) throw new ProtocolMismatch("$.input", "must be an array");
  if (body.tools !== undefined && !Array.isArray(body.tools)) throw new ProtocolMismatch("$.tools", "must be an array when present");
  const input = body.input.map((item, index) => record(item, `$.input[${index}]`));
  const codeMode = input.some((item) => item.type === "additional_tools");
  const topLevelTools = (body.tools ?? []).map((tool, index) => record(tool, `$.tools[${index}]`));
  const additionalTools = input.flatMap((item, inputIndex) => {
    if (item.type !== "additional_tools") return [];
    if (!Array.isArray(item.tools)) throw new ProtocolMismatch(`$.input[${inputIndex}].tools`, "must be an array");
    return item.tools.map((tool, toolIndex) => record(tool, `$.input[${inputIndex}].tools[${toolIndex}]`));
  });
  const tools = [...topLevelTools, ...additionalTools];
  const metadata = typeof body.client_metadata === "object" && body.client_metadata !== null && !Array.isArray(body.client_metadata) ? body.client_metadata as Record<string, unknown> : {};
  let sandboxMode: string | null = null;
  let sessionId: string | null = null;
  let requestKind: string | null = null;
  let outputSchemaProperties: string[] = [];
  let outputSchema: Record<string, unknown> | null = null;
  if (typeof metadata["x-codex-turn-metadata"] === "string") {
    try {
      const turn = JSON.parse(metadata["x-codex-turn-metadata"]) as Record<string, unknown>;
      sandboxMode = typeof turn.sandbox_mode === "string" ? turn.sandbox_mode : null;
      sessionId = typeof turn.session_id === "string" ? turn.session_id : null;
      requestKind = typeof turn.request_kind === "string" ? turn.request_kind : null;
    } catch { throw new ProtocolMismatch("$.client_metadata", "contains invalid turn metadata"); }
  }
  if (typeof body.text === "object" && body.text !== null && !Array.isArray(body.text)) {
    const format = (body.text as Record<string, unknown>).format;
    if (typeof format === "object" && format !== null && !Array.isArray(format)) {
      const schema = (format as Record<string, unknown>).schema;
      if (typeof schema === "object" && schema !== null && !Array.isArray(schema)) {
        outputSchema = schema as Record<string, unknown>;
        const properties = (schema as Record<string, unknown>).properties;
        if (typeof properties === "object" && properties !== null && !Array.isArray(properties)) outputSchemaProperties = Object.keys(properties).sort();
      }
    }
  }
  return { model: body.model, stream: true, store: false, input, tools, codeMode, sandboxMode, sessionId, requestKind, outputSchemaProperties, outputSchema };
}

function schemaFixture(schema: Record<string, unknown>): unknown {
  if ("const" in schema) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if (schema.type === "object") {
    const properties = typeof schema.properties === "object" && schema.properties !== null && !Array.isArray(schema.properties)
      ? schema.properties as Record<string, unknown>
      : {};
    const required = Array.isArray(schema.required) ? schema.required.filter((name): name is string => typeof name === "string") : Object.keys(properties);
    return Object.fromEntries(required.map((name) => {
      const property = properties[name];
      return [name, typeof property === "object" && property !== null && !Array.isArray(property) ? schemaFixture(property as Record<string, unknown>) : "Deterministic E2E task"];
    }));
  }
  if (schema.type === "array") return [];
  if (schema.type === "boolean") return false;
  if (schema.type === "integer" || schema.type === "number") return 0;
  return "Deterministic E2E task";
}

function toolNames(tool: Record<string, unknown>): string[] {
  const names: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return;
    for (const [key, nested] of Object.entries(value)) {
      if (key === "name" && typeof nested === "string") names.push(nested);
      else visit(nested);
    }
  };
  visit(tool);
  return names;
}

async function selectScenario(body: ResponsesRequest): Promise<{ readonly scenario: CodexScenario; readonly spilled: boolean; readonly text: string }> {
  const inputText = requestText(body);
  const spill = /Perform the task described in @(.+)\.$/u.exec(inputText);
  const text = spill === null ? inputText : `${inputText}\n${await readSpill(spill[1]!)}`;
  const selected = (scenario: CodexScenario): { readonly scenario: CodexScenario; readonly spilled: boolean; readonly text: string } => ({ scenario, spilled: spill !== null, text });
  if (text.includes(AUTO_RUN_FOLLOWUP_MARKER)) return selected("auto-run-followup");
  if (text.includes(AUTO_RUN_HITL_MARKER)) return selected("auto-run-hitl");
  if (text.includes(AUTO_RUN_AFK_MARKER) || text.includes("Review pull request") && text.includes(AUTO_RUN_PERMANENT_NOTE)) return selected("auto-run-afk");
  if (text.includes("[E2E:chatgpt-process-failure]")) return selected("process-failure");
  if (text.includes("[E2E:chatgpt-explore]")) return selected("explore");
  if (text.includes("[E2E:chatgpt-implement]")) {
    if (!text.includes("[E2E:address-this-skill-loaded]")) throw new ProtocolMismatch("$.input", "did not load the address-this skill");
    if (text.includes("with Chrome") && !text.includes("Chrome browser backend")) throw new ProtocolMismatch("$.input", "lost the Chrome backend instruction");
    return selected("implement");
  }
  if (text.includes("[E2E:chatgpt-review-changes]")) {
    if (!text.includes("[E2E:review-this-skill-loaded]")) throw new ProtocolMismatch("$.input", "did not load the review-this skill");
    return selected("review-changes");
  }
  if (text.includes("[E2E:chatgpt-review-approve]")) {
    if (!text.includes("[E2E:review-this-skill-loaded]")) throw new ProtocolMismatch("$.input", "did not load the review-this skill");
    return selected("review-approve");
  }
  if (text.includes("[E2E:chatgpt-success]")) return selected("attended");
  throw new ProtocolMismatch("$.input", "does not select a known deterministic scenario");
}

function transition(body: ResponsesRequest, scenario: CodexScenario, text: string, repoRoot?: string): { readonly checkpoint: string; readonly output: ResponseOutput } {
  if (scenario === "auto-run-afk") return autoRunAfkTransition(body, text, requireRepoRoot(repoRoot));
  if (scenario === "auto-run-hitl") return autoRunSequentialTransition(body, requireRepoRoot(repoRoot), "auto-hitl", BEFORE_CONTENT, AFTER_CONTENT);
  if (scenario === "auto-run-followup") return autoRunSequentialTransition(body, requireRepoRoot(repoRoot), "auto-followup", AFTER_CONTENT, "harness e2e fixture: complete\n");
  if (scenario === "process-failure") return { checkpoint: "failed", output: finalOutput("") };
  const outputs = toolOutputs(body);
  const calls = toolCalls(body);
  if (outputs.length === 0) {
    if (calls.length > 0) throw new ProtocolMismatch("$.input", "contains a tool call without its output");
    if (scenario === "implement") return { checkpoint: "guard", output: functionOutput("git push origin main", body) };
    if (scenario === "explore" && body.sandboxMode !== "read-only") throw new ProtocolMismatch("$.client_metadata", "Explore did not activate the read-only sandbox");
    const command = scenario === "explore"
      ? "Set-Content -LiteralPath 'sandbox-target.txt' -Value 'sandbox escape'"
      : `Set-Content -LiteralPath 'write-attempt-${scenario}.txt' -Value 'real Codex tool execution'`;
    return { checkpoint: "tool", output: functionOutput(command, body) };
  }
  const lastOutput = outputs.at(-1)!;
  const lastCall = calls.at(-1);
  if (lastCall === undefined || !matchingToolPair(lastCall, lastOutput)) {
    throw new ProtocolMismatch("$.input", "contains an unknown shell call output");
  }
  const output = toolOutputText(lastOutput);
  if (scenario === "implement" && outputs.length === 1) {
    if (!/denied|reject|blocked|not allowed/iu.test(output)) throw new ProtocolMismatch("$.input", "worker guard allowed a forbidden git push");
    return { checkpoint: "tool", output: functionOutput("Set-Content -LiteralPath 'write-attempt-implement.txt' -Value 'real Codex tool execution'", body) };
  }
  if (scenario === "explore" && !/failed|denied|reject|blocked|sandbox|exited with (?:code|status) [1-9]|exit_code["']?\s*[:=]\s*[1-9]/iu.test(output)) {
    throw new ProtocolMismatch("$.input", "read-only sandbox allowed the write attempt");
  }
  if (scenario !== "explore" && /failed|denied|reject|blocked|sandbox|exited with (?:code|status) [1-9]|exit_code["']?\s*[:=]\s*[1-9]/iu.test(output)) {
    throw new ProtocolMismatch("$.input", "write-capable session failed its deterministic tool call");
  }
  return { checkpoint: "complete", output: finalOutput(finalMessage(scenario)) };
}

function autoRunAfkTransition(body: ResponsesRequest, text: string, repoRoot: string): { readonly checkpoint: string; readonly output: ResponseOutput } {
  if (text.includes("Review pull request")) return { checkpoint: "auto-review-complete", output: finalOutput("Review complete; no fixes required.") };
  if (text.includes("Explore implementation context")) {
    return commandSequence(body, [
      { checkpoint: "auto-explore-read", command: readCommand(repoRoot), requireOutput: BEFORE_CONTENT.trimEnd() },
    ], "auto-explore-complete", AUTO_RUN_EXPLORE_REPORT);
  }
  if (!text.includes(AUTO_RUN_PERMANENT_NOTE)) throw new ProtocolMismatch("$.input", "implementer prompt omitted permanent guidance");
  if (!text.includes(AUTO_RUN_NESTED_CONTEXT)) throw new ProtocolMismatch("$.input", "implementer prompt omitted recursive issue context");
  if (text.includes("Fresh codebase context") && !text.includes(AUTO_RUN_EXPLORE_REPORT)) throw new ProtocolMismatch("$.input", "implementer prompt omitted the Explore report");
  return commandSequence(body, [
    { checkpoint: "auto-afk-read", command: readCommand(repoRoot), requireOutput: BEFORE_CONTENT.trimEnd() },
    { checkpoint: "auto-afk-edit", command: writeCommand(repoRoot, AFTER_CONTENT) },
    { checkpoint: "auto-afk-commit", command: WORKER_COMMIT_COMMAND },
  ], "auto-afk-complete", FINAL_RESPONSE);
}

function autoRunSequentialTransition(body: ResponsesRequest, repoRoot: string, prefix: "auto-hitl" | "auto-followup", before: string, after: string): { readonly checkpoint: string; readonly output: ResponseOutput } {
  if (prefix === "auto-hitl" && !requestText(body).includes(HITL_ACCEPT_PROMPT)) {
    return commandSequence(body, [
      { checkpoint: "auto-hitl-read", command: readCommand(repoRoot), requireOutput: before.trimEnd() },
      { checkpoint: "auto-hitl-edit", command: writeCommand(repoRoot, after) },
    ], "auto-hitl-handoff", "Implementation is ready for your review; changes are uncommitted.");
  }
  return commandSequence(body, [
    { checkpoint: `${prefix}-read`, command: readCommand(repoRoot), requireOutput: before.trimEnd() },
    { checkpoint: `${prefix}-edit`, command: writeCommand(repoRoot, after) },
    { checkpoint: `${prefix}-commit`, command: WORKER_COMMIT_COMMAND },
  ], `${prefix}-complete`, FINAL_RESPONSE);
}

function commandSequence(body: ResponsesRequest, steps: readonly { readonly checkpoint: string; readonly command: string; readonly requireOutput?: string }[], finalCheckpoint: string, message: string): { readonly checkpoint: string; readonly output: ResponseOutput } {
  const calls = toolCalls(body);
  const outputs = toolOutputs(body);
  if (calls.length !== outputs.length) throw new ProtocolMismatch("$.input", "contains a shell call without its output");
  calls.forEach((call, index) => {
    if (!matchingToolPair(call, outputs[index])) throw new ProtocolMismatch("$.input", "contains an unknown shell call output");
    const output = toolOutputText(outputs[index]);
    if (toolCallFailed(output)) throw new ProtocolMismatch("$.input", "auto-run tool call failed");
    if (steps[index]?.requireOutput !== undefined && !output.includes(steps[index].requireOutput)) {
      throw new ProtocolMismatch("$.input", `read result omitted the expected fixture marker (${toolOutputShape(output)})`);
    }
  });
  const next = steps[outputs.length];
  return next === undefined ? { checkpoint: finalCheckpoint, output: finalOutput(message) } : { checkpoint: next.checkpoint, output: functionOutput(next.command, body) };
}

function toolOutputShape(output: string): string {
  const exitCode = /exit_code["']?\s*[:=]\s*(-?\d+)/iu.exec(output)?.[1];
  const completion = /script completed/iu.test(output) ? "completed" : /script failed/iu.test(output) ? "failed" : "unclassified";
  return `${completion}, exit ${exitCode ?? "unreported"}, ${output.length} characters`;
}

function toolCallFailed(output: string): boolean {
  const exitCode = /exit_code["']?\s*[:=]\s*(-?\d+)/iu.exec(output)?.[1]
    ?? /exited with (?:code|status)\s+(-?\d+)/iu.exec(output)?.[1];
  if (exitCode !== undefined) return Number(exitCode) !== 0;
  return /script failed|failed|denied|reject|blocked/iu.test(output);
}

function toolCalls(body: ResponsesRequest): readonly Record<string, unknown>[] {
  return body.input.filter((item) => item.type === "function_call" || item.type === "custom_tool_call");
}

function toolOutputs(body: ResponsesRequest): readonly Record<string, unknown>[] {
  return body.input.filter((item) => item.type === "function_call_output" || item.type === "custom_tool_call_output");
}

function matchingToolPair(call: Record<string, unknown>, output: Record<string, unknown> | undefined): boolean {
  if (output === undefined || typeof call.call_id !== "string") return false;
  if (call.type === "function_call") return call.name === "exec_command" && output.type === "function_call_output" && output.call_id === call.call_id;
  return call.type === "custom_tool_call" && call.name === "exec" && output.type === "custom_tool_call_output" && output.call_id === call.call_id;
}

function toolOutputText(item: Record<string, unknown> | undefined): string {
  const strings: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === "string") strings.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (typeof value === "object" && value !== null) Object.values(value).forEach(visit);
  };
  visit(item?.output);
  return strings.join("\n");
}

function requireRepoRoot(value: string | undefined): string {
  if (value === undefined) throw new ProtocolMismatch("server.repoRoot", "is required for an auto-run scenario");
  return resolve(value);
}

function readCommand(repoRoot: string): string { return `Get-Content -Raw -LiteralPath '${resolve(repoRoot, "deterministic.txt").replaceAll("'", "''")}'`; }
function writeCommand(repoRoot: string, content: string): string {
  const path = resolve(repoRoot, "deterministic.txt").replaceAll("'", "''");
  const value = content.replaceAll("`", "``").replaceAll('"', '`"').replaceAll("\n", "`n");
  return `[IO.File]::WriteAllText('${path}', \"${value}\", [Text.UTF8Encoding]::new($false))`;
}

type ResponseOutput =
  | { readonly type: "function_call"; readonly id: string; readonly call_id: string; readonly name: "exec_command"; readonly arguments: string; readonly status: "completed" }
  | { readonly type: "custom_tool_call"; readonly id: string; readonly call_id: string; readonly name: "exec"; readonly input: string; readonly status: "completed" }
  | { readonly type: "message"; readonly id: string; readonly role: "assistant"; readonly status: "completed"; readonly content: readonly [{ readonly type: "output_text"; readonly text: string; readonly annotations: readonly [] }] };

function functionOutput(command: string, body: ResponsesRequest): ResponseOutput {
  if (body.codeMode) {
    return {
      type: "custom_tool_call", id: stableId("ctc", body, true), call_id: stableId("call", body, true), name: "exec", status: "completed",
      input: [
        '// @exec: {"yield_time_ms": 120000, "max_output_tokens": 1000}\n',
        `let result = await tools.exec_command(${JSON.stringify({ cmd: command, yield_time_ms: 10_000, max_output_tokens: 1_000 })});`,
        "for (let attempt = 0; result.session_id !== undefined && attempt < 6; attempt += 1) result = await tools.write_stdin({ session_id: result.session_id, chars: \"\", yield_time_ms: 10_000, max_output_tokens: 1_000 });",
        "if (result.session_id !== undefined) throw new Error(\"command did not finish\");",
        "text(JSON.stringify({ exit_code: result.exit_code, output: result.output ?? \"\" }));",
      ].join(" "),
    };
  }
  return {
    type: "function_call", id: stableId("fc", body, true), call_id: stableId("call", body, true), name: "exec_command",
    arguments: JSON.stringify({ cmd: command, yield_time_ms: 10_000, max_output_tokens: 1_000, sandbox_permissions: "use_default" }), status: "completed",
  };
}

function finalOutput(text: string): ResponseOutput {
  return { type: "message", id: `msg_${hash(text).slice(0, 24)}`, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
}

function finalMessage(scenario: Exclude<CodexScenario, "process-failure">): string {
  if (scenario === "explore") return "Explore report: the deterministic checkout keeps its launch plan in src/chatgpt/launch.ts.";
  if (scenario === "implement") return "Implemented the deterministic issue; the work is uncommitted.";
  if (scenario === "review-changes") return "Review complete: requested changes before this can merge.";
  if (scenario === "review-approve") return "Review complete: the implementation matches the frozen issue contract.";
  return "Deterministic ChatGPT session completed.";
}

function stableId(prefix: string, body: ResponsesRequest, _beforeToolOutput: boolean): string {
  return `${prefix}_${hash(JSON.stringify(body.input)).slice(0, 24)}`;
}

function requestText(body: ResponsesRequest): string {
  const strings: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === "string") strings.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (typeof value === "object" && value !== null) Object.values(value).forEach(visit);
  };
  body.input.forEach(visit);
  return strings.join("\n");
}

async function readSpill(candidate: string): Promise<string> {
  const path = resolve(candidate);
  const spillRoot = resolve(tmpdir(), "abd-prompts");
  if (path === spillRoot || !path.startsWith(`${spillRoot}\\`) && !path.startsWith(`${spillRoot}/`)) throw new ProtocolMismatch("$.input", "spilled prompt path escaped its dedicated root");
  try { return await readFile(path, "utf8"); }
  catch { throw new ProtocolMismatch("$.input", "spilled prompt file is unavailable"); }
}

function writeResponse(response: ServerResponse, model: string, raw: Buffer, output: ResponseOutput): void {
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
    item: output.type === "function_call"
      ? { ...output, status: "in_progress", arguments: "" }
      : output.type === "message" ? { ...output, status: "in_progress", content: [] } : { ...output, status: "in_progress" },
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

function authenticate(request: IncomingMessage, expected: string): void {
  if (request.headers.authorization !== `Bearer ${expected}`) throw new AuthenticationError("missing or invalid dummy bearer credential");
}

async function readBody(request: IncomingMessage): Promise<Buffer<ArrayBufferLike>> {
  if (!(request.headers["content-type"] ?? "").toLowerCase().includes("application/json")) throw new ProtocolMismatch("headers.content-type", "must be application/json");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new ProtocolMismatch("$", "request exceeds 32 MB");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ProtocolMismatch(path, "must be an object");
  return value as Record<string, unknown>;
}

function observation(request: IncomingMessage, url: URL, raw: Buffer, body: ResponsesRequest | undefined, sessionSalt: Buffer, sequence: number, httpStatus: number, result: "success" | "rejected", scenario: CodexScenario | null, checkpoint: string | null, diagnostic?: string): CodexStructuralObservation {
  return {
    sequence, method: request.method ?? "", path: url.pathname, model: body?.model ?? null, stream: body?.stream ?? null,
    store: body?.store ?? null, sandboxMode: body?.sandboxMode ?? null, sessionHash: body?.sessionId === null || body?.sessionId === undefined ? null : `sha256:${createHash("sha256").update(sessionSalt).update(body.sessionId).digest("hex")}`, requestKind: body?.requestKind ?? null, inputTypes: body?.input.map((item) => typeof item.type === "string" ? item.type : "unknown") ?? [],
    toolNamesOffered: body === undefined ? [] : [...body.tools.flatMap(toolNames), ...(body.codeMode ? ["exec"] : [])].sort(),
    requestBodySha256: raw.length === 0 ? null : hash(raw), requestBytes: raw.length, scenario, checkpoint, result, httpStatus,
    ...(diagnostic === undefined ? {} : { diagnostic }),
  };
}

function jsonError(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: { type: "invalid_request_error", message }, request_id: `req_e2e_${hash(`${status}:${message}`).slice(0, 16)}` }));
}

function sanitizeDiagnostic(error: unknown): string {
  if (error instanceof ProtocolMismatch || error instanceof AuthenticationError) return error.message;
  if (error instanceof SyntaxError) return "request body is not valid JSON";
  return "internal structural validation failure";
}

class ProtocolMismatch extends Error {
  public constructor(path: string, detail: string) { super(`${path}: ${detail}`); }
}
class AuthenticationError extends Error {}

async function persist(path: string | undefined, observations: readonly CodexStructuralObservation[]): Promise<void> {
  if (path === undefined) return;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ schemaVersion: 1, upstreamMode: "forbidden", protocol: "openai-responses", observations }, null, 2)}\n`, "utf8");
}

function hash(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
