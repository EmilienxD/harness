import { createHash } from "node:crypto";
import { E2eProtocolError, isRecord, type AnthropicMessagesRequest, type AnthropicScenarioResponse } from "../../core/anthropic-protocol.js";
import { OpenAiProtocolError, type OpenAiResponseOutput, type OpenAiResponsesRequest, type OpenAiScenarioResponse } from "../../core/openai-server.js";

export const LEAD = "HARNESS_SHIP_LEAD_E2E_2026";
export const PR_LEAD = "HARNESS_SHIP_PR_LEAD_E2E_2026";
export const REPORT = "HARNESS_SHIP_REPORT";
export const COMPLETE = "HARNESS_SHIP_COMPLETE_2026";
export const STEP_OK = "HARNESS_SHIP_STEP_OK";
export const SCENARIOS = ["feedback", "leaves", "decision-resume", "blocker-auto-merge", "fresh-cap"] as const;
export type ShipScenario = (typeof SCENARIOS)[number];
export const scenarioCatalogHash = createHash("sha256").update(`ship:v2:${SCENARIOS.join(",")}`).digest("hex");

export const IMPLEMENTATION = 'print("Hello staging")\n';
export function stub(name: string): string {
  return `def test_${name}():\n    """The ${name} CLI prints the staging greeting."""\n    assert False, "implementation required"\n`;
}
export function implementedTest(name: string, module: string): string {
  return `def test_${name}():\n    """The ${name} CLI prints the staging greeting."""\n    import subprocess, sys\n    assert subprocess.check_output([sys.executable, "${module}"], text=True).strip() == "Hello staging"\n`;
}
export function workflow(module: string): string {
  return `---\ncovers: ["${module}"]\n---\n# Greeting\n## Preconditions\n- The greeting application is available.\n## Steps\n- Request the staging greeting.\n## Acceptance Criteria\n- [ ] The greeting is Hello staging.\n- [ ] The request succeeds.\n## Potential Problems\n- A missing or incorrect greeting.\n- An unsuccessful request.\n`;
}

/** One unit of work per worktree: its criteria and the files an implementer fills. */
export interface Unit { readonly key: string; readonly test: string; readonly module: string; readonly workflow: string }
export function unit(key: string): Unit {
  const suffix = key === "main" ? "greeting" : `greeting_${key}`;
  return { key, test: `tests/unit/test_ship_${suffix}.py`, module: `ship_${suffix}.py`, workflow: `tests/workflow/${suffix.replace("_", "-")}.md` };
}
export function testName(item: Unit): string { return item.test.split("/").at(-1)!.replace(/^test_|\.py$/gu, ""); }

type Action =
  | { readonly kind: "run"; readonly id: string; readonly command: string }
  | { readonly kind: "read"; readonly id: string; readonly path: string }
  | { readonly kind: "write"; readonly id: string; readonly path: string; readonly relative: string; readonly content: string; readonly previous?: string };
interface Phase { readonly gate?: string; readonly actions: readonly Action[]; readonly report: string }
type LeadItem = { readonly step: string } | { readonly wait: string };
interface Plan { readonly leads: Readonly<Record<string, readonly LeadItem[]>>; readonly children: Readonly<Record<string, Phase[]>> }

export const report = (child: string, round: number) => `${REPORT}_${child}_${round}`;
export const gate = (child: string, round: number) => `HARNESS_SHIP_GATE_${child}_${round}`;

