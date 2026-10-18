import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { findHarnessRoot, runFixtureInstaller } from "../../core/installer.js";
import { spawnableCommand } from "../../core/path.js";
import { createPiFixture } from "../../core/pi-fixture.js";
import { type PiScenarioStep } from "../../core/pi-scenario.js";
import { backgroundScenario, marker } from "./scenario.js";

async function piPackageRoot(): Promise<string> {
  const command = spawnableCommand("pi", []);
  let root = dirname(await realpath(command.args[0] ?? command.file));
  while (true) {
    try {
      if (JSON.parse(await readFile(join(root, "package.json"), "utf8")).name === "@earendil-works/pi-coding-agent") return root;
    } catch { /* ascend from the CLI entry */ }
    const parent = dirname(root);
    if (parent === root) throw new Error("Background shell component checks require Pi's installed npm SDK");
    root = parent;
  }
}

const worker = `
const fs = require('node:fs');
const cp = require('node:child_process');
const [mode, duration] = process.argv.slice(2);
fs.writeFileSync('started-' + mode + '.json', JSON.stringify({pid:process.pid, model:process.env.PI_MODEL, prefix:process.env.HARNESS_BACKGROUND_PREFIX}));
fs.appendFileSync('launches-' + mode, process.pid + '\\n');
if (mode.startsWith('auto')) console.log('BEFORE:' + process.pid);
if (['cancel','foreground-cancel','hard-foreground','auto-deadline','shutdown','reload','tree','switch'].includes(mode)) {
  const child = cp.spawn(process.execPath, ['-e', "setTimeout(()=>require('node:fs').writeFileSync('orphan-'+process.argv[1],'bad'),6000)", mode], {stdio:'ignore'});
  fs.writeFileSync('child-' + mode + '.json', JSON.stringify({pid:child.pid}));
}
const finish = () => {
  if(mode === 'large') process.stdout.write('x'.repeat(17 * 1024 * 1024));
  fs.writeFileSync('effect-' + mode, 'done');
  console.log('RESULT:' + mode + ':雪');
  process.exit(mode === 'failure' ? 7 : 0);
};
if (mode === 'busy') {
  const ready = setInterval(() => {
    if (!fs.existsSync('started-busy-work.json')) return;
    clearInterval(ready);
    setTimeout(finish, Number(duration));
  }, 20);
} else setTimeout(finish, Number(duration));
`;

