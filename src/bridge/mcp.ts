import { AGENT_TYPES, type AgentId, type AgentType } from "../domain/contracts.js";
import { DelegationCoordinator, DelegationError, type DelegationLaunchInput } from "./delegation.js";
import { protocolError, type BridgeRequestHandler, type BridgeResponse } from "./protocol.js";

const MCP_PROTOCOL_VERSION = "2025-03-26";
export const ABOARD_MCP_TIMEOUT_SECONDS = 3600;

interface McpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

const SPAWN_PROPERTIES = {
  type: { type: "string", enum: AGENT_TYPES.filter((type) => type !== "manager") },
  prompt: { type: "string", minLength: 1, description: "The task for the agent; becomes its first user turn." },
  description: { type: "string", minLength: 1, description: "A concise 3-6 word description shown in the fleet tree." },
  issue: { type: "integer", minimum: 1, description: "Optional GitHub issue whose resolved contract is merged into the launch prompt." },
} as const;

export const CORE_MCP_TOOLS: readonly McpTool[] = [
  {
    name: "aboard__run_agent",
    description: "Launch a visible independent Claude Code agent in the foreground for a focused task. Like Claude Code's Agent tool with run_in_background false: this call waits for the agent's final result. Use aboard__spawn_agent when you should stay conversational while work runs.",
    inputSchema: { type: "object", properties: SPAWN_PROPERTIES, required: ["type", "prompt", "description"], additionalProperties: false },
  },
  {
    name: "aboard__spawn_agent",
    description: "Launch a visible independent Claude Code agent in the background for a focused task. Like Claude Code's Agent tool with run_in_background true: returns immediately and the Manager Stop hook delivers the eventual result. Backgrounding does not bypass the single-writer lease.",
    inputSchema: { type: "object", properties: SPAWN_PROPERTIES, required: ["type", "prompt", "description"], additionalProperties: false },
  },
  {
    name: "aboard__spawn_interactive_agent",
    description: "Create and focus a visible Claude Code terminal for the user. The opening prompt is optional, and no result is expected or delivered. Use type raw for an unconstrained session with no agent definition.",
    inputSchema: { type: "object", properties: SPAWN_PROPERTIES, required: ["type", "description"], additionalProperties: false },
  },
  {
    name: "aboard__list_agents",
    description: "List live and recent aboard agents with their types, lifecycle states, issues, terminals, telemetry, and the current write-lease holder.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "aboard__send_to_agent",
    description: "Resume a finished aboard agent with a new message in a new visible terminal using claude --resume. This is reliable CLI-argument delivery, never keystroke injection into a live TUI.",
    inputSchema: {
      type: "object",
      properties: { agentId: { type: "string", minLength: 1 }, message: { type: "string", minLength: 1 } },
      required: ["agentId", "message"],
      additionalProperties: false,
    },
  },
  {
    name: "aboard__focus_agent",
    description: "Reveal and focus an aboard agent's VS Code terminal for user handoff or inspection.",
    inputSchema: { type: "object", properties: { agentId: { type: "string", minLength: 1 } }, required: ["agentId"], additionalProperties: false },
  },
  {
    name: "aboard__release_lease",
    description: "Force-release the workspace write lease as an explicit escape hatch. Always provide a meaningful audit reason; concurrent editing may become possible immediately.",
    inputSchema: { type: "object", properties: { reason: { type: "string", minLength: 1 } }, required: ["reason"], additionalProperties: false },
  },
];

type JsonRpcId = string | number | null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonRpc(id: JsonRpcId, result: unknown): BridgeResponse {
  return { status: 200, body: { jsonrpc: "2.0", id, result } };
}

function jsonRpcError(id: JsonRpcId, code: number, message: string, data?: unknown): BridgeResponse {
  return {
    status: 200,
    body: { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } },
  };
}

