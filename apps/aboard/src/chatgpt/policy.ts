import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { AgentType } from "../domain/contracts.js";

export type ChatGptPolicyCapability = "lifecycle-hooks" | "read-only-sandbox" | "never-approval";

export class ChatGptPolicyError extends Error {
  public constructor(public readonly capability: ChatGptPolicyCapability, message: string) {
    super(message);
    this.name = "ChatGptPolicyError";
  }
}

export interface ChatGptManagedPolicy {
  readonly source: string;
  readonly allowedSandboxModes?: readonly string[];
  readonly allowedApprovalPolicies?: readonly string[];
  readonly allowManagedHooksOnly?: boolean;
  readonly hooks?: boolean;
}

export function codexConfigDirectory(): string {
  return process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

export function managedRequirementPaths(codexHome: string = codexConfigDirectory()): readonly string[] {
  return process.platform === "win32"
    ? [join(codexHome, "requirements.toml")]
    : [join(codexHome, "requirements.toml"), "/etc/codex/requirements.toml"];
}

export class ChatGptPolicyProbe {
  readonly #read: (path: string) => Promise<string | undefined>;
  readonly #paths: readonly string[];

  public constructor(options: { readonly codexHome?: string; readonly paths?: readonly string[]; readonly read?: (path: string) => Promise<string | undefined> } = {}) {
    this.#paths = options.paths ?? managedRequirementPaths(options.codexHome);
    this.#read = options.read ?? (async (path) => readFile(path, "utf8").catch(() => undefined));
  }

  public async policies(): Promise<readonly ChatGptManagedPolicy[]> {
    const texts = await Promise.all(this.#paths.map(async (path) => ({ path, text: await this.#read(path) })));
    return texts
      .filter((entry): entry is { path: string; text: string } => entry.text !== undefined)
      .map((entry) => parseManagedPolicy(entry.text, entry.path));
  }

  public async require(agentType: AgentType): Promise<void> {
    for (const policy of await this.policies()) {
      if (policy.hooks === false) {
        throw new ChatGptPolicyError(
          "lifecycle-hooks",
          `Managed Codex policy in ${policy.source} pins [features] hooks = false, so Aboard's lifecycle hooks never run and a ${agentType} session could not report its start or its result. Ask your administrator to allow Codex hooks.`,
        );
      }
      if (policy.allowManagedHooksOnly === true) {
        throw new ChatGptPolicyError(
          "lifecycle-hooks",
          `Managed Codex policy in ${policy.source} sets allow_managed_hooks_only = true, so Codex skips the hooks Aboard generates for a ${agentType} session and its result would never arrive. Ask your administrator to allow session hooks.`,
        );
      }
      if (agentType !== "Explore") continue;
      const modes = policy.allowedSandboxModes;
      if (modes !== undefined && !modes.includes("read-only")) {
        throw new ChatGptPolicyError(
          "read-only-sandbox",
          `Managed Codex policy in ${policy.source} limits allowed_sandbox_modes to ${modes.join(", ")}, which excludes read-only. A ChatGPT Explore session must run read-only. Ask your administrator to allow the read-only sandbox mode.`,
        );
      }
      const approvals = policy.allowedApprovalPolicies;
      if (approvals !== undefined && !approvals.includes("never")) {
        throw new ChatGptPolicyError(
          "never-approval",
          `Managed Codex policy in ${policy.source} limits allowed_approval_policies to ${approvals.join(", ")}, which excludes never. A ChatGPT Explore session runs approval_policy="never" so it cannot escalate out of its read-only sandbox. Ask your administrator to allow the never approval policy.`,
        );
      }
    }
  }
}

export function parseManagedPolicy(text: string, source: string): ChatGptManagedPolicy {
  const lines = text.split(/\r?\n/u);
  let table = "";
  let allowedSandboxModes: readonly string[] | undefined;
  let allowedApprovalPolicies: readonly string[] | undefined;
  let allowManagedHooksOnly: boolean | undefined;
  let hooks: boolean | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = strip(lines[index] ?? "");
    if (line.length === 0) continue;
    if (line.startsWith("[")) { table = line.replace(/^\[+/u, "").replace(/\]+$/u, "").trim(); continue; }
    const assignment = /^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/u.exec(line);
    if (assignment === null) continue;
    let value = assignment[2] ?? "";
    while (value.startsWith("[") && !value.includes("]") && index + 1 < lines.length) {
      index += 1;
      value += ` ${strip(lines[index] ?? "")}`;
    }
    const key = table === "" ? assignment[1] : `${table}.${assignment[1] ?? ""}`;
    if (key === "allowed_sandbox_modes") allowedSandboxModes = strings(value);
    else if (key === "allowed_approval_policies") allowedApprovalPolicies = strings(value);
    else if (key === "allow_managed_hooks_only") allowManagedHooksOnly = boolean(value);
    else if (key === "features.hooks") hooks = boolean(value);
  }
  return {
    source,
    ...(allowedSandboxModes === undefined ? {} : { allowedSandboxModes }),
    ...(allowedApprovalPolicies === undefined ? {} : { allowedApprovalPolicies }),
    ...(allowManagedHooksOnly === undefined ? {} : { allowManagedHooksOnly }),
    ...(hooks === undefined ? {} : { hooks }),
  };
}

function strip(line: string): string {
  let quote: string | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote !== undefined) { if (character === quote) quote = undefined; continue; }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === "#") return line.slice(0, index).trim();
  }
  return line.trim();
}

function strings(value: string): readonly string[] | undefined {
  if (!value.startsWith("[")) return undefined;
  return [...value.matchAll(/"([^"]*)"|'([^']*)'/gu)].map((match) => (match[1] ?? match[2] ?? "").trim().toLowerCase());
}

function boolean(value: string): boolean | undefined {
  return value === "true" ? true : value === "false" ? false : undefined;
}
