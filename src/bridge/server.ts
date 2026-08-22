import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import { authorize, redactSecret, type BridgeTokens } from "./authentication.js";
import type {
  BridgeDiscoveryMetadata,
  BridgeDiscoveryPersistence,
} from "./discovery.js";
import {
  protocolError,
  type BridgeRequestHandler,
  type BridgeResponse,
} from "./protocol.js";

export const BRIDGE_HOST = "127.0.0.1" as const;
export const DEFAULT_BRIDGE_PORT = 4823;
const MAX_BODY_BYTES = 1024 * 1024;

export interface BridgeLogger {
  info(message: string): void;
  error(message: string): void;
}

export interface StartBridgeOptions {
  readonly preferredPort?: number;
  readonly handler: BridgeRequestHandler;
  readonly persistence: BridgeDiscoveryPersistence;
  readonly logger?: BridgeLogger;
  readonly tokenFactory?: () => string;
  readonly commandTokenFactory?: () => string;
  readonly now?: () => Date;
}

export interface BridgeRuntime {
  readonly host: typeof BRIDGE_HOST;
  readonly port: number;
  readonly token: string;
  /** Reaches `/commands` only; see `BridgeTokens`. */
  readonly commandToken: string;
  stop(): Promise<void>;
}

class MalformedRequestError extends Error {}

function validatePort(port: number): void {
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("Bridge port must be an integer between 0 and 65535");
  }
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new MalformedRequestError("Request body exceeds the 1 MiB limit");
    }
    chunks.push(buffer);
  }
  if (size === 0) return undefined;

  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new MalformedRequestError("Request body must be valid JSON");
  }
}

function writeResponse(response: ServerResponse, result: BridgeResponse): void {
  if (response.destroyed || response.writableEnded) return;
  const body = result.body === undefined ? undefined : JSON.stringify(result.body);
  response.writeHead(result.status, {
    ...(body === undefined ? {} : { "content-type": "application/json; charset=utf-8" }),
    "cache-control": "no-store",
    ...result.headers,
  });
  response.end(body);
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(port, BRIDGE_HOST, () => {
      server.off("error", onError);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Bridge did not receive a TCP address"));
        return;
      }
      resolve(address.port);
    });
  });
}

function isAddressInUse(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EADDRINUSE";
}

export async function startBridge(options: StartBridgeOptions): Promise<BridgeRuntime> {
  const preferredPort = options.preferredPort ?? DEFAULT_BRIDGE_PORT;
  validatePort(preferredPort);
  const token = (options.tokenFactory ?? randomUUID)();
  const tokens: BridgeTokens = { full: token, command: (options.commandTokenFactory ?? randomUUID)() };
  const activatedAt = (options.now ?? (() => new Date()))().toISOString();
  const activeRequests = new Set<AbortController>();
  const activeResponses = new Set<ServerResponse>();
  let stopping = false;

  const server = createServer(async (request, response) => {
    activeResponses.add(response);
    response.once("close", () => activeResponses.delete(response));

    const url = new URL(request.url ?? "/", `http://${BRIDGE_HOST}`);
    const outcome = authorize(request.headers.authorization, tokens, url.pathname);
    if (outcome === "unauthorized") {
      writeResponse(response, protocolError(401, "unauthorized", "Bearer authentication is required"));
      return;
    }
    if (outcome === "out-of-scope") {
      writeResponse(response, protocolError(403, "forbidden", "This credential only authorizes the command endpoint"));
      return;
    }

    const controller = new AbortController();
    activeRequests.add(controller);
    const abort = (): void => controller.abort();
    request.once("aborted", abort);
    response.once("close", abort);

    try {
      const body = await readBody(request);
      const result = await options.handler({
        method: request.method ?? "GET",
        url,
        headers: request.headers,
        body,
        signal: controller.signal,
      });
      writeResponse(response, result);
    } catch (error) {
      if (error instanceof MalformedRequestError) {
        writeResponse(response, protocolError(400, "malformed-request", error.message));
      } else if (!stopping) {
        options.logger?.error(redactSecret(redactSecret("Bridge request failed", token), tokens.command));
        writeResponse(response, protocolError(500, "internal-error", "The bridge could not process the request"));
      }
    } finally {
      request.off("aborted", abort);
      activeRequests.delete(controller);
    }
  });

  let port: number;
  try {
    port = await listen(server, preferredPort);
  } catch (error) {
    if (!isAddressInUse(error) || preferredPort === 0) throw error;
    port = await listen(server, 0);
  }

  const metadata: BridgeDiscoveryMetadata = {
    version: 1,
    host: BRIDGE_HOST,
    port,
    token,
    activatedAt,
  };
  try {
    await options.persistence.write(metadata);
  } catch {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("Bridge discovery metadata could not be persisted");
  }
  options.logger?.info(`Bridge listening on ${BRIDGE_HOST}:${port}`);

  let stopPromise: Promise<void> | undefined;
  return {
    host: BRIDGE_HOST,
    port,
    token,
    commandToken: tokens.command,
    stop(): Promise<void> {
      stopPromise ??= (async () => {
        stopping = true;
        for (const controller of activeRequests) controller.abort();
        for (const response of activeResponses) response.destroy();
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => error === undefined ? resolve() : reject(error));
        });
        try {
          await options.persistence.clear();
        } catch {
          options.logger?.error("Bridge discovery metadata could not be cleared");
        }
      })();
      return stopPromise;
    },
  };
}

export const notFoundHandler: BridgeRequestHandler = () =>
  protocolError(404, "not-found", "Route not found");
