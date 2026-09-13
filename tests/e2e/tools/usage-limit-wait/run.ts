import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { startFakeAnthropicServer } from "../../core/anthropic-server.js";
import { parseAnthropicMessagesRequest } from "../../core/anthropic-protocol.js";
import { findFinalText, isolatedClaudeEnvironment, parseStreamJson, redactProcessError, runClaude, validateClaudeCli } from "../../core/claude.js";
import { prepareCodexHome, redactCodexProcessError, runCodex, validateCodexCli } from "../../core/codex.js";
import { startFakeOpenAiServer } from "../../core/openai-server.js";
import { claudeTransition, codexTransition, FINAL_MESSAGE, MARKER, scenarioCatalogHash } from "./scenario.js";

const execFileAsync = promisify(execFile);
type Platform = "claude" | "chatgpt";
export interface UsageLimitWaitJourneyResult { readonly checkpoints: readonly string[]; readonly finalText: string; readonly unexpectedRequests: number; readonly usageRequests: number; }

export async function runUsageLimitWaitJourney(platform: Platform): Promise<UsageLimitWaitJourneyResult> {
  if (platform === "claude") await validateClaudeCli(); else await validateCodexCli();
  const root = await mkdtemp(join(tmpdir(), `harness-usage-limit-wait-${platform}-e2e-`));
  const projectRoot = join(root, "project"); const isolatedTemp = join(root, "tmp");
  let inference: Awaited<ReturnType<typeof startFakeAnthropicServer>> | Awaited<ReturnType<typeof startFakeOpenAiServer>> | undefined;
  let usage: Awaited<ReturnType<typeof startFakeUsageServer>> | undefined;
  try {
    await mkdir(projectRoot, { recursive: true }); await mkdir(isolatedTemp, { recursive: true });
    const harnessRoot = await findHarnessRoot(process.cwd()); const python = await pythonCommand(); usage = await startFakeUsageServer();
    let finalText: string;
    if (platform === "claude") {
      const configRoot = join(root, "claude-config"); const hookRoot = join(projectRoot, ".claude", "hooks"); const hookPath = join(hookRoot, "usage_limit_wait_hook.py"); const pythonRoot = join(root, "python-fixture");
      await mkdir(hookRoot, { recursive: true }); await mkdir(configRoot, { recursive: true }); await mkdir(pythonRoot, { recursive: true });
      await copyFile(join(harnessRoot, "harness", "guards", "usage-limit-wait", "claude", "usage_limit_wait_hook.py"), hookPath);
      await writeFile(join(configRoot, ".credentials.json"), `${JSON.stringify({ claudeAiOauth: { accessToken: "e2e-oauth-token" } })}\n`);
      await writeFile(join(configRoot, "settings.json"), "{}\n");
      await writeFile(join(projectRoot, ".claude", "settings.json"), `${JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: python, args: [hookPath], timeout: 30 }] }] } }, null, 2)}\n`);
      await writeFile(join(pythonRoot, "sitecustomize.py"), claudeRedirectFixture());
      inference = await startFakeAnthropicServer({ repoRoot: projectRoot, scenarioCatalogHash, parseRequest: parseAnthropicMessagesRequest, transition: claudeTransition });
      const env = isolatedClaudeEnvironment(process.env, {
        ANTHROPIC_BASE_URL: inference.baseUrl, ANTHROPIC_AUTH_TOKEN: inference.authToken, CLAUDE_CONFIG_DIR: configRoot, CLAUDE_PROJECT_DIR: projectRoot,
        CLAUDE_CODE_PROJECT_DIR_NAME: "harness-usage-limit-wait-e2e", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_MAX_RETRIES: "0",
        DISABLE_UPDATES: "1", DISABLE_AUTOUPDATER: "1", NO_PROXY: "127.0.0.1,localhost", PYTHONPATH: pythonRoot,
        HARNESS_E2E_USAGE_URL: `${usage.baseUrl}/anthropic-usage`, HARNESS_E2E_USAGE_TOKEN: usage.token,
        USAGE_LIMIT_WAIT_POLL: "0", USAGE_LIMIT_WAIT_OS_NOTIFICATION: "0", USAGE_LIMIT_WAIT_FALLBACK: "0", TMP: isolatedTemp, TEMP: isolatedTemp, TMPDIR: isolatedTemp,
      });
      const result = await runClaude(["-p", "--output-format", "stream-json", "--verbose", "--tools", "", "--session-id", randomUUID(), MARKER], projectRoot, env, 45_000);
      if (result.timedOut) throw new Error("Claude Code timed out during usage-limit-wait E2E");
      if (result.code !== 0) throw new Error(`Claude Code exited ${result.code}: ${redactProcessError(result.stderr)}`);
      finalText = findFinalText(parseStreamJson(result.stdout), result.stdout);
    } else {
      const hookRoot = join(projectRoot, ".codex", "hooks"); const hookPath = join(hookRoot, "usage_limit_wait_hook.py"); const fakeBin = join(root, "fake-bin");
      await mkdir(hookRoot, { recursive: true }); await mkdir(fakeBin, { recursive: true });
      await copyFile(join(harnessRoot, "harness", "guards", "usage-limit-wait", "chatgpt", "usage_limit_wait_hook.py"), hookPath);
      await writeFile(join(projectRoot, ".codex", "hooks.json"), `${JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: `${python} \"${hookPath}\"`, timeout: 30 }] }] } }, null, 2)}\n`);
      await writeFile(join(fakeBin, "fake-codex-app-server.py"), codexAppServerFixture());
      if (process.platform === "win32") await writeFile(join(fakeBin, "codex.cmd"), `@\"${python}\" \"%~dp0fake-codex-app-server.py\" %*\r\n`);
      else { const shim = join(fakeBin, "codex"); await writeFile(shim, `#!/bin/sh\nexec \"${python}\" \"$(dirname \"$0\")/fake-codex-app-server.py\" \"$@\"\n`); await chmod(shim, 0o755); }
      const codexInference = await startFakeOpenAiServer({ scenarioCatalogHash, transition: codexTransition }); inference = codexInference;
      const codexHome = await prepareCodexHome({ root, baseUrl: codexInference.baseUrl, trustedProjects: [projectRoot], extraConfig: ["[features]", "hooks = true"] });
      const outputPath = join(root, "codex-final.txt");
      const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: codexHome, HARNESS_E2E_OPENAI_KEY: codexInference.authToken, NO_PROXY: "127.0.0.1,localhost", PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`, HARNESS_E2E_USAGE_URL: `${usage.baseUrl}/codex-usage`, HARNESS_E2E_USAGE_TOKEN: usage.token, USAGE_LIMIT_WAIT_POLL: "0", USAGE_LIMIT_WAIT_OS_NOTIFICATION: "0", TMP: isolatedTemp, TEMP: isolatedTemp, TMPDIR: isolatedTemp };
      for (const key of ["OPENAI_API_KEY", "OPENAI_BASE_URL", "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_ENDPOINT"]) delete env[key];
      const result = await runCodex(["exec", "--json", "--dangerously-bypass-hook-trust", "--skip-git-repo-check", "--sandbox", "danger-full-access", "--output-last-message", outputPath, MARKER], projectRoot, env, 45_000);
      if (result.timedOut) throw new Error("Codex timed out during usage-limit-wait E2E");
      if (result.code !== 0) throw new Error(`Codex exited ${result.code}: ${redactCodexProcessError(result.stderr)}`);
      finalText = await readFile(outputPath, "utf8");
    }
    const assertions = inference.assertions();
    if (!assertions.checkpoints.includes("complete")) throw new Error("inference did not complete after usage recovery");
    if (!finalText.includes(FINAL_MESSAGE)) throw new Error(`${platform} did not continue after usage was restored`);
    if (usage.requests !== 2) throw new Error(`expected exactly two usage reads, observed ${usage.requests}`);
    return { checkpoints: ["usage-exhausted", "usage-restored", "complete"], finalText, unexpectedRequests: assertions.unexpectedRequests, usageRequests: usage.requests };
  } finally { await inference?.close(); await usage?.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}

async function startFakeUsageServer() {
  const token = randomBytes(20).toString("hex"); let requests = 0;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.headers["x-harness-e2e-token"] !== token || !["/anthropic-usage", "/codex-usage"].includes(url.pathname)) { response.writeHead(404).end(); return; }
    requests += 1; const exhausted = requests === 1; const reset = Math.floor(Date.now() / 1000) + 3600;
    const payload = url.pathname === "/anthropic-usage"
      ? { five_hour: { utilization: exhausted ? 100 : 0, resets_at: new Date(reset * 1000).toISOString() }, seven_day: { utilization: 0, resets_at: new Date((reset + 604800) * 1000).toISOString() } }
      : { rateLimits: { primary: { usedPercent: exhausted ? 100 : 0, windowDurationMins: 300, resetsAt: reset }, secondary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: reset + 604800 }, credits: { hasCredits: false, unlimited: false, balance: "0" } } };
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(payload));
  });
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const address = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${address.port}`, token, get requests() { return requests; }, close: () => new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done())) };
}

