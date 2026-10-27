import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAnthropicMessagesRequest, E2eProtocolError } from "../../core/anthropic-protocol.js";
import { startFakeAnthropicServer } from "../../core/anthropic-server.js";
import { isolatedClaudeEnvironment, runClaude, validateClaudeCli } from "../../core/claude.js";
import { prepareCodexHome, runCodex, validateCodexCli } from "../../core/codex.js";
import { runFixtureInstaller } from "../../core/installer.js";
import { OpenAiProtocolError, startFakeOpenAiServer } from "../../core/openai-server.js";
import { createPiFixture } from "../../core/pi-fixture.js";
import { createPiToolScenario } from "../../core/pi-scenario.js";
import { preparePiWorkspace } from "../../core/pi.js";
import { canonicalMkdtemp } from "../../core/temp.js";
import { initializeRepository, isolatedCodexEnvironment } from "../issues/support.js";
import { guardProgress } from "./scenario.js";

type Provider = "claude" | "chatgpt" | "pi";
interface Step {
  name: string;
  tool: "shell" | "write" | "read";
  command?: string;
  path?: string;
  content?: string;
  denied?: boolean;
  guidance?: string;
}
const packages = ["on-edit-block", "on-edit-reminder", "on-read-reminder"];
const catalog = createHash("sha256").update("shared-path-guards:v1").digest("hex");
const marker = "[E2E:shared-path-guards]";
const guide = "Follow the conventions for this project.\n".repeat(350);

function steps(provider: Provider): Step[] {
  const ps = process.platform === "win32" && provider !== "claude";
  const read = (path: string) => ps ? `Get-Content -Raw '${path}'` : `cat '${path}'`;
  const write = (path: string) => ps ? `Set-Content -LiteralPath '${path}' -Value after` : `printf 'after\\n' > '${path}'`;
  return [
    { name: "shell-read-reminder", tool: "shell", command: read("trigger.txt"), guidance: "read-guide.md" },
    { name: "partial-guidance", tool: "shell", command: ps ? "Get-Content -TotalCount 1 guide.md" : "head -n 1 guide.md" },
    { name: "shell-write-denied", tool: "shell", command: provider === "chatgpt" ? `cd sub; ${write("../blocked.txt")}` : write("blocked.txt"), denied: true },
    { name: "native-write-denied", tool: "write", path: "blocked-native.txt", content: "after\n", denied: true },
    { name: "complete-shell-guidance", tool: "shell", command: read("guide.md") },
    { name: "shell-write-authorized", tool: "shell", command: write("blocked.txt") },
    { name: "native-write-authorized", tool: "write", path: "blocked-native.txt", content: "after\n" },
    { name: "native-read-guidance", tool: "read", path: "native-guide.md" },
    { name: "native-read-authorizes-write", tool: "write", path: "native-read.txt", content: "after\n" },
    { name: "shell-edit-reminder", tool: "shell", command: write("reminder.txt"), guidance: "edit-guide.md" },
    { name: "native-edit-reminder", tool: "write", path: "native-reminder.txt", content: "after\n", guidance: "native-edit-guide.md" },
  ];
}

async function stage(workspace: Awaited<ReturnType<typeof preparePiWorkspace>>, provider: Provider) {
  const project = workspace.projectRoot;
  await mkdir(join(project, "sub"), { recursive: true });
  await runFixtureInstaller(workspace, "install", packages, { platform: provider });
  await runFixtureInstaller(workspace, "install", packages, { platform: provider });
  await writeFile(join(project, "guide.md"), guide);
  await writeFile(join(project, "native-guide.md"), guide);
  for (const file of ["trigger.txt", "read-guide.md", "edit-guide.md", "native-edit-guide.md"]) await writeFile(join(project, file), "Fixture conventions.\n");
  const rules = {
    "on-edit-block": 'version=1\n[[rules]]\npatterns=["blocked*.txt"]\nrequire=["guide.md"]\n[[rules]]\npatterns=["native-read.txt"]\nrequire=["native-guide.md"]\n',
    "on-edit-reminder": 'version=1\n[[rules]]\npatterns=["reminder.txt"]\nrequire=["edit-guide.md"]\n[[rules]]\npatterns=["native-reminder.txt"]\nrequire=["native-edit-guide.md"]\n',
    "on-read-reminder": 'version=1\n[[rules]]\npatterns=["trigger.txt"]\nrequire=["read-guide.md"]\n',
  };
  for (const [name, policy] of Object.entries(rules)) await writeFile(join(project, ".harness/guards", name + ".toml"), policy);
}

