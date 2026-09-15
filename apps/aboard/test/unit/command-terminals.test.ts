import assert from "node:assert/strict";
import test from "node:test";

import type { TerminalCreationOptions, TerminalHandle, TerminalHost } from "../../src/platform/terminals.js";
import {
  CommandTerminalService,
  createCommandRoutes,
  type CommandTerminalId,
} from "../../src/bridge/command-terminals.js";
import type { AuthenticatedBridgeRequest, BridgeResponse } from "../../src/bridge/protocol.js";

class FakeTerminal implements TerminalHandle {
  public readonly sent: Array<{ text: string; addNewLine: boolean | undefined }> = [];
  public readonly shows: Array<boolean | undefined> = [];
  public disposed = false;
  public processId: PromiseLike<number | undefined> = Promise.resolve(4242);
  public exitStatus: { code: number | undefined } | undefined;

  public sendText(text: string, addNewLine?: boolean): void {
    this.sent.push({ text, addNewLine });
  }

  public show(preserveFocus?: boolean): void {
    this.shows.push(preserveFocus);
  }

  public dispose(): void {
    this.disposed = true;
  }
}

class FakeTerminalHost implements TerminalHost {
  public readonly created: Array<{ options: TerminalCreationOptions; terminal: FakeTerminal }> = [];
  #listener: ((terminal: TerminalHandle) => void) | undefined;

  public createTerminal(options: TerminalCreationOptions): TerminalHandle {
    const terminal = new FakeTerminal();
    this.created.push({ options, terminal });
    return terminal;
  }

