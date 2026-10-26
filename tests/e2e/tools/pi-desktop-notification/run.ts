import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { access, chmod, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { findHarnessRoot, runFixtureInstaller } from "../../core/installer.js";
import { createPiFixture } from "../../core/pi-fixture.js";
import { createPiToolScenario } from "../../core/pi-scenario.js";
import { OpenAiProtocolError, type OpenAiResponsesRequest, type OpenAiScenarioResponse } from "../../core/openai-server.js";

const execFileAsync = promisify(execFile);
const marker = "[E2E:pi-notification]";
const scenario = createPiToolScenario({ name: "pi-notification", marker, steps: [] });

/** Capture at the native notifier executable only, leaving Pi, transport and Python unchanged. */
async function stageRecordingBackend(root: string, env: NodeJS.ProcessEnv) {
  const bin = join(root, "notification-bin");
  const capture = join(root, "notification-capture.jsonl");
  const fail = join(root, "notification-fail");
  await mkdir(bin);
  env.HARNESS_E2E_NOTIFY_CAPTURE = capture;
  env.HARNESS_E2E_NOTIFY_FAIL = fail;
  if (process.platform === "win32") {
    const source = join(bin, "Recorder.cs");
    await writeFile(source, `using System; using System.IO; class Recorder { static int Main() { var input = Console.In.ReadToEnd(); if (File.Exists(Environment.GetEnvironmentVariable("HARNESS_E2E_NOTIFY_FAIL"))) return 1; File.AppendAllText(Environment.GetEnvironmentVariable("HARNESS_E2E_NOTIFY_CAPTURE"), input + "\\n"); return 0; } }`);
    const compiler = join(process.env.SystemRoot ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
    await execFileAsync(compiler, ["/nologo", "/target:exe", `/out:${join(bin, "powershell.exe")}`, source], { windowsHide: true, timeout: 20_000 });
  } else {
    const executable = join(bin, process.platform === "darwin" ? "osascript" : "notify-send");
    await writeFile(executable, '#!/usr/bin/env python3\nimport json,os,sys\nif os.path.exists(os.environ["HARNESS_E2E_NOTIFY_FAIL"]): sys.exit(1)\nwith open(os.environ["HARNESS_E2E_NOTIFY_CAPTURE"],"a",encoding="utf-8") as f: f.write(json.dumps({"title":sys.argv[-2],"body":sys.argv[-1]},ensure_ascii=True)+"\\n")\n');
    await chmod(executable, 0o755);
  }
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  env[pathKey] = bin + delimiter + env[pathKey];
  return { capture, fail, bin };
}

async function captures(path: string): Promise<{ title: string; body: string }[]> {
  if (!existsSync(path)) return [];
  return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function stageProbe(project: string) {
  const probe = join(project, ".pi", "extensions", "notify-probe");
  await mkdir(probe, { recursive: true });
  await writeFile(join(probe, "index.ts"), await readFile(join(await findHarnessRoot(), "tests", "e2e", "tools", "pi-desktop-notification", "probe.ts.txt")));
}

function route(request: OpenAiResponsesRequest): OpenAiScenarioResponse {
  const index = request.input.reduce((last, item, current) => item.role === "user" && JSON.stringify(item.content).includes(marker) ? current : last, -1);
  const scoped = { ...request, input: request.input.slice(index < 0 ? 0 : index) };
  const result = scenario.transition(scoped);
  if (result.output.type === "message") {
    const count = scoped.input.filter((item) => item.role === "assistant").length;
    return { ...result, output: { ...result.output, id: `msg_notify_${count}`, content: [{ type: "output_text" as const, text: count ? "Final continuation 雪." : "Final response 雪.\nWhitespace normalized.", annotations: [] }] } };
  }
  return result;
}

export async function runPiNotificationJourney(scope: "project" | "user") {
  const fixture = await createPiFixture({ ...scenario, transition: route });
  try {
    const project = fixture.workspace.projectRoot;
    const backend = await stageRecordingBackend(fixture.root, fixture.workspace.env);
    await runFixtureInstaller(fixture.workspace, "install", ["enable-desktop-notification"], { scope });
    await stageProbe(project);
    const platform = scope === "project" ? join(project, ".pi") : fixture.workspace.agentDir;
    const rpc = fixture.rpc({ timeoutMs: 150_000 });
    assert.equal((await rpc.prompt("/notify-name")).status, "handled");
    assert.equal((await rpc.prompt(marker)).status, "success");
    assert.equal((await captures(backend.capture)).length, 0);
    assert.equal((await rpc.prompt("/notify-anchor")).status, "handled");
    for (const command of ["/enable-desktop-notification invalid", "/enable-desktop-notification"])
      assert.equal((await rpc.prompt(command)).status, "handled");
    assert.equal(fixture.assertions().inferenceRequests, 1);
    assert.equal((await rpc.prompt(marker)).status, "success");
    assert.deepEqual((await captures(backend.capture))[0], { title: 'Pi: A Unicode session 雪 <&> "title"', body: "Final response 雪. Whitespace normalized." });
    await rpc.prompt("/notify-continue");
    const continuing = await rpc.prompt(marker);
    assert.equal(continuing.status, "success", JSON.stringify({ types: continuing.eventTypes, reasons: continuing.assistantStopReasons, assertions: fixture.assertions() }));
    assert.equal(continuing.eventTypes.filter((event) => event === "agent_end").length, 2);
    assert.equal(continuing.eventTypes.filter((event) => event === "agent_settled").length, 1);
    assert.equal((await captures(backend.capture)).length, 2);
    assert.equal((await captures(backend.capture))[1]!.body, "Final continuation 雪.");
    const ends = (await readFile(join(project, "notification-boundaries.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line).count);
    assert.deepEqual(ends, [0, 0, 1, 1]);
    await rpc.prompt("/enable-desktop-notification --disable");
    await rpc.prompt(marker);
    assert.equal((await captures(backend.capture)).length, 2);
    await rpc.prompt("/enable-desktop-notification");
    await rpc.prompt("/notify-reload");
    await rpc.prompt(marker);
    assert.equal((await captures(backend.capture)).length, 3);
    // Session preference remains opt-in through tree navigation; it is not an attribution receipt.
    await rpc.prompt("/notify-back");
    await rpc.prompt(marker);
    assert.equal((await captures(backend.capture)).length, 4);
    await writeFile(backend.fail, "fail");
    const failedDelivery = await rpc.prompt(marker);
    assert.equal(failedDelivery.status, "success");
    assert.equal(failedDelivery.events.filter((event) => event.type === "message_end" && (event.message as { customType?: string })?.customType === "harness-desktop-notification-v1").length, 1);
    assert.equal((await captures(backend.capture)).length, 4);
    await rename(backend.fail, backend.fail + ".off");
    await rpc.prompt(marker);
    assert.equal((await captures(backend.capture)).length, 5);
    // A fork has a new session identity even though Pi copies the ancestor's custom entries.
    await rpc.prompt("/notify-fork");
    await rpc.prompt(marker);
    assert.equal((await captures(backend.capture)).length, 5);
    assert.equal((await rpc.request("new_session")).success, true);
    await rpc.prompt(marker);
    assert.equal((await captures(backend.capture)).length, 5);
    assert.equal(fixture.assertions().inferenceRequests, 11);
    assert.equal(fixture.assertions().unexpectedRequests, 0);
    await rpc.close();
    const files = await readdir(fixture.workspace.sessionsDir);
    const saved = (await Promise.all(files.map(async (file) => ({ path: join(fixture.workspace.sessionsDir, file), content: await readFile(join(fixture.workspace.sessionsDir, file), "utf8") })))).find(({ content }) => content.includes('"enabled":true'))!;
    assert.ok(saved);
    assert.equal((await fixture.runJson({ prompt: marker, sessionFile: saved.path })).status, "success");
    assert.equal((await captures(backend.capture)).length, 6);
    const disabled = await fixture.runJson({ prompt: "/enable-desktop-notification --disable", sessionFile: saved.path });
    assert.deepEqual(disabled.assistantStopReasons, []);
    assert.equal(fixture.assertions().inferenceRequests, 12);
    assert.equal((await fixture.runJson({ prompt: marker, sessionFile: saved.path })).status, "success");
    assert.equal((await captures(backend.capture)).length, 6);
    assert.equal(fixture.assertions().inferenceRequests, 13);
    const helper = join(platform, "npm/node_modules/harness-pi-enable-desktop-notification", "harness", "desktop_notification_pi.py");
    await rename(helper, helper + ".off");
    const unavailable = await fixture.runJson({ prompt: "/enable-desktop-notification", sessionFile: saved.path });
    assert.deepEqual(unavailable.assistantStopReasons, []);
    assert.equal(fixture.assertions().inferenceRequests, 13);
    assert.equal((await fixture.runJson({ prompt: marker, sessionFile: saved.path })).status, "success");
    assert.equal((await captures(backend.capture)).length, 6);
    assert.equal(fixture.assertions().inferenceRequests, 14);
    assert.equal(fixture.assertions().unexpectedRequests, 0);
    await runFixtureInstaller(fixture.workspace, "uninstall", ["enable-desktop-notification"], { scope });
    await assert.rejects(access(join(platform, "npm/node_modules/harness-pi-enable-desktop-notification", "extensions", ".harness-enable-desktop-notification", "index.ts")));
    await assert.rejects(access(join(platform, "npm/node_modules/harness-pi-pi-transport", "harness", "pi-transport", "transport.ts")));
    return { version: fixture.version, scope, inferenceRequests: fixture.assertions().inferenceRequests, notifications: 6 };
  } finally { await fixture.close(); }
}

export async function runPiNotificationFailureJourney() {
  let started!: () => void;
  let release!: () => void;
  const inFlight = new Promise<void>((resolve) => { started = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const fixture = await createPiFixture({ ...scenario, transition: async (request) => {
    const latest = request.input.filter((item) => item.role === "user").at(-1);
    if (JSON.stringify(latest?.content).includes("[E2E:notify-abort]")) { started(); await gate; return scenario.transition({ ...request, input: [{ role: "user", content: marker }] }); }
    throw new OpenAiProtocolError("$.input", "controlled notification provider failure", "pi-notification-failure");
  } });
  try {
    const backend = await stageRecordingBackend(fixture.root, fixture.workspace.env);
    await runFixtureInstaller(fixture.workspace, "install", ["enable-desktop-notification"]);
    const rpc = fixture.rpc();
    assert.equal((await rpc.prompt("/enable-desktop-notification")).status, "handled");
    assert.equal((await rpc.prompt("[E2E:notify-error]")).status, "failed");
    assert.equal((await captures(backend.capture)).at(-1)!.body, "Turn failed.");
    const running = rpc.prompt("[E2E:notify-abort]");
    await inFlight;
    assert.equal((await rpc.request("abort")).success, true);
    assert.equal((await running).status, "aborted");
    assert.equal((await captures(backend.capture)).at(-1)!.body, "Turn aborted.");
    assert.equal((await captures(backend.capture)).length, 2);
    assert.equal(fixture.assertions().inferenceRequests, 2);
    assert.equal(fixture.assertions().unexpectedRequests, 1);
    return { version: fixture.version, inferenceRequests: 2, notifications: 2 };
  } finally { release(); await fixture.close(); }
}

/** Explicit real-desktop smoke: only inference is replaced; the OS notifier submits a real toast. */
export async function runPiNativeNotificationSmoke() {
  if (process.platform !== "win32") throw new Error("Native desktop notification acceptance is currently certified on Windows only");
  const fixture = await createPiFixture({ ...scenario, transition: route });
  try {
    await runFixtureInstaller(fixture.workspace, "install", ["enable-desktop-notification"]);
    const rpc = fixture.rpc();
    const enabled = await rpc.prompt("/enable-desktop-notification");
    assert.equal(enabled.status, "handled");
    const run = await rpc.prompt(marker);
    assert.equal(run.status, "success");
    const files = await readdir(fixture.workspace.sessionsDir);
    const entries = (await Promise.all(files.map((file) => readFile(join(fixture.workspace.sessionsDir, file), "utf8")))).flatMap((content) => content.trim().split("\n").map((line) => JSON.parse(line)));
    assert.ok(entries.some((entry) => entry.type === "custom" && entry.customType === "harness-desktop-notification-v1" && entry.data.enabled === true));
    // A delivery failure publishes a custom notification diagnostic. No diagnostic means
    // the shared Python notifier's native PowerShell process returned successfully.
    assert.equal(run.events.filter((event) => event.type === "message_end" && (event.message as { customType?: string })?.customType === "harness-desktop-notification-v1").length, 0);
    assert.equal(fixture.assertions().inferenceRequests, 1);
    assert.equal(fixture.assertions().unexpectedRequests, 0);
    return { version: fixture.version, platform: process.platform, inferenceRequests: 1, nativeSubmission: "success" };
  } finally { await fixture.close(); }
}