async function verify(project: string, plan: Step[], completed: number, context: unknown) {
  const step = plan[completed - 1];
  if (!step) return;
  if (step.denied) {
    await assert.rejects(access(join(project, "blocked.txt")));
    await assert.rejects(access(join(project, "blocked-native.txt")));
    await assert.rejects(access(join(project, "sibling.txt")));
  }
  if (step.name === "shell-write-authorized") assert.equal((await readFile(join(project, "blocked.txt"), "utf8")).trim(), "after");
  if (step.name === "native-write-authorized") assert.equal(await readFile(join(project, "blocked-native.txt"), "utf8"), "after\n");
  if (step.name === "native-read-authorizes-write") assert.equal(await readFile(join(project, "native-read.txt"), "utf8"), "after\n");
  // Resource identities carried by hook feedback, independent of instruction wording.
  if (step.guidance) assert.ok(JSON.stringify(context).includes(step.guidance), `missing guidance resource at ${step.name}`);
}

export async function runSharedPiGuards() {
  const plan = steps("pi");
  const shell = process.platform === "win32" ? "powershell" : "bash";
  const fixture = await createPiFixture(createPiToolScenario({ name: "shared-path-guards", marker, steps: plan.map(step => ({
    checkpoint: step.name, tool: step.tool === "shell" ? shell : step.tool,
    input: step.tool === "shell" ? { command: step.command } : step.tool === "read" ? { path: step.path } : { path: step.path, content: step.content },
  })) }));
  try {
    const project = fixture.workspace.projectRoot;
    await writeFile(join(project, ".pi/settings.json"), JSON.stringify({ defaultProvider: "harness-e2e", defaultModel: "pi-e2e", defaultTools: ["read", "write", "edit", shell] }));
    await stage(fixture.workspace, "pi");
    const run = await fixture.rpc().prompt(marker);
    assert.equal(run.status, "success", JSON.stringify(fixture.assertions()));
    assert.deepEqual(run.toolExecutions.map(event => event.isError), plan.map(step => !!step.denied));
    const ends = run.events.filter(event => event.type === "tool_execution_end");
    for (let i = 0; i < plan.length; i++) if (plan[i]!.guidance) assert.equal((ends[i]!.result as { content: unknown[] }).content.length, 2);
    for (const file of ["blocked.txt", "blocked-native.txt", "native-read.txt", "reminder.txt", "native-reminder.txt"]) assert.equal((await readFile(join(project, file), "utf8")).trim(), "after");
    assert.equal(fixture.assertions().inferenceRequests, plan.length + 1);
    assert.equal(fixture.assertions().unexpectedRequests, 0);
    await runFixtureInstaller(fixture.workspace, "uninstall", packages);
  } finally { await fixture.close(); }
}

