import { execFile } from "node:child_process";
import { access, chmod, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type IssuePlatform = "claude" | "chatgpt";

export interface FakeIssue {
  readonly number: number;
  readonly url: string;
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
}

export async function findHarnessRoot(start: string): Promise<string> {
  let candidate = resolve(start);
  while (true) {
    try {
      await access(join(candidate, "harness", "building", "issue-readers", "harness.toml"));
      return candidate;
    } catch { }
    const parent = dirname(candidate);
    if (parent === candidate) throw new Error("could not locate the Harness checkout");
    candidate = parent;
  }
}

export async function pythonCommand(): Promise<string> {
  for (const candidate of ["python3", "python", "py"]) {
    try {
      await execFileAsync(candidate, ["-c", "import sys; assert sys.version_info >= (3, 11)"], { windowsHide: true });
      return candidate;
    } catch { }
  }
  throw new Error("issue E2E journeys require Python 3.11 or newer");
}

export async function initializeRepository(projectRoot: string): Promise<void> {
  await execFileAsync("git", ["init", "-b", "main"], { cwd: projectRoot, windowsHide: true });
  await execFileAsync("git", ["config", "user.email", "issues-e2e@example.invalid"], { cwd: projectRoot, windowsHide: true });
  await execFileAsync("git", ["config", "user.name", "Issues E2E"], { cwd: projectRoot, windowsHide: true });
  await execFileAsync("git", ["add", "--all"], { cwd: projectRoot, windowsHide: true });
  await execFileAsync("git", ["commit", "-m", "Fixture baseline"], {
    cwd: projectRoot, windowsHide: true,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2026-01-02T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-02T00:00:00Z",
    },
  });
}

export async function copyTree(source: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true });
}

export function isolatedCodexEnvironment(parent: NodeJS.ProcessEnv, codexHome: string, token: string, bin: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...parent,
    CODEX_HOME: codexHome,
    HARNESS_E2E_OPENAI_KEY: token,
    PATH: `${bin}${delimiter}${parent.PATH ?? ""}`,
    NO_PROXY: "127.0.0.1,localhost",
  };
  for (const key of ["OPENAI_API_KEY", "OPENAI_BASE_URL", "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_ENDPOINT"]) delete env[key];
  return env;
}

export function parseCodexThreadId(output: string): string {
  for (const line of output.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let value: unknown;
    try { value = JSON.parse(line) as unknown; } catch { continue; }
    if (isRecord(value) && value.type === "thread.started" && typeof value.thread_id === "string") return value.thread_id;
  }
  throw new Error("Codex JSON output did not include a thread.started id");
}

export async function createFakeGh(root: string): Promise<{ readonly bin: string; readonly statePath: string }> {
  const bin = join(root, "bin");
  const statePath = join(root, "fake-gh-state.json");
  const scriptPath = join(bin, "fake-gh.cjs");
  await mkdir(bin, { recursive: true });
  await writeFile(statePath, `${JSON.stringify({ issues: [], calls: [] }, null, 2)}\n`, "utf8");
  await writeFile(scriptPath, fakeGhSource(statePath), "utf8");
  await writeFile(join(bin, "sitecustomize.py"), fakeGhSiteCustomize(), "utf8");
  await writeFile(join(bin, "gh.cmd"), `@echo off\r\n"${process.execPath}" "%~dp0fake-gh.cjs" %*\r\n`, "utf8");
  const posixPath = join(bin, "gh");
  await writeFile(posixPath, `#!/bin/sh\nexec ${shellQuote(process.execPath)} "$(dirname "$0")/fake-gh.cjs" "$@"\n`, "utf8");
  await chmod(posixPath, 0o755);
  return { bin, statePath };
}

