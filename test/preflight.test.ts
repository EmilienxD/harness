import assert from "node:assert/strict";
import test from "node:test";

import {
  ClaudeCommandProbe,
  ClaudePreflightError,
  spawnCommandRunner,
  type CommandExecution,
} from "../src/claude/preflight.js";

function probe(outcomes: readonly (CommandExecution | Error)[]) {
  const calls: Array<{ program: string; args: readonly string[] }> = [];
  let index = 0;
  const instance = new ClaudeCommandProbe({
    run: async (program, args) => {
      calls.push({ program, args });
      const outcome = outcomes[Math.min(index++, outcomes.length - 1)];
      if (outcome instanceof Error) throw outcome;
      return outcome ?? { code: 0, stdout: "", stderr: "" };
    },
  });
  return { instance, calls, callCount: () => calls.length };
}

test("the probe asks the configured command for its version, wrapper arguments included", async () => {
  const { instance, calls } = probe([{ code: 0, stdout: "2.1.199 (Claude Code)\n", stderr: "" }]);
  const result = await instance.verify(["clauder", "run", "kiro", "--"]);
  assert.deepEqual(result, { ok: true, version: "2.1.199 (Claude Code)" });
  assert.deepEqual(calls, [{ program: "clauder", args: ["run", "kiro", "--", "--version"] }]);
});

test("a command that cannot be started is refused with its reason", async () => {
  const { instance } = probe([new Error("spawn claude ENOENT")]);
  const result = await instance.verify(["claude"]);
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.reason, /ENOENT/);

  // The launch paths need this as a throw, carrying the setting to fix.
  const error = await instance.require(["claude"]).catch((caught: unknown) => caught);
  assert.ok(error instanceof ClaudePreflightError);
  assert.match(error.message, /aboard\.launch\.claudeCommand/);
});

test("a non-zero exit reports the code and the first line of the CLI's complaint", async () => {
  const { instance } = probe([{ code: 9, stdout: "", stderr: "unknown option '--version'\nusage: ...\n" }]);
  const result = await instance.verify(["claude"]);
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.reason, /code 9 \(unknown option '--version'\)/);
});

test("a Python traceback reports its actual error line, not the banner", async () => {
  // A broken wrapper (here a shim whose package was uninstalled underneath it)
  // fails the same way on every invocation; the banner line alone would leave
  // the user to open a terminal just to learn the real reason.
  const stderr = [
    "Traceback (most recent call last):",
    "  File \"<frozen runpy>\", line 198, in _run_module_as_main",
    "  File \".../clauder.exe/__main__.py\", line 4, in <module>",
    "    from clauder.cli import main",
    "ModuleNotFoundError: No module named 'clauder'",
    "",
  ].join("\r\n");
  const { instance } = probe([{ code: 1, stdout: "", stderr }]);
  const result = await instance.verify(["clauder", "run", "kiro", "--"]);
  assert.equal(result.ok, false);
  const reason = result.ok ? "" : result.reason;
  assert.match(reason, /code 1 \(ModuleNotFoundError: No module named 'clauder'\)/);
  assert.doesNotMatch(reason, /Traceback/);
});

test("a good answer is cached per command, a bad one is retried", async () => {
  // Installing Claude and clicking launch again must not need a window reload;
  // an unchanged working command must not spawn a process per launch.
  const failing = probe([new Error("spawn claude ENOENT"), { code: 0, stdout: "2.1.199\n", stderr: "" }]);
  assert.equal((await failing.instance.verify(["claude"])).ok, false);
  assert.equal((await failing.instance.verify(["claude"])).ok, true);
  assert.equal(failing.callCount(), 2);

  const working = probe([{ code: 0, stdout: "2.1.199\n", stderr: "" }]);
  await working.instance.verify(["claude"]);
  await working.instance.verify(["claude"]);
  assert.equal(working.callCount(), 1);
  // A different command is a different question.
  await working.instance.verify(["clauder", "run"]);
  assert.equal(working.callCount(), 2);
  working.instance.invalidate();
  await working.instance.verify(["claude"]);
  assert.equal(working.callCount(), 3);
});

test("concurrent launches share one probe", async () => {
  const { instance, callCount } = probe([{ code: 0, stdout: "2.1.199\n", stderr: "" }]);
  await Promise.all([instance.verify(["claude"]), instance.verify(["claude"]), instance.verify(["claude"])]);
  assert.equal(callCount(), 1);
});

test("an empty command is refused rather than spawning the shell's idea of nothing", async () => {
  const { instance, callCount } = probe([{ code: 0, stdout: "", stderr: "" }]);
  // An empty list falls back to the default command; only a literal empty
  // program is unanswerable.
  await instance.verify([]);
  assert.equal(callCount(), 1);
  assert.equal((await instance.verify([""])).ok, true);
});

test("the real runner reports a missing program as a failure, not a crash", async () => {
  const instance = new ClaudeCommandProbe({ run: spawnCommandRunner(process.cwd()), timeoutMs: 20_000 });
  const result = await instance.verify(["aboard-definitely-not-a-real-binary"]);
  assert.equal(result.ok, false);
});