export async function runSharedLocalGuards(provider: "claude" | "chatgpt") {
  if (provider === "claude") await validateClaudeCli(); else await validateCodexCli();
  const root = await canonicalMkdtemp(join(tmpdir(), "harness-shared-path-guards-"));
  let anthropic: Awaited<ReturnType<typeof startFakeAnthropicServer>> | undefined;
  let openai: Awaited<ReturnType<typeof startFakeOpenAiServer>> | undefined;
  const plan = steps(provider);
  try {
    // Reuse the allowlisted, external installer workspace; no Pi CLI is launched here.
    const workspace = await preparePiWorkspace(root, "http://127.0.0.1:1/v1", "unused-fixture-key");
    const project = workspace.projectRoot;
    await stage(workspace, provider);
    await initializeRepository(project);
    if (provider === "claude") {
      anthropic = await startFakeAnthropicServer({ repoRoot: project, scenarioCatalogHash: catalog, parseRequest: parseAnthropicMessagesRequest,
        transition: async request => {
          if (!request.messages.some(message => message.role === "user" && JSON.stringify(message.content).includes(marker))) throw new E2eProtocolError("$.messages", "unknown guard scenario");
          const history = request.messages.flatMap(message => Array.isArray(message.content) ? message.content : []);
          const completed = guardProgress(history, plan.length, "claude");
          await verify(project, plan, completed, request.messages);
          const step = plan[completed];
          if (!step) return { scenario: "shared-path-guards", checkpoint: "complete", messageId: "msg_shared_done", stopReason: "end_turn", content: [{ type: "text", text: "Fixture complete." }] };
          return { scenario: "shared-path-guards", checkpoint: step.name, messageId: `msg_shared_${completed}`, stopReason: "tool_use", content: [{
            type: "tool_use", id: `toolu_shared_${completed}`, name: step.tool === "shell" ? "Bash" : step.tool === "read" ? "Read" : "Write",
            input: step.tool === "shell" ? { command: step.command } : step.tool === "read" ? { file_path: join(project, step.path!) } : { file_path: join(project, step.path!), content: step.content },
          }] };
        } });
      const config = join(root, "claude-config");
      await mkdir(config);
      await writeFile(join(config, "settings.json"), "{}");
      const run = await runClaude(["-p", "--output-format", "stream-json", "--verbose", "--tools", "Read,Write,Bash", "--allowedTools", "Read,Write,Bash",
        "--permission-mode", "bypassPermissions", "--permission-prompts", "none", "--session-id", randomUUID(), marker], project,
        isolatedClaudeEnvironment(workspace.env, { ANTHROPIC_BASE_URL: anthropic.baseUrl, ANTHROPIC_AUTH_TOKEN: anthropic.authToken,
          CLAUDE_CONFIG_DIR: config, CLAUDE_PROJECT_DIR: project, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_MAX_RETRIES: "0", DISABLE_UPDATES: "1", DISABLE_AUTOUPDATER: "1" }));
      assert.equal(run.timedOut, false);
      assert.equal(run.code, 0, JSON.stringify(anthropic.assertions()));
      assert.equal(anthropic.assertions().inferenceRequests, plan.length + 1);
      assert.equal(anthropic.assertions().unexpectedRequests, 0);
    } else {
      openai = await startFakeOpenAiServer({ scenarioCatalogHash: catalog, transition: async request => {
        if (!request.input.some(item => item.role === "user" && JSON.stringify(item.content).includes(marker))) throw new OpenAiProtocolError("$.input", "unknown guard scenario");
        const completed = guardProgress(request.input, plan.length, "chatgpt");
        await verify(project, plan, completed, request.input);
        const step = plan[completed];
        if (!step) return { scenario: "shared-path-guards", checkpoint: "complete", output: { type: "message", id: "msg_shared_done", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Fixture complete.", annotations: [] }] } };
        // A protected second path must deny the entire patch, including its first path.
        const extra = step.path === "blocked-native.txt" ? "*** Add File: sibling.txt\n+after\n" : "";
        const args = step.tool === "write" ? `*** Begin Patch\n${extra}*** Add File: ${step.path}\n+${step.content!.trimEnd()}\n*** End Patch` : {
          cmd: step.command, yield_time_ms: 10_000, max_output_tokens: 12000,
        };
        if (step.tool === "read") throw new OpenAiProtocolError("$.tools", "Codex native read step must use shell adapter");
        const id = `shared_${completed}`;
        return { scenario: "shared-path-guards", checkpoint: step.name, output: request.codeMode ? {
          type: "custom_tool_call", id: `ctc_${id}`, call_id: `call_${id}`, name: "exec", status: "completed",
          input: `const r = await tools.${step.tool === "write" ? "apply_patch" : "exec_command"}(${JSON.stringify(args)}); text(JSON.stringify(r));`,
        } : step.tool === "write" ? {
          type: "custom_tool_call", id: `ctc_${id}`, call_id: `call_${id}`, name: "apply_patch", status: "completed", input: String(args),
        } : { type: "function_call", id: `fc_${id}`, call_id: `call_${id}`, name: "exec_command", status: "completed", arguments: JSON.stringify(args) } };
      } });
      // Codex reads files through its shell; the native Read check belongs to Claude and Pi.
      plan.splice(7, 2);
      const modelCatalog = join(root, "codex-models.json");
      await writeFile(modelCatalog, JSON.stringify({ models: [{ slug: "codex-e2e", display_name: "codex-e2e", description: null,
        supported_reasoning_levels: [], shell_type: "unified_exec", visibility: "list", supported_in_api: true, priority: 1,
        availability_nux: null, upgrade: null, support_verbosity: false, default_verbosity: null, apply_patch_tool_type: "freeform",
        truncation_policy: { mode: "bytes", limit: 50000 }, context_window: 272000, experimental_supported_tools: [],
        base_instructions: "You are a deterministic Harness E2E model." }] }));
      const home = await prepareCodexHome({ root, baseUrl: openai.baseUrl, trustedProjects: [project], modelCatalog, extraConfig: ["[features]", "hooks = true"] });
      const run = await runCodex(["exec", "--json", "--dangerously-bypass-hook-trust", "--dangerously-bypass-approvals-and-sandbox", marker], project,
        isolatedCodexEnvironment(workspace.env, home, openai.authToken, root), 60_000);
      assert.equal(run.timedOut, false);
      assert.equal(run.code, 0, JSON.stringify(openai.assertions()));
      assert.equal(openai.assertions().inferenceRequests, plan.length + 1, JSON.stringify(openai.assertions()));
      assert.equal(openai.assertions().unexpectedRequests, 0);
      assert.equal(await readFile(join(project, "sibling.txt"), "utf8"), "after\n");
    }
    await runFixtureInstaller(workspace, "uninstall", packages, { platform: provider });
    await assert.rejects(access(join(project, provider === "claude" ? ".claude" : ".codex", "hooks", "path_guard_common.py")));
  } finally {
    await anthropic?.close(); await openai?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
