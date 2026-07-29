import { AGENT_TYPES, type AgentId, type AgentType, type SessionId, type TerminalId } from "../domain/contracts.js";
import {
  TERMINAL_KEYS,
  TerminalControlError,
  type CreateAboardTerminalRequest,
  type TerminalController,
  type TerminalKey,
} from "../claude/terminals.js";
import { protocolError, type BridgeRequestHandler, type BridgeResponse } from "./protocol.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): BridgeResponse {
  return protocolError(400, "invalid-request", message);
}

function parseCreate(body: unknown): CreateAboardTerminalRequest | BridgeResponse {
  if (!isRecord(body)) return invalid("Request body must be an object");
  const { agentId, sessionId, agentType, issueNumber, name, shellPath, shellArgs, initialCommand } = body;
  if (typeof agentId !== "string" || agentId.trim() === "") return invalid("agentId must be a non-empty string");
  if (typeof sessionId !== "string" || !UUID.test(sessionId)) return invalid("sessionId must be a UUID");
  if (typeof agentType !== "string" || !AGENT_TYPES.includes(agentType as AgentType)) return invalid("agentType is not supported");
  if (issueNumber !== undefined && (!Number.isInteger(issueNumber) || (issueNumber as number) <= 0)) return invalid("issueNumber must be a positive integer");
  for (const [field, value] of [["name", name], ["shellPath", shellPath], ["initialCommand", initialCommand]] as const) {
    if (value !== undefined && (typeof value !== "string" || value.trim() === "")) return invalid(`${field} must be a non-empty string`);
  }
  if (shellArgs !== undefined && (!Array.isArray(shellArgs) || shellArgs.some((value) => typeof value !== "string"))) {
    return invalid("shellArgs must be an array of strings");
  }
  return {
    agentId: agentId as AgentId,
    sessionId: sessionId as SessionId,
    agentType: agentType as AgentType,
    ...(issueNumber === undefined ? {} : { issueNumber: issueNumber as number }),
    ...(name === undefined ? {} : { name: name as string }),
    ...(shellPath === undefined ? {} : { shellPath: shellPath as string }),
    ...(shellArgs === undefined ? {} : { shellArgs: shellArgs as string[] }),
    ...(initialCommand === undefined ? {} : { initialCommand: initialCommand as string }),
  };
}

function terminalError(error: unknown): BridgeResponse {
  if (!(error instanceof TerminalControlError)) throw error;
  if (error.code === "unknown-terminal") return protocolError(404, "not-found", error.message);
  if (error.code === "closed-terminal") return protocolError(409, "terminal-closed", error.message);
  return protocolError(409, "conflict", error.message);
}

export function createTerminalRoutes(terminals: TerminalController): BridgeRequestHandler {
  return async (request) => {
    const parts = request.url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "terminals") return protocolError(404, "not-found", "Route not found");
    try {
      if (request.method === "POST" && parts.length === 1) {
        const parsed = parseCreate(request.body);
        if ("status" in parsed) return parsed;
        return { status: 201, body: await terminals.getWithProcessId(terminals.create(parsed).terminalId) };
      }
      if (request.method === "GET" && parts.length === 1) return { status: 200, body: { terminals: terminals.list() } };
      if (parts.length < 2) return protocolError(404, "not-found", "Route not found");
      const terminalId = parts[1] as TerminalId;
      if (request.method === "GET" && parts.length === 2) return { status: 200, body: await terminals.getWithProcessId(terminalId) };
      if (request.method === "POST" && parts.length === 3 && parts[2] === "show") {
        terminals.show(terminalId);
        return { status: 200, body: { ok: true } };
      }
      if (request.method === "DELETE" && parts.length === 2) {
        terminals.kill(terminalId);
        return { status: 200, body: { ok: true } };
      }
      if (request.method === "POST" && parts.length === 3 && parts[2] === "send") {
        if (!isRecord(request.body) || request.body.takeover !== true || typeof request.body.text !== "string") {
          return invalid("send requires takeover: true and text: string");
        }
        if (request.body.addNewLine !== undefined && typeof request.body.addNewLine !== "boolean") return invalid("addNewLine must be boolean");
        terminals.sendUserTakeoverText(terminalId, request.body.text, request.body.addNewLine as boolean | undefined);
        return { status: 200, body: { ok: true } };
      }
      if (request.method === "POST" && parts.length === 3 && parts[2] === "keys") {
        if (!isRecord(request.body) || request.body.takeover !== true || !Array.isArray(request.body.keys) || request.body.keys.length === 0) {
          return invalid("keys requires takeover: true and a non-empty keys array");
        }
        const keys = request.body.keys;
        if (keys.some((key) => typeof key !== "string" || !TERMINAL_KEYS.includes(key as TerminalKey))) return invalid("keys contains an unknown key name");
        const delayMs = request.body.delayMs;
        if (delayMs !== undefined && (!Number.isInteger(delayMs) || (delayMs as number) < 0 || (delayMs as number) > 1_000)) return invalid("delayMs must be an integer from 0 to 1000");
        await terminals.sendUserTakeoverKeys(terminalId, keys as TerminalKey[], delayMs as number | undefined);
        return { status: 200, body: { ok: true } };
      }
      return protocolError(404, "not-found", "Route not found");
    } catch (error) {
      return terminalError(error);
    }
  };
}