export async function readPublishedIssue(statePath: string): Promise<FakeIssue> {
  const value = JSON.parse(await readFile(statePath, "utf8")) as { issues?: unknown };
  if (!Array.isArray(value.issues) || value.issues.length !== 1 || !isRecord(value.issues[0])) {
    throw new Error("fake GitHub did not contain exactly one published issue");
  }
  const issue = value.issues[0];
  if (typeof issue.number !== "number" || typeof issue.url !== "string" || typeof issue.title !== "string" || typeof issue.body !== "string" || !Array.isArray(issue.labels) || !issue.labels.every((label) => typeof label === "string")) {
    throw new Error("fake GitHub recorded a malformed issue");
  }
  return { number: issue.number, url: issue.url, title: issue.title, body: issue.body, labels: issue.labels };
}

export function successfulOpenAiRequests(assertions: { readonly observations: readonly Record<string, unknown>[] }): number {
  return assertions.observations.filter((item) => item.result === "success" && item.httpStatus === 200).length;
}

function fakeGhSource(statePath: string): string {
  return `const fs = require("node:fs");
const statePath = ${JSON.stringify(statePath)};
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
state.calls.push(args);
const save = () => fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\\n", "utf8");
const option = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const finish = (text = "") => { save(); if (text) process.stdout.write(text.endsWith("\\n") ? text : text + "\\n"); };
if (args[0] === "repo" && args[1] === "view") finish("fixture/issues");
else if (args[0] === "api" && args[1] === "graphql") finish(JSON.stringify({ data: { repository: { issue: {
  number: 42, title: "Address the deterministic fixture", body: "Replace the fixture implementation with addressed issue 42.",
  state: "OPEN", author: { login: "fixture-author" }, labels: { nodes: [{ name: "[AI]-routine-difficulty" }] }, parent: null, subIssues: { nodes: [] }, comments: { totalCount: 1, nodes: [{ author: { login: "maintainer" }, body: "Keep the final file to one line." }] }
} } } }));
else if (args[0] === "label" && args[1] === "create") finish();
else if (args[0] === "issue" && args[1] === "create" && args.includes("--help")) finish("Usage: gh issue create [flags]");
else if (args[0] === "issue" && args[1] === "create") {
  const number = 101 + state.issues.length;
  const body = fs.readFileSync(option("--body-file"), "utf8").replace(/\\r\\n/g, "\\n");
  const labels = args.flatMap((value, index) => value === "--label" ? [args[index + 1]] : []);
  const issue = { number, url: "https://github.test/fixture/issues/issues/" + number, title: option("--title"), body, labels, createdAt: "2026-01-02T00:00:00Z" };
  state.issues.push(issue);
  finish(issue.url);
} else if (args[0] === "issue" && args[1] === "view") {
  const target = args[2];
  const issue = state.issues.find((item) => item.url === target || String(item.number) === target);
  if (!issue) { save(); process.stderr.write("issue not found\\n"); process.exitCode = 1; }
  else finish(JSON.stringify({ title: issue.title, body: issue.body }));
} else if (args[0] === "issue" && args[1] === "edit") {
  const target = args[2];
  const issue = state.issues.find((item) => item.url === target || String(item.number) === target);
  if (!issue) { save(); process.stderr.write("issue not found\\n"); process.exitCode = 1; }
  else { if (option("--body-file")) issue.body = fs.readFileSync(option("--body-file"), "utf8").replace(/\\r\\n/g, "\\n"); finish(issue.url); }
} else if (args[0] === "issue" && args[1] === "list") finish(JSON.stringify(state.issues));
else { save(); process.stderr.write("unexpected fake gh call: " + JSON.stringify(args) + "\\n"); process.exitCode = 2; }
`;
}

function fakeGhSiteCustomize(): string {
  return `import os
import subprocess

_harness_real_run = subprocess.run

def _harness_fake_gh_run(args, *positional, **keywords):
    if isinstance(args, (list, tuple)) and args and args[0] == "gh":
        args = [os.environ["HARNESS_E2E_NODE"], os.environ["HARNESS_E2E_FAKE_GH"], *args[1:]]
    return _harness_real_run(args, *positional, **keywords)

subprocess.run = _harness_fake_gh_run
`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