function claudeRedirectFixture(): string { return `import os\nimport urllib.request\nos.environ.pop("ANTHROPIC_AUTH_TOKEN", None)\n_original = urllib.request.urlopen\ndef _urlopen(request, *args, **kwargs):\n    url = request.full_url if hasattr(request, "full_url") else str(request)\n    if url == "https://api.anthropic.com/api/oauth/usage":\n        request = urllib.request.Request(os.environ["HARNESS_E2E_USAGE_URL"], headers={"x-harness-e2e-token": os.environ["HARNESS_E2E_USAGE_TOKEN"]})\n    return _original(request, *args, **kwargs)\nurllib.request.urlopen = _urlopen\n`; }
function codexAppServerFixture(): string { return `import json, os, sys, urllib.request\nfor line in sys.stdin:\n    message = json.loads(line)\n    if message.get("method") == "initialize": print(json.dumps({"id": message["id"], "result": {"userAgent": "harness-e2e"}}), flush=True)\n    elif message.get("method") == "account/rateLimits/read":\n        request = urllib.request.Request(os.environ["HARNESS_E2E_USAGE_URL"], headers={"x-harness-e2e-token": os.environ["HARNESS_E2E_USAGE_TOKEN"]})\n        with urllib.request.urlopen(request) as response: result = json.load(response)\n        print(json.dumps({"id": message["id"], "result": result}), flush=True)\n`; }
async function pythonCommand(): Promise<string> { for (const candidate of ["python3", "python", "py"]) { try { await execFileAsync(candidate, ["-c", "import sys; assert sys.version_info >= (3, 11)"], { windowsHide: true }); return candidate; } catch { } } throw new Error("usage-limit-wait E2E requires Python 3.11 or newer"); }
async function findHarnessRoot(start: string): Promise<string> { let candidate = resolve(start); while (true) { try { await readFile(join(candidate, "harness", "guards", "usage-limit-wait", "harness.toml")); return candidate; } catch { } const parent = dirname(candidate); if (parent === candidate) throw new Error("could not locate the Harness checkout"); candidate = parent; } }