export function plan(scenario: ShipScenario, root: string, python: string): Plan {
  const r = root.replaceAll("\\", "/");
  const py = python.replaceAll("\\", "/");
  const driver = (args: string) => ({ step: args });
  const helper = (args: string) => `${py} ${r}/implementer.py ${args}`;
  const read = (id: string, path: string): Action => ({ kind: "read", id, path });
  const implement = (child: string, item: Unit, tag: string): Action[] => [
    { kind: "write", id: `${tag}-module`, path: `${r}/wt-${item.key}/${item.module}`, relative: item.module, content: IMPLEMENTATION },
    { kind: "write", id: `${tag}-test`, path: `${r}/wt-${item.key}/${item.test}`, relative: item.test, content: implementedTest(testName(item), item.module), previous: stub(testName(item)) },
    { kind: "run", id: `${tag}-status`, command: "test-workflows status" },
    { kind: "run", id: `${tag}-green`, command: helper(`test ${r}/evidence/${child}-green.txt ${item.test}`) },
    { kind: "run", id: `${tag}-workflow`, command: helper(`workflow ${r}/evidence/${child}-workflow.txt ${item.module}`) },
  ];
  const red = (child: string, item: Unit, tag: string): Action[] => [
    read(`${tag}-stub`, `${r}/wt-${item.key}/${item.test}`),
    { kind: "run", id: `${tag}-red`, command: helper(`test ${r}/evidence/${child}-${tag}-red.txt ${item.test}`) },
  ];
  const passed = (child: string, round: number) => `${report(child, round)}\nStub test: PASS; evidence ${r}/evidence/${child}-green.txt. Greeting workflow: PASS; evidence ${r}/evidence/${child}-workflow.txt. User steering: none.`;
  const failed = (child: string, round: number, detail: string) => `${report(child, round)}\nStub test: FAIL; evidence ${r}/evidence/${child}-r${round}-red.txt. Greeting workflow: NOT RUN; ${detail}. User steering: none.`;
  const main = unit("main");
  switch (scenario) {
    case "feedback":
      return {
        leads: { [LEAD]: [driver("select main"), driver("launch main impl1"), { wait: report("impl1", 1) },
          driver(`feedback impl1 1 ${report("impl1", 1)}`), { wait: report("impl1", 2) }, driver(`closeout main impl1 ${report("impl1", 2)} open`)] },
        children: { impl1: [
          { actions: red("impl1", main, "r1"), report: failed("impl1", 1, "implementation absent") },
          { gate: gate("impl1", 1), actions: implement("impl1", main, "r2"), report: passed("impl1", 2) },
        ] },
      };
    case "leaves": {
      const a = unit("a"), b = unit("b");
      return {
        leads: { [LEAD]: [driver("leaves parent a,b"), driver("claim a"), driver("prepare a"), driver("launch a impla"), { wait: report("impla", 1) },
          driver(`closeout a impla ${report("impla", 1)} merge`), driver("claim b"), driver("prepare b"), driver("launch b implb"), { wait: report("implb", 1) },
          driver(`closeout b implb ${report("implb", 1)} merge`)] },
        children: {
          impla: [{ actions: implement("impla", a, "r1"), report: passed("impla", 1) }],
          implb: [{ actions: implement("implb", b, "r1"), report: passed("implb", 1) }],
        },
      };
    }
    case "decision-resume":
      return {
        leads: {
          [LEAD]: [driver("select main"), driver("launch main impl1"), { wait: report("impl1", 1) },
            driver(`blocker main impl1 ${report("impl1", 1)} help`), driver("decision main impl1")],
          [PR_LEAD]: [driver("resume-pr main impl1"), { wait: report("impl1", 2) }, driver(`closeout main impl1 ${report("impl1", 2)} ready`)],
        },
        children: { impl1: [
          { actions: [read("r1-stub", `${r}/wt-main/${main.test}`)], report: `${report("impl1", 1)}\nBLOCKED: an unrelated external service the greeting needs is unavailable. Stub test: NOT RUN. Greeting workflow: NOT RUN. User steering: none.` },
          { gate: gate("impl1", 1), actions: implement("impl1", main, "r2"), report: passed("impl1", 2) },
        ] },
      };
    case "blocker-auto-merge": {
      const blk = unit("blk");
      return {
        leads: { [LEAD]: [driver("select main"), driver("launch main impl1"), { wait: report("impl1", 1) },
          driver(`blocker main impl1 ${report("impl1", 1)} auto`), driver("release impl1"), driver("claim blk"), driver("prepare blk"),
          driver("launch blk implblk"), { wait: report("implblk", 1) }, driver(`closeout blk implblk ${report("implblk", 1)} merge`),
          driver("sync-resume main impl1"), { wait: report("impl1", 2) }, driver(`closeout main impl1 ${report("impl1", 2)} merge`)] },
        children: {
          impl1: [
            { actions: [read("r1-stub", `${r}/wt-main/${main.test}`)], report: `${report("impl1", 1)}\nBLOCKED: an unrelated prerequisite greeting module is missing. Stub test: NOT RUN. Greeting workflow: NOT RUN. User steering: none.` },
            { gate: gate("impl1", 1), actions: implement("impl1", main, "r2"), report: passed("impl1", 2) },
          ],
          implblk: [{ actions: implement("implblk", blk, "r1"), report: passed("implblk", 1) }],
        },
      };
    }
    case "fresh-cap":
      return {
        leads: { [LEAD]: [driver("select main"), driver("launch main impl1"), { wait: report("impl1", 1) },
          driver(`feedback impl1 1 ${report("impl1", 1)}`), { wait: report("impl1", 2) }, driver(`fresh main impl1 impl2 ${report("impl1", 2)}`),
          { wait: report("impl2", 1) }, driver(`cap main impl2 ${report("impl2", 1)}`)] },
        children: {
          impl1: [
            { actions: red("impl1", main, "r1"), report: failed("impl1", 1, "implementation absent") },
            { gate: gate("impl1", 1), actions: red("impl1", main, "r2"), report: failed("impl1", 2, "the same stub still fails") },
          ],
          impl2: [{ actions: [
            read("r1-original", `${r}/inputs-impl2/original-prompt.md`), read("r1-diff", `${r}/inputs-impl2/branch.diff`),
            read("r1-report", `${r}/inputs-impl2/last-report.json`), read("r1-problems", `${r}/inputs-impl2/problems.md`),
            { kind: "write", id: "r1-module", path: `${r}/wt-main/${main.module}`, relative: main.module, content: 'print("Hello")\n' },
            { kind: "run", id: "r1-red", command: helper(`test ${r}/evidence/impl2-r1-red.txt ${main.test}`) },
          ], report: failed("impl2", 1, "the greeting text is still wrong") }],
        },
      };
  }
}

