import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { OpenAiProtocolError, startFakeOpenAiServer } from "../../../../tests/e2e/core/openai-server.js";
import { createPiToolScenario } from "../../../../tests/e2e/core/pi-scenario.js";
import { AFTER_CONTENT, AUTO_RUN_AFK_MARKER, AUTO_RUN_EXPLORE_REPORT, AUTO_RUN_HITL_MARKER, AUTO_RUN_HITL_REVIEW_MARKER, AUTO_RUN_FOLLOWUP_MARKER, REVIEW_APPROVAL_COMMIT_COMMAND, WORKER_COMMIT_COMMAND } from "./scenario.js";

/** Native Pi tools exercise the same AFK orchestration contracts as the other providers. */
export async function startPiAutoRunServer(options: { readonly repoRoot: string; readonly diagnosticsPath: string; readonly resolveRepoRoot?: () => Promise<string> }) {
  return startFakeOpenAiServer({ diagnosticsPath: options.diagnosticsPath, scenarioCatalogHash: "aboard-pi-auto-run-v2", transition: async (request) => {
    const file = join(await options.resolveRepoRoot?.() ?? options.repoRoot, "deterministic.txt");
    const shell = process.platform === "win32" ? "powershell" : "bash";
    const explore = createPiToolScenario({ name: "auto-run-afk", marker: AUTO_RUN_AFK_MARKER, steps: [{ checkpoint: "auto-explore-read", tool: "read", input: { path: file } }] });
    const address = createPiToolScenario({ name: "auto-run-afk", marker: AUTO_RUN_AFK_MARKER, steps: [
      { checkpoint: "auto-afk-read", tool: "read", input: { path: file } },
      { checkpoint: "auto-afk-edit", tool: "edit", input: { path: file, oldText: "harness e2e fixture: before", newText: "harness e2e fixture: after" } },
      { checkpoint: "auto-afk-commit", tool: shell, input: { command: WORKER_COMMIT_COMMAND } },
    ] });
    const review = createPiToolScenario({ name: "auto-run-afk", marker: "Review pull request", steps: [{ checkpoint: "auto-review-commit", tool: shell, input: { command: REVIEW_APPROVAL_COMMIT_COMMAND } }] });
    const sequential = (name: string, marker: string, prefix: string, oldText: string, newText: string, commit: boolean) => createPiToolScenario({ name, marker, steps: [
      { checkpoint: `${prefix}-read`, tool: "read", input: { path: file } },
      { checkpoint: `${prefix}-edit`, tool: "edit", input: { path: file, oldText, newText } },
      ...(commit ? [{ checkpoint: `${prefix}-commit`, tool: shell, input: { command: WORKER_COMMIT_COMMAND } }] : []),
    ] });
    const hitl = sequential("auto-run-hitl", AUTO_RUN_HITL_MARKER, "auto-hitl", "harness e2e fixture: before", "harness e2e fixture: after", false);
    const hitlReviewed = sequential("auto-run-hitl-review", AUTO_RUN_HITL_REVIEW_MARKER, "auto-hitl", "harness e2e fixture: before", "harness e2e fixture: after", true);
    const hitlReview = createPiToolScenario({ name: "auto-run-hitl-review", marker: "Review issue", steps: [{ checkpoint: "auto-hitl-review-read", tool: "read", input: { path: file } }] });
    const followup = sequential("auto-run-followup", AUTO_RUN_FOLLOWUP_MARKER, "auto-followup", "harness e2e fixture: after", "harness e2e fixture: complete", true);
    // The model must read a spilled task through Pi's native read tool before
    // the issue marker can select its scenario.
    const originalUser = request.input.filter((item) => item.role === "user").map((item) => JSON.stringify(item.content)).join("\n");
    const spill = /Perform the task described in @?([^\s]+\.md)\./u.exec(originalUser.replaceAll("\\\\", "\\"));
    if (spill) {
      const candidate = spill[1]!;
      const offset = relative(resolve(tmpdir()), resolve(candidate));
      const parts = offset.split(/[\\/]/u);
      if (!isAbsolute(candidate) || offset.startsWith(`..${sep}`) || isAbsolute(offset) || parts.length < 3 || !/^abd-[A-Za-z0-9]+$/u.test(parts[0]!)) throw new OpenAiProtocolError("$.input", "spilled prompt escaped its dedicated root");
      const callId = "call_aboard_task_read";
      const call = request.input.find((item) => item.type === "function_call" && item.call_id === callId);
      const result = request.input.find((item) => item.type === "function_call_output" && item.call_id === callId);
      if (!call) {
        if (request.input.some((item) => item.type === "function_call") || !request.tools.some((tool) => tool.name === "read")) throw new OpenAiProtocolError("$.input", "spilled task must be read first");
        return { scenario: "task", checkpoint: "task-read", output: { type: "function_call", id: "fc_aboard_task_read", call_id: callId, name: "read", arguments: JSON.stringify({ path: candidate }), status: "completed" } };
      }
      if (!result || call.name !== "read" || call.arguments !== JSON.stringify({ path: candidate }) || request.input.indexOf(call) >= request.input.indexOf(result)) throw new OpenAiProtocolError("$.input", "spilled task read history is invalid");
      const contents = typeof result.output === "string" ? result.output : JSON.stringify(result.output);
      request = { ...request, input: [...request.input.filter((item) => item !== call && item !== result), { type: "message", role: "user", content: [{ type: "input_text", text: contents }] }] };
    }
    const offered = request.tools.map((tool) => tool.name);
    const user = request.input.filter((item) => item.role === "user").map((item) => JSON.stringify(item.content)).join("\n");
    if (/Review issue #\d+; Accept deterministic (?:per-issue|single-branch) change after review in the exact range/u.test(user)) {
      const response = hitlReview.transition(request);
      return response.checkpoint === "complete" ? { ...response, checkpoint: "auto-hitl-review-complete" } : response;
    }
    if (user.includes(AUTO_RUN_HITL_REVIEW_MARKER) || user.includes(AUTO_RUN_HITL_MARKER) || user.includes(AUTO_RUN_FOLLOWUP_MARKER)) {
      const route = user.includes(AUTO_RUN_FOLLOWUP_MARKER) ? "followup" : user.includes(AUTO_RUN_HITL_REVIEW_MARKER) ? user.includes("Review issue") ? "hitl-review" : "hitl-reviewed" : "hitl";
      const selected = route === "followup" ? followup : route === "hitl-review" ? hitlReview : route === "hitl-reviewed" ? hitlReviewed : hitl;
      const result = selected.transition(request);
      if (result.checkpoint !== "complete") return result;
      return { ...result, checkpoint: route === "followup" ? "auto-followup-complete" : route === "hitl-review" ? "auto-hitl-review-complete" : route === "hitl-reviewed" ? "auto-hitl-complete" : "auto-hitl-handoff" };
    }
    const route = !offered.includes("edit") ? "explore" : user.includes("Review pull request") ? "review" : "address";
    const selected = route === "explore" ? explore : route === "review" ? review : address;
    const response = selected.transition(request);
    if (response.checkpoint !== "complete") return response;
    return { ...response, checkpoint: `auto-${route === "address" ? "afk" : route}-complete`, output: { type: "message", id: `msg_pi_${route}_done`, role: "assistant", status: "completed", content: [{ type: "output_text", text: route === "explore" ? AUTO_RUN_EXPLORE_REPORT : route === "address" ? `Fixture updated: ${AFTER_CONTENT.trim()}` : "Review complete.", annotations: [] }] } };
  } });
}