function toolResult(value: unknown, isError = false): unknown {
  const text = JSON.stringify(value);
  return { content: [{ type: "text", text }], structuredContent: value, ...(isError ? { isError: true } : {}) };
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseLaunch(value: unknown, promptRequired: boolean): DelegationLaunchInput | string {
  if (!isRecord(value)) return "arguments must be an object";
  if (!exactKeys(value, ["type", "prompt", "description", "issue"])) return "arguments contain an unknown property";
  if (!nonEmptyString(value.type) || value.type === "manager" || !AGENT_TYPES.includes(value.type as AgentType)) return "type must be a supported worker agent type";
  if (!nonEmptyString(value.description)) return "description must be a non-empty string";
  const words = value.description.trim().split(/\s+/).length;
  if (words < 3 || words > 6) return "description must contain 3-6 words";
  if (promptRequired && !nonEmptyString(value.prompt)) return "prompt must be a non-empty string";
  if (value.prompt !== undefined && !nonEmptyString(value.prompt)) return "prompt must be a non-empty string when provided";
  if (value.issue !== undefined && (!Number.isInteger(value.issue) || (value.issue as number) <= 0)) return "issue must be a positive integer";
  return {
    type: value.type as DelegationLaunchInput["type"],
    description: value.description.trim(),
    ...(value.prompt === undefined ? {} : { prompt: (value.prompt as string).trim() }),
    ...(value.issue === undefined ? {} : { issue: value.issue as number }),
  };
}

function parsePair(value: unknown, second: "message" | "reason" | undefined): Record<string, string> | string {
  if (!isRecord(value)) return "arguments must be an object";
  const keys = second === undefined ? ["agentId"] : second === "message" ? ["agentId", "message"] : ["reason"];
  if (!exactKeys(value, keys)) return "arguments contain an unknown property";
  for (const key of keys) if (!nonEmptyString(value[key])) return `${key} must be a non-empty string`;
  return Object.fromEntries(keys.map((key) => [key, (value[key] as string).trim()]));
}

async function callTool(
  coordinator: DelegationCoordinator,
  name: string,
  args: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  switch (name) {
    case "aboard__run_agent": {
      const parsed = parseLaunch(args, true);
      if (typeof parsed === "string") throw new TypeError(parsed);
      return coordinator.run(parsed, signal);
    }
    case "aboard__spawn_agent": {
      const parsed = parseLaunch(args, true);
      if (typeof parsed === "string") throw new TypeError(parsed);
      return coordinator.spawn(parsed);
    }
    case "aboard__spawn_interactive_agent": {
      const parsed = parseLaunch(args, false);
      if (typeof parsed === "string") throw new TypeError(parsed);
      return coordinator.spawnInteractive(parsed);
    }
    case "aboard__list_agents":
      if (!isRecord(args) || !exactKeys(args, [])) throw new TypeError("arguments must be an empty object");
      return coordinator.list();
    case "aboard__send_to_agent": {
      const parsed = parsePair(args, "message");
      if (typeof parsed === "string") throw new TypeError(parsed);
      return coordinator.send(parsed.agentId as AgentId, parsed.message!);
    }
    case "aboard__focus_agent": {
      const parsed = parsePair(args, undefined);
      if (typeof parsed === "string") throw new TypeError(parsed);
      return coordinator.focus(parsed.agentId as AgentId);
    }
    case "aboard__release_lease": {
      const parsed = parsePair(args, "reason");
      if (typeof parsed === "string") throw new TypeError(parsed);
      return coordinator.releaseLease(parsed.reason!);
    }
    default:
      throw new DelegationError("unknown-agent", `Unknown MCP tool ${name}`);
  }
}

export function createMcpHandler(coordinator: DelegationCoordinator): BridgeRequestHandler {
  return async (request) => {
    if (request.url.pathname !== "/mcp") return protocolError(404, "not-found", "Route not found");
    if (request.method === "GET") return protocolError(405, "invalid-request", "This stateless MCP endpoint accepts POST requests");
    if (request.method !== "POST") return protocolError(405, "invalid-request", "Method not allowed");
    if (!isRecord(request.body) || request.body.jsonrpc !== "2.0" || !(typeof request.body.method === "string")) {
      return jsonRpcError(null, -32600, "Invalid Request");
    }
    const id = (typeof request.body.id === "string" || typeof request.body.id === "number" || request.body.id === null)
      ? request.body.id
      : null;
    const params = request.body.params;
    switch (request.body.method) {
      case "initialize":
        return jsonRpc(id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "aboard", version: "0.0.0" },
          instructions: `Foreground delegation may run for up to ${ABOARD_MCP_TIMEOUT_SECONDS} seconds. Configure ABOARD_MCP_TIMEOUT to match the Manager Stop hook timeout.`,
        });
      case "notifications/initialized":
        return { status: 202 };
      case "ping":
        return jsonRpc(id, {});
      case "tools/list":
        return jsonRpc(id, { tools: CORE_MCP_TOOLS });
      case "tools/call": {
        if (!isRecord(params) || !nonEmptyString(params.name)) return jsonRpcError(id, -32602, "Invalid params");
        try {
          return jsonRpc(id, toolResult(await callTool(coordinator, params.name, params.arguments ?? {}, request.signal)));
        } catch (error) {
          if (error instanceof TypeError) return jsonRpcError(id, -32602, error.message);
          if (error instanceof DelegationError) {
            return jsonRpc(id, toolResult({ code: error.code, message: error.message, details: error.details }, true));
          }
          throw error;
        }
      }
      default:
        return jsonRpcError(id, -32601, "Method not found");
    }
  };
}
