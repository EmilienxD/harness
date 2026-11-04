import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { SessionListConnection } from "../../src/chatgpt/session-list-connection.js";

test("Codex listing reuses one initialized process for multiple metadata pages and cancels pending requests", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aboard-list-transport-"));
  const script = join(directory, "server.cjs");
  await writeFile(script, `
    const readline = require('node:readline');
    let initialized = 0;
    readline.createInterface({input:process.stdin}).on('line', line => {
      const request = JSON.parse(line);
      if (request.method === 'initialize') initialized++;
      if (request.id === undefined || request.method === 'wait') return;
      process.stdout.write(JSON.stringify({id:request.id,result:{pid:process.pid,initialized}})+'\\n');
    });
  `);
  const abort = new AbortController();
  const connection = new SessionListConnection([process.execPath, script], directory, abort.signal);
  const closed = once(connection.child, "close");
  try {
    const request = { command: [process.execPath, script], cwd: directory, method: "thread/list", params: {} };
    const first = await connection.exchange(request) as { pid: number; initialized: number };
    const second = await connection.exchange(request) as { pid: number; initialized: number };
    assert.equal(first.pid, second.pid);
    assert.equal(first.initialized, 1);
    assert.equal(second.initialized, 1);
    const pending = connection.exchange({ ...request, method: "wait" });
    abort.abort();
    await assert.rejects(pending, /cancelled|closed/u);
  } finally {
    connection.dispose(); await closed;
    await rm(directory, { recursive: true, force: true });
  }
});