  public onDidCloseTerminal(listener: (terminal: TerminalHandle) => void): { dispose(): void } {
    this.#listener = listener;
    return { dispose: () => { this.#listener = undefined; } };
  }

  public close(terminal: FakeTerminal, exitCode?: number): void {
    terminal.exitStatus = { code: exitCode };
    this.#listener?.(terminal);
  }
}

function setup(directoryExists?: (path: string) => boolean) {
  const host = new FakeTerminalHost();
  let id = 0;
  const service = new CommandTerminalService({
    host,
    defaultCwd: () => "C:\\work\\aboard",
    idFactory: () => `command-${++id}` as CommandTerminalId,
    now: () => new Date("2026-08-22T09:00:00.000Z"),
    ...(directoryExists === undefined ? {} : { directoryExists }),
  });
  return { host, service, routes: createCommandRoutes(service) };
}

function request(method: string, path: string, body?: unknown): AuthenticatedBridgeRequest {
  return {
    method,
    url: new URL(path, "http://127.0.0.1"),
    headers: {},
    body,
    signal: new AbortController().signal,
  };
}

function errorCode(response: BridgeResponse): string {
  const body = response.body as { error?: { code?: string } } | undefined;
  return body?.error?.code ?? "";
}

test("runs a command in a visible terminal that carries no aboard identity", async () => {
  const { host, routes } = setup();

  const response = await routes(request("POST", "/commands", {
    command: "npm run dev",
    name: "backend setup",
    cwd: "C:\\work\\backend",
    env: { PORT: "8080" },
  }));

  assert.equal(response.status, 201);
  assert.deepEqual(response.body, {
    commandTerminalId: "command-1",
    name: "backend setup",
    command: "npm run dev",
    cwd: "C:\\work\\backend",
    status: "open",
    createdAt: "2026-08-22T09:00:00.000Z",
    closedAt: null,
    exitCode: null,
  });
  const created = host.created[0];
  assert.equal(created?.options.cwd, "C:\\work\\backend");
  assert.equal(created?.options.name, "backend setup");
  // Exhaustive: a script's terminal never receives bridge credentials or an
  // agent identity, so nothing launched from it can pose as an aboard agent.
  assert.deepEqual(created?.options.env, { PORT: "8080" });
  assert.deepEqual(created?.terminal.shows, [false]);
  assert.deepEqual(created?.terminal.sent, [{ text: "npm run dev", addNewLine: true }]);
});

test("defaults to the workspace root, a generic label, and a revealed terminal", async () => {
  const { host, routes } = setup();

  const response = await routes(request("POST", "/commands", { command: "npm install" }));

  assert.equal(response.status, 201);
  assert.equal((response.body as { cwd: string }).cwd, "C:\\work\\aboard");
  assert.equal(host.created[0]?.options.name, "aboard: command");
  assert.deepEqual(host.created[0]?.terminal.shows, [false]);
});

test("show: false leaves the terminal running without stealing the user's focus", async () => {
  const { host, routes } = setup();

  await routes(request("POST", "/commands", { command: "npm install", show: false }));

  assert.deepEqual(host.created[0]?.terminal.shows, []);
  assert.deepEqual(host.created[0]?.terminal.sent, [{ text: "npm install", addNewLine: true }]);
});

test("rejects malformed run requests without opening a terminal", async () => {
  const { host, routes } = setup();

  for (const body of [
    undefined,
    "npm install",
    {},
    { command: "   " },
    { command: "npm install\nrm -rf ." },
    { command: "npm install", name: "" },
    { command: "npm install", cwd: 7 },
    { command: "npm install", show: "yes" },
    { command: "npm install", env: { PORT: 8080 } },
    { command: "npm install", env: { "": "8080" } },
  ]) {
    const response = await routes(request("POST", "/commands", body));
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(errorCode(response), "invalid-request");
  }
  assert.equal(host.created.length, 0);
});

test("reports a directory that does not exist instead of opening a broken terminal", async () => {
  const { host, routes } = setup((path) => path === "C:\\work\\aboard");

  const response = await routes(request("POST", "/commands", { command: "npm install", cwd: "C:\\nope" }));

  assert.equal(response.status, 400);
  assert.equal(errorCode(response), "invalid-request");
  assert.equal(host.created.length, 0);
});

test("lists, reveals, and kills command terminals by id", async () => {
  const { host, routes } = setup();
  await routes(request("POST", "/commands", { command: "npm install" }));

  const listed = await routes(request("GET", "/commands"));
  assert.equal(listed.status, 200);
  assert.equal((listed.body as { commandTerminals: unknown[] }).commandTerminals.length, 1);

  assert.equal((await routes(request("GET", "/commands/command-1"))).status, 200);

  assert.equal((await routes(request("POST", "/commands/command-1/show"))).status, 200);
  assert.deepEqual(host.created[0]?.terminal.shows, [false, false]);

  assert.equal((await routes(request("DELETE", "/commands/command-1"))).status, 200);
  assert.equal(host.created[0]?.terminal.disposed, true);
});

test("a closed terminal keeps its exit code and refuses further control", async () => {
  const { host, routes } = setup();
  await routes(request("POST", "/commands", { command: "npm install" }));
  const terminal = host.created[0]!.terminal;

  host.close(terminal, 3);

  const snapshot = await routes(request("GET", "/commands/command-1"));
  assert.equal(snapshot.status, 200);
  assert.deepEqual(snapshot.body, {
    commandTerminalId: "command-1",
    name: "aboard: command",
    command: "npm install",
    cwd: "C:\\work\\aboard",
    status: "closed",
    createdAt: "2026-08-22T09:00:00.000Z",
    closedAt: "2026-08-22T09:00:00.000Z",
    exitCode: 3,
  });
  const showed = await routes(request("POST", "/commands/command-1/show"));
  assert.equal(showed.status, 409);
  assert.equal(errorCode(showed), "terminal-closed");
});

test("an unknown id is a 404 and an unrelated path is left to other handlers", async () => {
  const { routes } = setup();

  const unknown = await routes(request("GET", "/commands/command-9"));
  assert.equal(unknown.status, 404);
  assert.equal(errorCode(unknown), "not-found");

  assert.equal((await routes(request("GET", "/terminals"))).status, 404);
  assert.equal((await routes(request("PUT", "/commands"))).status, 404);
});
