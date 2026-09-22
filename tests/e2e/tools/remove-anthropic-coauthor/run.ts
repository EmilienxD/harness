import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { parseAnthropicMessagesRequest } from "../../core/anthropic-protocol.js";
import { startFakeAnthropicServer } from "../../core/anthropic-server.js";
import { isolatedClaudeEnvironment, runClaude, validateClaudeCli } from "../../core/claude.js";
import { MARKER, scenarioCatalogHash, transition } from "./scenario.js";

const exec = promisify(execFile);

export interface RemoveAnthropicCoauthorJourneyResult {
  readonly checkpoints: readonly string[];
  readonly messages: readonly string[];
  readonly committedBytes: string;
  readonly stagedChangesPreserved: boolean;
  readonly commitMetadataPreserved: boolean;
  readonly originalTrailersPresent: boolean;
  readonly unexpectedRequests: number;
  readonly inferenceRequests: number;
}

export async function runRemoveAnthropicCoauthorJourney(): Promise<RemoveAnthropicCoauthorJourneyResult> {
  await validateClaudeCli();
  const harness = await findHarnessRoot();
  const root = await realpath(await mkdtemp(join(tmpdir(), "harness-remove-coauthor-e2e-")));
  const project = join(root, "repository");
  const config = join(root, "claude-config");
  let server: Awaited<ReturnType<typeof startFakeAnthropicServer>> | undefined;
  try {
    await mkdir(project);
    await git(project, "init", "-b", "main");
    await git(project, "config", "user.name", "Harness E2E");
    await git(project, "config", "user.email", "harness-e2e@example.invalid");
    await git(project, "config", "commit.gpgSign", "false");
    await git(project, "config", "core.autocrlf", "false");
    await mkdir(join(root, "empty-hooks"));
    await git(project, "config", "core.hooksPath", join(root, "empty-hooks"));
    await writeFile(join(project, "coauthor-fixture.txt"), "before\n");
    await writeFile(join(project, "pending-fixture.txt"), "before\n");
    await git(project, "add", "--", "coauthor-fixture.txt", "pending-fixture.txt");
    await git(project, "commit", "-m", "Seed coauthor journey");
    await writeFile(join(project, "pending-fixture.txt"), "staged change to preserve\n");
    await git(project, "add", "--", "pending-fixture.txt");
    const staged = await git(project, "diff", "--cached", "--binary");

    const python = await pythonCommand();
    const payloadRoot = join(harness, "harness", "guards", "remove-anthropic-coauthor");
    const claudeDir = join(project, ".claude");
    const hook = join(claudeDir, "hooks", "remove_anthropic_coauthor_hook.py");
    await mkdir(dirname(hook), { recursive: true });
    await mkdir(config, { recursive: true });
    await copyFile(join(payloadRoot, "remove_anthropic_coauthor_hook.py"), hook);
    const settings: unknown = JSON.parse(await readFile(join(payloadRoot, "claude", "settings.fragment.json"), "utf8"), (_key, value: unknown) =>
      typeof value === "string" ? value.replaceAll("${PYTHON}", python).replaceAll("${CLAUDE_DIR}", claudeDir) : value);
    await writeFile(join(claudeDir, "settings.json"), JSON.stringify(settings));
    await writeFile(join(config, "settings.json"), "{}\n");
    server = await startFakeAnthropicServer({
      repoRoot: project, diagnosticsPath: join(root, "structural-diagnostics.json"), scenarioCatalogHash,
      parseRequest: parseAnthropicMessagesRequest, transition,
    });
    const result = await runClaude([
      "-p", "--output-format", "stream-json", "--verbose", "--tools", "Bash", "--allowedTools", "Bash",
      "--permission-mode", "acceptEdits", "--permission-prompts", "none", MARKER,
    ], project, isolatedClaudeEnvironment(process.env, {
      ANTHROPIC_BASE_URL: server.baseUrl, ANTHROPIC_AUTH_TOKEN: server.authToken,
      CLAUDE_CONFIG_DIR: config, CLAUDE_PROJECT_DIR: project,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_MAX_RETRIES: "0",
      DISABLE_UPDATES: "1", DISABLE_AUTOUPDATER: "1", NO_PROXY: "127.0.0.1,localhost",
    }));
    if (result.timedOut || result.code !== 0) {
      throw new Error(`Claude coauthor journey failed: exit=${result.code}, timedOut=${result.timedOut}, unexpectedRequests=${server.assertions().unexpectedRequests}`);
    }
    // Each CLI commit must be followed by the hook's atomic amend. Original
    // objects remain accessible in the reflog for exact metadata comparison.
    const refs = (await git(project, "reflog", "-4", "--format=%H")).trim().split(/\r?\n/u);
    const pairs: readonly (readonly [string, string])[] = [[refs[0]!, refs[1]!], [refs[2]!, refs[3]!]];
    const messages: string[] = [];
    let commitMetadataPreserved = true;
    let originalTrailersPresent = true;
    for (const [amended, original] of pairs) {
      messages.push((await git(project, "show", "-s", "--format=%B", amended)).trimEnd());
      const originalMessage = await git(project, "show", "-s", "--format=%B", original);
      originalTrailersPresent &&= /Co-Authored-By: Claude (?:Opus 4\.7|Sonnet 4\.8) <noreply@anthropic\.com>/u.test(originalMessage);
      commitMetadataPreserved &&= amended !== original
        && await git(project, "show", "-s", "--format=%T%n%P%n%an%n%ae%n%aI", amended)
          === await git(project, "show", "-s", "--format=%T%n%P%n%an%n%ae%n%aI", original);
    }
    const assertions = server.assertions();
    return {
      checkpoints: assertions.checkpoints, messages,
      committedBytes: await git(project, "show", "HEAD:coauthor-fixture.txt"),
      stagedChangesPreserved: staged === await git(project, "diff", "--cached", "--binary"),
      commitMetadataPreserved, originalTrailersPresent,
      unexpectedRequests: assertions.unexpectedRequests, inferenceRequests: assertions.inferenceRequests,
    };
  } finally {
    await server?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function git(repo: string, ...args: string[]): Promise<string> {
  return (await exec("git", ["-C", repo, ...args], { windowsHide: true, timeout: 30_000 })).stdout;
}

async function pythonCommand(): Promise<string> {
  for (const candidate of ["python3", "python", "py"]) {
    try { return (await exec(candidate, ["-c", "import sys; assert sys.version_info >= (3, 11); print(sys.executable)"], { windowsHide: true, timeout: 10_000 })).stdout.trim(); }
    catch { /* Try the next installed interpreter. */ }
  }
  throw new Error("coauthor E2E requires Python 3.11 or newer");
}

async function findHarnessRoot(): Promise<string> {
  let candidate = resolve(process.cwd());
  while (true) {
    try { await readFile(join(candidate, "harness", "guards", "remove-anthropic-coauthor", "harness.toml")); return candidate; }
    catch { /* Walk upward to the catalogue. */ }
    const parent = dirname(candidate);
    if (parent === candidate) throw new Error("could not locate the Harness checkout");
    candidate = parent;
  }
}
