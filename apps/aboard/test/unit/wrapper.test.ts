import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

import { lockMarkerDirectory, lockMarkerPresent, sessionExitFailure, sessionLaunchFailure, sessionWrapperLayout, takeSessionExitRecord, watchLockMarkers } from "../../src/runtime/lock-markers.js";

const WRAPPER = join(process.cwd(), "assets", "runtime", "abd_wrapper.py");

test("each Aboard launch gets a fresh one-time code", () => {
  const layout = sessionWrapperLayout("C:\\storage\\runtime", WRAPPER);
  const first = layout.mintLaunchCode();
  const second = layout.mintLaunchCode();
  assert.notEqual(first, second);
  assert.match(first, /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
});

function uv(args: readonly string[], options: { readonly input?: string; readonly env?: NodeJS.ProcessEnv } = {}) {
  return spawnSync("uv", ["run", "--no-project", "python", ...args], { input: options.input, encoding: "utf8", env: options.env });
}

test("wrapper owns the marker for exactly the child's lifetime", async () => {
  const root = mkdtempSync(join(tmpdir(), "aboard-wrapper-"));
  const lock = join(root, "locks", "a1.lock");
  // A child that sleeps: the marker must exist while it runs and vanish the
  // moment it exits, whatever the exit reason.
  const child = spawn("uv", ["run", "--no-project", "python", WRAPPER, lock, "--", process.execPath, "-e", "setTimeout(() => {}, 10000)"], { stdio: "ignore" });
  try {
    // The marker is written before the spawn and rewritten with the child's pid,
    // so "the file exists" and "the child is known" are two different moments.
    const deadline = Date.now() + 10_000;
    let marker: Record<string, unknown> = {};
    while (typeof marker.childPid !== "number") {
      if (Date.now() > deadline) throw new Error("marker never named a child");
      if (existsSync(lock)) {
        try { marker = JSON.parse(readFileSync(lock, "utf8")) as Record<string, unknown>; } catch { /* mid-write */ }
      }
      if (typeof marker.childPid !== "number") await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(typeof marker.wrapperPid, "number");
    assert.equal(marker.agentId, null);

    // exit code, killed child, crashed child: every ending removes the marker.
    process.kill(marker.childPid as number);
    const closed = await new Promise<number | null>((resolve) => child.once("close", resolve));
    assert.equal(typeof closed, "number");
    assert.equal(existsSync(lock), false);

    // ... and leaves the exit record behind for the extension to read.
    const record = takeSessionExitRecord(lock);
    assert.notEqual(record, undefined);
    assert.equal(typeof record?.exitCode, "number");
    assert.equal(takeSessionExitRecord(lock), undefined, "the record is consumed");
  } finally {
    child.kill();
    rmSync(root, { recursive: true, force: true });
  }
});

test("marker removal wakes the watcher long before the next poll interval", async () => {
  const root = mkdtempSync(join(tmpdir(), "aboard-markers-"));
  const directory = lockMarkerDirectory(root);
  mkdirSync(directory, { recursive: true });
  let sweeps = 0;
  const watching = watchLockMarkers(directory, () => { sweeps += 1; }, 10);
  const lock = join(directory, "a1.lock");
  try {
    writeFileSync(lock, "{}");
    assert.equal(lockMarkerPresent(lock), true);
    rmSync(lock);
    const deadline = Date.now() + 5_000;
    while (sweeps === 0) {
      if (Date.now() > deadline) throw new Error("marker removal did not wake the watcher");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(lockMarkerPresent(lock), false);
  } finally {
    watching.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the watch leaves an uninitialized workspace untouched and attaches once the directory appears", async () => {
  const root = mkdtempSync(join(tmpdir(), "aboard-markers-"));
  const directory = lockMarkerDirectory(root);
  let sweeps = 0;
  const watching = watchLockMarkers(directory, () => { sweeps += 1; }, 10, 20);
  try {
    // Activation in a project that was never initialized must not create `.abd/`.
    assert.equal(existsSync(join(root, ".abd")), false);

    // A launch creates it, as the wrapper does; the watch must pick it up.
    mkdirSync(directory, { recursive: true });
    const lock = join(directory, "a1.lock");
    const deadline = Date.now() + 5_000;
    while (sweeps === 0) {
      if (Date.now() > deadline) throw new Error("watch never attached to the created directory");
      writeFileSync(lock, "{}");
      rmSync(lock, { force: true });
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  } finally {
    watching.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a command that cannot be spawned is reported in the exit record", () => {
  // The shell found the wrapper but not Claude. Nothing else observes this:
  // no TUI, no hook, no session.
  const root = mkdtempSync(join(tmpdir(), "aboard-wrapper-"));
  const lock = join(root, "a.lock");
  try {
    const result = uv([WRAPPER, lock, "--", join(root, "definitely-not-claude")]);
    assert.equal(result.status, 127);
    assert.equal(existsSync(lock), false);
    const record = takeSessionExitRecord(lock);
    assert.equal(record?.exitCode, 127);
    // The OS phrases this in the user's own language, so only its presence is
    // asserted; the extension surfaces the text verbatim.
    assert.ok((record?.error ?? "").length > 0, "the spawn error is recorded");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("wrapper exits 2 on a malformed invocation and never touches the marker", () => {
  const result = uv([WRAPPER, "only-lock-path"]);
  assert.equal(result.status, 2);
});

test("wrapper returns the child's exit code", () => {
  const root = mkdtempSync(join(tmpdir(), "aboard-wrapper-"));
  const lock = join(root, "a.lock");
  try {
    const ok = uv([WRAPPER, lock, "--", process.execPath, "-e", "process.exit(0)"]);
    assert.equal(ok.status, 0);
    assert.equal(existsSync(lock), false);
    const bad = uv([WRAPPER, lock, "--", process.execPath, "-e", "process.exit(7)"]);
    assert.equal(bad.status, 7);
    assert.equal(existsSync(lock), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("only nonzero proven-session exits are classified as process failures", () => {
  assert.equal(sessionExitFailure(undefined), undefined);
  assert.equal(sessionExitFailure({ exitCode: null }), undefined);
  assert.equal(sessionExitFailure({ exitCode: 0 }), undefined);
  assert.equal(sessionExitFailure({ exitCode: 23 }), "the agent process exited with code 23");
  assert.equal(
    sessionExitFailure({ exitCode: 127, error: "runtime missing" }),
    "the configured agent command could not be started (runtime missing)",
  );
});

test("a clean exit before lifecycle startup is a user-ended launch, not a launch failure", () => {
  assert.equal(sessionLaunchFailure({ exitCode: 0 }), undefined);
  assert.equal(sessionLaunchFailure({ exitCode: 23 }), "exited with code 23 before starting a session");
  assert.equal(sessionLaunchFailure({ exitCode: 0, error: "wrapper failed" }), "could not be started (wrapper failed)");
  assert.equal(sessionLaunchFailure(undefined), "exited with code unknown before starting a session");
});

test("wrapper consumes a request file and runs its exact argv", () => {
  const root = mkdtempSync(join(tmpdir(), "aboard-wrapper-"));
  const lock = join(root, "a.lock");
  const request = join(root, "launch.json");
  try {
    writeFileSync(request, JSON.stringify({ command: [process.execPath, "-e", "process.exit(6)"] }));
    const result = uv([WRAPPER, lock, "--request", request]);
    assert.equal(result.status, 6);
    assert.equal(existsSync(request), false, "launch argv is removed once consumed");
    assert.equal(existsSync(lock), false);
    assert.equal(uv([WRAPPER, lock, "--request", request]).status, 2, "the visible command cannot be replayed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows wrapper preserves exact argv through an npm command shim", { skip: process.platform !== "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "aboard-wrapper-npm-"));
  const lock = join(root, "a.lock");
  const request = join(root, "launch.json");
  const output = join(root, "argv.json");
  const entry = join(root, "node_modules", "example-cli", "bin", "cli.js");
  const args = [
    "-c",
    'hooks.SessionStart=[{matcher="startup|resume",hooks=[{command="echo (ready) ^ now"}]}]',
    "prompt with spaces & punctuation",
  ];
  try {
    mkdirSync(join(root, "node_modules", "example-cli", "bin"), { recursive: true });
    writeFileSync(entry, `require("node:fs").writeFileSync(${JSON.stringify(output)}, JSON.stringify(process.argv.slice(2)))`);
    writeFileSync(join(root, "example-cli.cmd"), `@ECHO off\nSETLOCAL\nSET "_prog=node"\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\example-cli\\bin\\cli.js" %*\n`);
    writeFileSync(request, JSON.stringify({ command: ["example-cli", ...args] }));
    const env = { ...process.env, PATH: `${root}${delimiter}${process.env.PATH ?? ""}` };

    const result = uv([WRAPPER, lock, "--request", request], { env });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), args);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows wrapper falls through an unknown shim to a native executable", { skip: process.platform !== "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "aboard-wrapper-native-"));
  const shimDirectory = join(root, "shim");
  const nativeDirectory = join(root, "native");
  const lock = join(root, "a.lock");
  const request = join(root, "launch.json");
  const output = join(root, "native.txt");
  try {
    mkdirSync(shimDirectory);
    mkdirSync(nativeDirectory);
    writeFileSync(join(shimDirectory, "example-cli.cmd"), "@ECHO off\r\nexit /b 99\r\n");
    copyFileSync(process.execPath, join(nativeDirectory, "example-cli.exe"));
    writeFileSync(request, JSON.stringify({
      command: ["example-cli", "-e", `require("node:fs").writeFileSync(${JSON.stringify(output)}, "native")`],
    }));
    const env = { ...process.env, PATH: `${shimDirectory}${delimiter}${nativeDirectory}${delimiter}${process.env.PATH ?? ""}` };

    const result = uv([WRAPPER, lock, "--request", request], { env });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(output, "utf8"), "native");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("only one concurrent wrapper can claim a launch request", async () => {
  const root = mkdtempSync(join(tmpdir(), "aboard-wrapper-"));
  const request = join(root, "launch-once.json");
  const proof = join(root, "started.txt");
  writeFileSync(request, JSON.stringify({
    command: [process.execPath, "-e", `require("node:fs").appendFileSync(${JSON.stringify(proof)}, "started\\n")`],
  }));
  const run = (suffix: string) => new Promise<number | null>((resolve) => {
    const child = spawn("uv", ["run", "--no-project", "python", WRAPPER, join(root, `${suffix}.lock`), "--request", request], { stdio: "ignore" });
    child.once("close", resolve);
  });
  try {
    const statuses = await Promise.all([run("one"), run("two")]);
    assert.deepEqual(statuses.sort(), [0, 2]);
    assert.equal(readFileSync(proof, "utf8"), "started\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
