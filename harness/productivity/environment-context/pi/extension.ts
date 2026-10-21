import { execFile, spawn } from "node:child_process";
import { arch, release, type } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const STATUS_LINES = 12;
const STATUS_CHARS = 1200;
const TIMEOUT_MS = 2000;
const gitEnv = () => ({ ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" });

function git(cwd: string, args: string[]): Promise<{ code: number | string; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile("git", ["--no-optional-locks", ...args], {
      cwd, timeout: TIMEOUT_MS, maxBuffer: 64 * 1024, encoding: "utf8", windowsHide: true,
      env: gitEnv(),
    }, (error, stdout, stderr) => {
      resolve({ code: error ? (error.code ?? "failed") : 0, stdout, stderr });
    });
  });
}

export interface GitCounts {
  total: number;
  modified: number;
  added: number;
  deleted: number;
  renamed: number;
  copied: number;
  untracked: number;
  conflicted: number;
  staged: number;
  unstaged: number;
}

export type GitStatus =
  | { kind: "missing" }
  | { kind: "unavailable" }
  | { kind: "repository"; counts: GitCounts; branch: string; files: string[]; truncated: boolean };

function summarizeStatus(cwd: string): Promise<GitStatus> {
  return new Promise((resolve) => {
    // Stream all NUL-delimited records for accurate totals without retaining a large listing.
    const child = spawn("git", ["--no-optional-locks", "status", "--porcelain=v1", "--branch", "-z", "--untracked-files=all"], {
      cwd, windowsHide: true, env: gitEnv(), stdio: ["ignore", "pipe", "ignore"],
    });
    const counts = { total: 0, modified: 0, added: 0, deleted: 0, renamed: 0, copied: 0, untracked: 0, conflicted: 0, staged: 0, unstaged: 0 };
    const files: string[] = [];
    let branch = "";
    let pending = "";
    let skipRenameSource = false;
    let timedOut = false;
    let invalid = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      pending += chunk;
      let end: number;
      while ((end = pending.indexOf("\0")) !== -1) {
        const record = pending.slice(0, end);
        pending = pending.slice(end + 1);
        if (skipRenameSource) { skipRenameSource = false; continue; }
        if (record.startsWith("## ")) { branch = record.slice(0, 300); continue; }
        if (record.length < 4 || record[2] !== " ") { invalid = true; continue; }
        const status = record.slice(0, 2);
        skipRenameSource = /[RC]/.test(status);
        counts.total++;
        if (status === "??") counts.untracked++;
        else {
          const conflict = status.includes("U") || status === "AA" || status === "DD";
          if (conflict) counts.conflicted++;
          else {
            if (/[MT]/.test(status)) counts.modified++;
            if (status.includes("A")) counts.added++;
            if (status.includes("D")) counts.deleted++;
            if (status.includes("R")) counts.renamed++;
            if (status.includes("C")) counts.copied++;
            if (status[0] !== " ") counts.staged++;
            if (status[1] !== " ") counts.unstaged++;
          }
        }
        if (files.length < STATUS_LINES) files.push(`${status} ${JSON.stringify(record.slice(3)).slice(0, STATUS_CHARS)}`);
      }
      // Protect memory against malformed output; real path records are much smaller.
      if (pending.length > 128 * 1024) { invalid = true; child.kill(); }
    });
    child.on("error", () => { clearTimeout(timer); resolve({ kind: "unavailable" }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || timedOut || invalid || pending || skipRenameSource) {
        resolve({ kind: "unavailable" });
        return;
      }
      resolve({
        kind: "repository", counts, branch, files,
        truncated: counts.total > files.length || files.join("\n").length > STATUS_CHARS,
      });
    });
  });
}

export async function collectGitStatus(cwd: string): Promise<GitStatus> {
  const repository = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (repository.code !== 0 || repository.stdout.trim() !== "true") {
    if (repository.stderr.includes("not a git repository") || (repository.code === 0 && repository.stdout.trim() === "false")) {
      return { kind: "missing" };
    }
    return { kind: "unavailable" };
  }
  return summarizeStatus(cwd);
}

function renderGitStatus(status: GitStatus): string {
  if (status.kind === "missing") return "No Git exists in the cwd (not inside a Git working tree).";
  if (status.kind === "unavailable") return "Git status unavailable (Git missing, inspection failed or timed out); file counts unknown.";
  const { counts, branch, files, truncated } = status;
  const summary = `Files: ${counts.total} changed; ${counts.modified} modified, ${counts.added} added (tracked), `
    + `${counts.deleted} deleted, ${counts.renamed} renamed, ${counts.copied} copied, `
    + `${counts.untracked} untracked (new), ${counts.conflicted} conflicted.\n`
    + `Tracked non-conflict files: ${counts.staged} staged, ${counts.unstaged} unstaged (categories can overlap).`;
  const listing = files.join("\n").slice(0, STATUS_CHARS);
  return "Git status snapshot at agent-run start; may change during the run.\n"
    + summary + (branch ? `\n${branch}` : "") + (listing ? `\n${listing}` : "")
    + (truncated ? "\n[Git file list truncated; counts above cover the full status]" : "");
}

export default function (pi: ExtensionAPI) {
  let sessionStart = "";
  let timezone = "";

  pi.on("session_start", (_event, ctx) => {
    // The session header survives resume and reload: never advance the snapshot clock.
    sessionStart = ctx.sessionManager.getHeader()?.timestamp ?? new Date().toISOString();
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const sections = event.systemPromptOptions.sections;
    sections.environment = `Operating system: ${type()} ${release()} (${arch()}).\n`
      + `Session-start time snapshot: ${sessionStart}.\n`
      + `Local timezone: ${timezone}.\n`
      + "This is a snapshot at session start. It is not updated and is not the current time. "
      + "Query the clock if the current date or time is needed.";
    sections.git_snapshot = renderGitStatus(await collectGitStatus(ctx.cwd));
  });
}