export async function runPiBackgroundShellJourney(scope: "project" | "user", shell: "bash" | "powershell") {
  const quote = (value: string) => `'${value.replaceAll("'", "'\''")}'`;
  const command = (mode: string, ms: number) => `${shell === "powershell" ? "& " : ""}${quote(process.execPath)} worker.cjs ${mode} ${ms}`;
  const step = (name: string, ms: number, extra = {}): PiScenarioStep => ({ checkpoint: name, tool: shell, input: { command: command(name, ms), run_in_background: true, ...extra } });
  const routes: Record<string, readonly PiScenarioStep[]> = {
    busy: [step("busy", 400),
      { checkpoint: "busy-foreground", tool: shell, input: { command: command("busy-work", 1800) } },
      { checkpoint: "busy-observed", tool: "write", input: { path: "busy-observed.txt", content: "completion observed mid-task" } }],
    foreground: [{ checkpoint: "foreground", tool: shell, input: { command: command("foreground", 10) } }],
    "foreground-failure": [{ checkpoint: "foreground-failure", tool: shell, input: { command: command("failure", 10), timeout: 5 } }],
    "hard-foreground": [{ checkpoint: "hard-foreground", tool: shell, input: { command: command("hard-foreground", 10000), timeout: 1 } }],
    "equal-deadlines": [{ checkpoint: "equal-deadlines", tool: shell, input: { command: command("equal-deadlines", 10000), timeout: 1.5 } }],
    auto: [{ checkpoint: "auto", tool: shell, input: { command: command("auto", 2200) } }],
    "auto-failure": [{ checkpoint: "auto-failure", tool: shell, input: { command: command("auto-failure", 2200) + "; exit 7" } }],
    "auto-deadline": [{ checkpoint: "auto-deadline", tool: shell, input: { command: command("auto-deadline", 10000), timeout: 3 } }],
    "background-deadline": [step("background-deadline", 10000, { timeout: 0.6 })],
    success: [step("success", scope === "project" ? 26000 : 1800)],
    failure: [step("failure", 1200)],
    timeout: [step("timeout", 10000, { timeout: 0.6 })],
    large: [step("large", 1200)],
    denied: [{ checkpoint: "denied", tool: shell, input: { command: command("denied", 10) + " # forbidden-marker", run_in_background: true } }],
    malformed: [{ checkpoint: "invalid-timeout", tool: shell, input: { command: command("invalid", 10), run_in_background: true, timeout: -1 } }],
    cancel: [{ checkpoint: "cancel", tool: shell, input: { command: command("cancel", 10000) } }],
    reload: [{ checkpoint: "reload", tool: shell, input: { command: command("reload", 10000) } }], shutdown: [step("shutdown", 10000)],
    tree: [step("tree", 10000)], switch: [step("switch", 10000)],
    nested: [{ checkpoint: "nested-background", tool: "background_nested", input: {} }],
    "nested-auto": [{ checkpoint: "nested-auto", tool: "background_nested_auto", input: {} }],
    "foreground-cancel": [{ checkpoint: "foreground-cancel", tool: "background_nested_cancel", input: {} }],
    "auto-denied": [{ checkpoint: "auto-denied", tool: shell, input: { command: command("auto-denied", 10000) + " # forbidden-marker" } }],
    "nested-denied": [{ checkpoint: "nested-denied", tool: "background_nested_denied", input: {} }],
    "ps-error": [{ checkpoint: "powershell-error", tool: shell,
      input: { command: "Start-Sleep -Milliseconds 1200; Write-Error 'fixture command failed'", run_in_background: true } }],
    chat: [],
  };
  const fixture = await createPiFixture(backgroundScenario((route, request) => {
    const advertised = request.tools.find((item) => item.name === shell);
    assert.ok(advertised, "Selected shell must remain model-visible");
    const parameters = advertised.parameters as { properties?: Record<string, { type?: string }> };
    assert.equal(parameters.properties?.run_in_background?.type, "boolean");
    assert.equal(parameters.properties?.timeout?.type, "number");
    assert.equal(parameters.properties?.execution_timeout, undefined);
    assert.equal(request.tools.some(item => item.name === "shell_job"), false);
    for (const name of ["get_background_shell_status", "cancel_background_shell"]) {
      const tool = request.tools.find(item => item.name === name);
      assert.ok(tool);
      const schema = tool.parameters as { required?: string[]; properties?: Record<string, { type?: string }> };
      assert.deepEqual(schema.required, ["id"]);
      assert.equal(schema.properties?.id?.type, "string");
      if (name === "get_background_shell_status") assert.equal(schema.properties?.show_output?.type, "boolean");
    }
    if (route === "cancel-now" || route === "inspect") {
      const launches = request.input.filter((item) => item.type === "function_call_output").map((item) => {
        try { return JSON.parse(String(item.output)) as { id?: string }; } catch { return {}; }
      }).filter((item) => item.id);
      const id = launches.at(-1)?.id;
      assert.ok(id);
      return route === "cancel-now" ? [{ checkpoint: "cancel-job", tool: "cancel_background_shell", input: { id } }]
        : [undefined, false, true].map((show_output, index) => ({ checkpoint: `inspect-${index}`, tool: "get_background_shell_status", input: show_output === undefined ? { id } : { id, show_output } }));
    }
    const steps = routes[route];
    if (!steps) throw new Error("Unknown background scenario route");
    return steps;
  }));
  try {
    const { workspace } = fixture;
    const project = workspace.projectRoot;
    await writeFile(join(project, "worker.cjs"), worker);
    const probe = join(project, ".pi/extensions/background-lifecycle-probe");
    await mkdir(probe, { recursive: true });
    await writeFile(join(probe, "index.ts"), `import {Type} from 'typebox';
    export default function(pi) {
      for(const [name,command] of ${JSON.stringify([
        ["background_nested", command("nested", 1500)],
        ["background_nested_auto", command("nested-auto", 3000)],
        ["background_nested_cancel", command("foreground-cancel", 10000)],
        ["background_nested_denied", command("nested-denied", 10) + " # forbidden-marker"],
      ])}) pi.registerTool({name,label:name,description:'Fixture nested shell call',parameters:Type.Object({}),
        async execute(_id,_args,signal,_update,ctx){
          const controller=new AbortController();
          const auto=name==='background_nested_auto';
          const cancel=name==='background_nested_cancel';
          const timer=cancel?setTimeout(()=>controller.abort(),1200):undefined;
          try {
            const outcome=await ctx.executeTool(${JSON.stringify(shell)},auto?{command}:cancel?{command}:{command,run_in_background:true},{signal:auto||cancel?controller.signal:signal});
            if(auto)controller.abort();
            return {...outcome.result,isError:outcome.isError};
          } finally {clearTimeout(timer);}
        }});
      pi.registerCommand('bg-reload', {handler:async(_,ctx)=>ctx.reload()});
      pi.registerCommand('bg-anchor', {handler:()=>pi.appendEntry('bg-anchor',{})});
      pi.registerCommand('bg-back', {handler:async(_,ctx)=>{
        const anchor=ctx.sessionManager.getEntries().find(e=>e.type==='custom'&&e.customType==='bg-anchor');
        await ctx.navigateTree(anchor.id,{summarize:false});
      }});
    }`);
    const settings = join(project, ".pi", "settings.json");
    const config = JSON.parse(await readFile(settings, "utf8"));
    config.defaultTools = ["read", "write", shell, "get_background_shell_status", "cancel_background_shell", "background_nested", "background_nested_auto", "background_nested_cancel", "background_nested_denied"];
    if (shell === "bash") {
      config.shellCommandPrefix = "export HARNESS_BACKGROUND_PREFIX=verified";
    }
    config.backgroundShell = { foregroundTimeout: 1.5 };
    await writeFile(settings, JSON.stringify(config));
    const before = await readFile(settings, "utf8");
    const instruction = join(project, "AGENTS.md");
    await writeFile(instruction, "Personal fixture instructions.\n");
    const extension = join(scope === "project" ? join(project, ".pi") : workspace.agentDir, "extensions/harness-background-shell/index.ts");
    await runFixtureInstaller(workspace, "install", ["background-shell"], { scope, dryRun: true });
    assert.equal(existsSync(extension), false);
    await runFixtureInstaller(workspace, "install", ["background-shell"], { scope });
    if (scope === "project") {
      await promisify(execFile)(process.execPath, [join(await findHarnessRoot(), "tests/e2e/tools/pi-background-shell/behavior-check.mjs"),
        await piPackageRoot(), extension], { cwd: project, env: workspace.env, windowsHide: true, timeout: 30000 });
    }
    const repeat = await runFixtureInstaller(workspace, "install", ["background-shell"], { scope });
    assert.equal((repeat.results as { status: string }[])[0]!.status, "unchanged");
    await runFixtureInstaller(workspace, "install", ["command-guard"]);
    await writeFile(join(project, ".harness/guards/command-guard.toml"), 'version = 1\n[[rules]]\nreason = "E2E denied"\npatterns = ["forbidden-marker"]\n');
    const rpc = fixture.rpc({ timeoutMs: 150000 });
    const discovery = await rpc.request("get_commands");
    assert.ok((discovery.data as { commands: { name: string }[] }).commands.some(({ name }) => name === "ps"));
    assert.equal((await rpc.prompt("/ps")).status, "handled");
    assert.equal(fixture.assertions().inferenceRequests, 0);
    let expectedRequests = 0;
    async function prompt(route: string, errors: boolean[] = [false]) {
      const run = await rpc.prompt(marker(route));
      assert.equal(run.status, "success", JSON.stringify({ checkpoints: fixture.assertions().checkpoints, reasons: run.assistantStopReasons,
        errors: run.events.filter((event) => event.type === "extension_error"), observations: fixture.assertions().observations.filter((item) => item.result === "rejected") }));
      assert.deepEqual(run.toolExecutions.map((item) => item.isError), errors);
      expectedRequests += errors.length + 1;
      return run;
    }
    async function idle() {
      for (let attempt = 0; attempt < 100; attempt++) {
        const state = (await rpc.request("get_state")).data as { isStreaming: boolean; pendingMessageCount: number };
        if (!state.isStreaming && !state.pendingMessageCount) return;
        await delay(50);
      }
      throw new Error("Automatic completion turn did not become idle");
    }
    await writeFile(settings, JSON.stringify({ ...config, backgroundShell: { foregroundTimeout: 5 } }));
    const busy = await prompt("busy", [false, false, false]);
    assert.equal(await readFile(join(project, "busy-observed.txt"), "utf8"), "completion observed mid-task");
    assert.equal(await readFile(join(project, "effect-busy"), "utf8"), "done");
    assert.equal(await readFile(join(project, "effect-busy-work"), "utf8"), "done");
    const completionIndex = busy.events.findIndex(event => event.type === "message_end" &&
      (event.message as { customType?: string })?.customType === "harness-background-shell-completion");
    const executions = busy.events.flatMap((event, index) => event.type === "tool_execution_end" ? [index] : []);
    assert.ok(completionIndex > executions[1]!, "Steering waits for the executing foreground tool");
    assert.ok(completionIndex < executions[2]!, "Completion must arrive before the next task step");
    assert.equal(busy.assistantStopReasons.filter(reason => reason === "stop").length, 1, "No redundant final responses");
    await idle();
    assert.equal(fixture.assertions().inferenceRequests, expectedRequests, "No completion-only follow-up after settlement");
    const delivered = await prompt("inspect", [false, false, false]);
    for (const event of delivered.events.filter(event => event.type === "tool_execution_end")) {
      const status = (event.result as { structuredContent: { state: string; notification_state: string } }).structuredContent;
      assert.equal(status.state, "completed");
      assert.equal(status.notification_state, "delivered", "A finalized completion must be acknowledged, not merely submitted");
    }
    await idle();
    assert.equal(fixture.assertions().inferenceRequests, expectedRequests);
    await writeFile(settings, before);
    const foreground = await prompt("foreground");
    const foregroundEnd = foreground.events.find((event) => event.type === "tool_execution_end")!;
    assert.equal((foregroundEnd.result as { structuredContent: { exit_code: number } }).structuredContent.exit_code, 0);
    assert.equal(await readFile(join(project, "effect-foreground"), "utf8"), "done");
    assert.ok(foreground.events.some((event) => event.type === "tool_execution_update"), "Foreground output must still stream");
    await prompt("foreground-cancel", [true, true]); expectedRequests--;
    assert.equal(existsSync(join(project, "child-foreground-cancel.json")), true, "Cancellation must exercise a running process tree");
    const failed = await prompt("foreground-failure", [true]);
    const failedEnd = failed.events.find((event) => event.type === "tool_execution_end")!;
    assert.equal((failedEnd.result as { structuredContent: { exit_code: number } }).structuredContent.exit_code, 7);
    for (const mode of ["hard-foreground", "equal-deadlines"]) {
      const hard = await prompt(mode, [true]);
      const end = hard.events.find((event) => event.type === "tool_execution_end")!;
      assert.equal((end.result as { structuredContent?: { id?: string } }).structuredContent?.id, undefined);
      assert.equal(existsSync(join(project, `effect-${mode}`)), false);
    }
    for (const mode of ["auto", "auto-failure", "auto-deadline", "background-deadline", "nested-auto", "success", "failure", "timeout", "large", "nested", ...(shell === "powershell" ? ["ps-error"] : [])]) {
      const nested = mode === "nested" || mode === "nested-auto";
      const launched = await prompt(mode, nested ? [false, false] : [false]);
      const launchEnd = launched.events.filter((event) => event.type === "tool_execution_end").at(-1)!;
      const launch = (launchEnd.result as { structuredContent: { id: string; log_path: string; output: string } }).structuredContent;
      assert.match(launch.id, /^[0-9a-f]{6}$/);
      // Nested tools are real executions, but only the outer call adds inference history.
      if (nested) expectedRequests--;
      if (mode === "auto") {
        assert.equal(existsSync(join(project, "effect-auto")), false, "Automatic handoff must return before the command finishes");
        assert.equal(existsSync(launch.log_path), true);
        await prompt("chat", []);
      }
      if (mode === "success") {
        assert.equal(existsSync(join(project, "effect-success")), false, "Background launch must return before completion");
        const inspected = await prompt("inspect", [false, false, false]);
        const reminder = inspected.events.find(event => event.type === "message_end" &&
          (event.message as { customType?: string })?.customType === "harness-background-shell-reminder");
        assert.ok(reminder, "A user turn with running commands must receive a count reminder");
        assert.deepEqual((reminder.message as { details: unknown }).details, { running_count: 1 });
        const statuses = inspected.events.filter(event => event.type === "tool_execution_end").map(event =>
          (event.result as { structuredContent: { id: string; state: string; output?: string } }).structuredContent);
        for (const status of statuses) { assert.equal(status.id, launch.id); assert.equal(status.state, "running"); }
        assert.equal(Object.hasOwn(statuses[0]!, "output"), false);
        assert.equal(Object.hasOwn(statuses[1]!, "output"), false);
        assert.equal(typeof statuses[2]!.output, "string");
        await prompt("chat", []);
      }
      const completionPath = join(project, `completion-${mode}.json`);
      await until(() => existsSync(completionPath), "Background completion did not wake Pi", 40000);
      const completion = JSON.parse(await readFile(completionPath, "utf8"));
      const timedOut = ["timeout", "auto-deadline", "background-deadline"].includes(mode);
      assert.equal(completion.state, timedOut ? "timed_out" : ["failure", "auto-failure", "ps-error"].includes(mode) ? "failed" : "completed");
      assert.equal(completion.exit_code, timedOut ? null : ["failure", "auto-failure"].includes(mode) ? 7 : mode === "ps-error" ? 1 : 0);
      if (!timedOut && mode !== "ps-error") assert.ok(completion.output.includes(`RESULT:${mode}:雪`));
      assert.equal(completion.id, launch.id);
      assert.equal(completion.log_path, launch.log_path);
      if (mode === "auto") {
        const started = JSON.parse(await readFile(join(project, "started-auto.json"), "utf8"));
        assert.equal(await readFile(join(project, "launches-auto"), "utf8"), `${started.pid}\n`, "Handoff must never relaunch the command");
        const log = await readFile(completion.log_path, "utf8");
        assert.ok(log.includes(`BEFORE:${started.pid}`));
        assert.ok(log.includes("RESULT:auto:"));
        assert.ok(completion.output.startsWith(launch.output));
      }
      if (timedOut) assert.equal(existsSync(join(project, `effect-${mode}`)), false);
      if (mode === "success") {
        const started = JSON.parse(await readFile(join(project, "started-success.json"), "utf8"));
        assert.equal(started.model, "pi-e2e");
        if (shell === "bash") assert.equal(started.prefix, "verified");
      }
      assert.equal(completion.log_truncated, mode === "large");
      if (mode === "large") assert.equal((await readFile(completion.log_path)).length, 16 * 1024 * 1024);
      assert.ok(Buffer.byteLength(completion.output) <= 8192);
      // Wait until the notification's write result has completed its normal follow-up.
      expectedRequests += 2;
      await until(() => fixture.assertions().inferenceRequests === expectedRequests, "Completion follow-up did not settle");
      await idle();
    }
    await prompt("denied", [true]);
    assert.equal(existsSync(join(project, "started-denied.json")), false);
    await prompt("auto-denied", [true]);
    assert.equal(existsSync(join(project, "started-auto-denied.json")), false);
    await prompt("malformed", [true]);
    assert.equal(existsSync(join(project, "started-invalid.json")), false);
    await prompt("nested-denied", [true, true]); expectedRequests--;
    assert.equal(existsSync(join(project, "started-nested-denied.json")), false);
    const cancellationLaunch = await prompt("cancel");
    const cancelled = (cancellationLaunch.events.filter(event => event.type === "tool_execution_end").at(-1)!.result as { structuredContent: { log_path: string } }).structuredContent;
    await until(() => existsSync(join(project, "child-cancel.json")), "Background child never started");
    const cancellation = await prompt("cancel-now");
    const finalCancellation = (cancellation.events.filter(event => event.type === "tool_execution_end").at(-1)!.result as { structuredContent: { state: string; exit_code: number | null } }).structuredContent;
    assert.equal(finalCancellation.state, "cancelled"); assert.equal(finalCancellation.exit_code, null);
    await idle();
    assert.equal(existsSync(join(project, "completion-cancel.json")), false, "Tool cancellation consumes the automatic follow-up");
    await prompt("reload");
    await until(() => existsSync(join(project, "child-reload.json")), "Reload child never started");
    assert.equal((await rpc.prompt("/bg-reload")).status, "handled");
    assert.equal(existsSync(cancelled.log_path), false, "Reload must remove session-owned logs");
    assert.equal((await rpc.prompt("/bg-anchor")).status, "handled");
    await prompt("tree");
    await until(() => existsSync(join(project, "child-tree.json")), "Tree child never started");
    assert.equal((await rpc.prompt("/bg-back")).status, "handled");
    await prompt("switch");
    await until(() => existsSync(join(project, "child-switch.json")), "Session child never started");
    assert.equal((await rpc.request("new_session")).success, true);
    await prompt("shutdown");
    await until(() => existsSync(join(project, "child-shutdown.json")), "Shutdown child never started");
    await rpc.close();
    await delay(6500);
    for (const mode of ["cancel", "foreground-cancel", "hard-foreground", "auto-deadline", "reload", "tree", "switch", "shutdown"]) {
      assert.equal(existsSync(join(project, `orphan-${mode}`)), false, "Background cleanup left a child alive");
      assert.equal(existsSync(join(project, `effect-${mode}`)), false);
    }
    assert.equal(existsSync(join(project, "completion-reload.json")), false);
    assert.equal(existsSync(join(project, "completion-shutdown.json")), false);
    assert.equal(existsSync(join(project, "completion-tree.json")), false);
    assert.equal(existsSync(join(project, "completion-switch.json")), false);
    for (const mode of ["foreground", "foreground-cancel", "foreground-failure", "hard-foreground", "equal-deadlines"]) {
      assert.equal(existsSync(join(project, `completion-${mode}.json`)), false, "Foreground results must not also send background notifications");
    }
    assert.equal(await readFile(settings, "utf8"), before);
    assert.equal(await readFile(instruction, "utf8"), "Personal fixture instructions.\n");
    assert.equal(fixture.assertions().unexpectedRequests, 0);
    assert.equal(fixture.assertions().inferenceRequests, expectedRequests);
    await runFixtureInstaller(workspace, "uninstall", ["background-shell"], { scope });
    assert.equal(existsSync(extension), false);
    assert.equal(existsSync(join(dirname(extension), "ui.ts")), false);
    return { scope, shell, version: fixture.version, requests: expectedRequests };
  } finally { await fixture.close(); }
}

async function until(test: () => boolean, message: string, timeout = 10000) {
  const end = Date.now() + timeout;
  while (!test()) { if (Date.now() > end) throw new Error(message); await delay(50); }
}