/** Provider-neutral view of one request: its history text and completed tool outputs. */
interface History { readonly text: string; output(id: string): string | undefined }

type Next =
  | { readonly checkpoint: string; readonly action: Action; readonly id: string; readonly poll?: string }
  | { readonly checkpoint: string; readonly text: string };

function next(history: History, scenario: ShipScenario, root: string, python: string, provider: string): Next {
  const scripted = plan(scenario, root, python);
  const py = python.replaceAll("\\", "/");
  const r = root.replaceAll("\\", "/");
  // The run command's output must prove success; a still-running Codex command is polled.
  const settled = (id: string): "done" | "pending" | { poll: string } => {
    const outputs: string[] = [];
    for (let attempt = 0; ; attempt += 1) {
      const current = history.output(attempt === 0 ? id : `${id}-poll${attempt}`);
      if (current === undefined) break;
      outputs.push(current);
    }
    if (outputs.length === 0) return "pending";
    if (outputs.some((item) => item.includes(STEP_OK))) return "done";
    const session = /session(?:_id|\s+ID)["\s:]*(\d+)/iu.exec(outputs.at(-1)!);
    if (session && !/exit(?:ed)? (?:with )?code|exit_code/iu.test(outputs.at(-1)!)) return { poll: `${id}-poll${outputs.length}:${session[1]}` };
    const last = outputs.at(-1)!;
    throw new E2eProtocolError("$.history", `ship step ${id} did not succeed (bytes=${last.length}, error=${last.endsWith(" denied")}, kind=${["interrupt", "timed out", "Exit code", "hook", "permission", "background", "cancel"].filter((word) => last.toLowerCase().includes(word.toLowerCase())).join("|") || "other"}, completion=${last.includes('\\"complete\\": true')})`, "ship");
  };
  const written = (id: string) => {
    const output = history.output(id);
    // Claude marks denials as errors; the guard's own reasons identify Codex denials.
    if (output !== undefined && (output.endsWith(" denied") || /The Lead owns|Loop guard could not/u.test(output))) throw new E2eProtocolError("$.history", `ship action ${id} was denied`, "ship");
    return output !== undefined;
  };
  for (const marker of [PR_LEAD, LEAD]) {
    if (!history.text.includes(marker)) continue;
    const items = scripted.leads[marker];
    if (!items) break;
    for (const [index, item] of items.entries()) {
      if ("wait" in item) {
        if (!history.text.includes(item.wait)) return { checkpoint: `lead-wait-${item.wait.slice(REPORT.length + 1)}`, text: "Waiting for the implementer report." };
        continue;
      }
      const id = `lead-${marker === PR_LEAD ? "pr" : "main"}-${index}`;
      const state = settled(id);
      if (state === "done") continue;
      const action: Action = { kind: "run", id, command: `${py} ${r}/driver.py ${item.step}` };
      const checkpoint = `lead-${item.step.split(" ")[0]}`;
      return typeof state === "object" ? { checkpoint: `${checkpoint}-poll`, action, id, poll: state.poll } : { checkpoint, action, id };
    }
    return { checkpoint: marker === PR_LEAD ? "pr-lead-complete" : "lead-complete", text: COMPLETE };
  }
  const child = /implementer-([a-z0-9]+)\.md/u.exec(history.text)?.[1];
  const phases = child === undefined ? undefined : scripted.children[child];
  if (!child || !phases) throw new E2eProtocolError("$.messages", "unrecognized ship history", "ship");
  let current = 0;
  while (current + 1 < phases.length && history.text.includes(phases[current + 1]!.gate!)) current += 1;
  const phase = phases[current]!;
  for (const action of phase.actions) {
    const id = `ship-${child}-${action.id}`;
    if (action.kind === "run" ? settled(id) === "done" : written(id)) continue;
    const state = action.kind === "run" ? settled(id) : "pending";
    const checkpoint = `${child}-${action.id}`;
    return typeof state === "object" ? { checkpoint: `${checkpoint}-poll`, action, id, poll: state.poll } : { checkpoint, action, id };
  }
  return { checkpoint: `${child}-report-${current + 1}`, text: phase.report };
}

export function claudeTransition(request: AnthropicMessagesRequest, root: string, scenario: ShipScenario, python: string): AnthropicScenarioResponse {
  const blocks = request.messages.flatMap((message) => Array.isArray(message.content) ? message.content : []);
  const history: History = {
    text: JSON.stringify(request.messages),
    output: (id) => {
      const found = blocks.find((block): block is Record<string, unknown> => isRecord(block) && block.type === "tool_result" && block.tool_use_id === id);
      if (!found) return undefined;
      const text = JSON.stringify(found.content ?? "");
      return found.is_error === true && !text.includes(STEP_OK) ? `${text} denied` : text;
    },
  };
  const result = next(history, scenario, root, python, "claude");
  const response = (content: readonly Record<string, unknown>[], stopReason: "tool_use" | "end_turn"): AnthropicScenarioResponse =>
    // Claude Code merges assistant messages sharing an ID; each response needs its own.
    ({ scenario: "ship", checkpoint: result.checkpoint, messageId: `msg_ship_${result.checkpoint}_${request.messages.length}`, stopReason, content });
  if ("text" in result) return response([{ type: "text", text: result.text }], "end_turn");
  const action = result.action;
  const input = action.kind === "run" ? { command: action.command, timeout: 600000 } : action.kind === "read" ? { file_path: action.path } : { file_path: action.path, content: action.content };
  return response([{ type: "tool_use", id: result.id, name: action.kind === "run" ? "Bash" : action.kind === "read" ? "Read" : "Write", input }], "tool_use");
}

export function codexTransition(request: OpenAiResponsesRequest, root: string, scenario: ShipScenario, python: string): OpenAiScenarioResponse {
  const outputs = new Map<string, string>();
  for (const item of request.input) {
    if ((item.type === "function_call_output" || item.type === "custom_tool_call_output") && typeof item.call_id === "string") outputs.set(item.call_id, JSON.stringify(item.output ?? ""));
  }
  const history: History = { text: JSON.stringify([request.instructions, request.input]), output: (id) => outputs.get(id) };
  let result: Next;
  try {
    result = next(history, scenario, root, python, "chatgpt");
  } catch (error) {
    // The Responses endpoint only reports its own protocol errors structurally.
    if (error instanceof E2eProtocolError) throw new OpenAiProtocolError("$.input", error.message, "ship");
    throw error;
  }
  if ("text" in result) {
    return { scenario: "ship", checkpoint: result.checkpoint, output: { type: "message", id: `msg_ship_${result.checkpoint}_${request.input.length}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: result.text, annotations: [] }] } };
  }
  const call = result.poll ? result.poll.split(":")[0]! : result.id;
  const code = (expression: string): OpenAiResponseOutput => ({ type: "custom_tool_call", id: `ctc_${call}`, call_id: call, name: "exec", status: "completed", input: `const result = await ${expression}; text(JSON.stringify(result));` });
  const custom = (name: string) => request.tools.find((tool) => tool.name === name);
  let output: OpenAiResponseOutput;
  if (result.poll) {
    const input = { session_id: Number(result.poll.split(":")[1]), chars: "", yield_time_ms: 30_000, max_output_tokens: 4_000 };
    output = request.codeMode ? code(`tools.write_stdin(${JSON.stringify(input)})`)
      : { type: "function_call", id: `fc_${call}`, call_id: call, name: "write_stdin", status: "completed", arguments: JSON.stringify(input) };
  } else if (result.action.kind === "run" || result.action.kind === "read") {
    const input = { cmd: result.action.kind === "run" ? result.action.command : `cat ${result.action.path}`, yield_time_ms: 30_000, max_output_tokens: 4_000 };
    output = request.codeMode ? code(`tools.exec_command(${JSON.stringify(input)})`)
      : { type: "function_call", id: `fc_${call}`, call_id: call, name: "exec_command", status: "completed", arguments: JSON.stringify(input) };
  } else {
    const action = result.action;
    const body = action.content.split("\n").slice(0, -1);
    const patch = action.previous === undefined
      ? `*** Begin Patch\n*** Add File: ${action.relative}\n${body.map((line) => `+${line}`).join("\n")}\n*** End Patch`
      : `*** Begin Patch\n*** Update File: ${action.relative}\n@@\n${action.previous.split("\n").slice(0, -1).map((line) => `-${line}`).join("\n")}\n${body.map((line) => `+${line}`).join("\n")}\n*** End Patch`;
    const tool = custom("apply_patch");
    if (request.codeMode) output = code(`tools.apply_patch(${JSON.stringify(patch)})`);
    else if (tool?.type === "custom") output = { type: "custom_tool_call", id: `ctc_${call}`, call_id: call, name: "apply_patch", status: "completed", input: patch };
    else if (tool) output = { type: "function_call", id: `fc_${call}`, call_id: call, name: "apply_patch", status: "completed", arguments: JSON.stringify({ input: patch }) };
    else throw new OpenAiProtocolError("$.tools", `apply_patch is unavailable; offered ${request.tools.map((item) => `${String(item.type)}:${String(item.name)}`).join(",")}`, "ship");
  }
  return { scenario: "ship", checkpoint: result.checkpoint, output };
}
