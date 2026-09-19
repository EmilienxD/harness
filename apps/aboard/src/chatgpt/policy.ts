import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { AgentType } from "../domain/contracts.js";

export type ChatGptPolicyCapability = "lifecycle-hooks" | "read-only-sandbox" | "never-approval" | "permission-profile";

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
  readonly allowedPermissionProfiles?: Readonly<Record<string, boolean>>;
  readonly defaultPermissions?: string;
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

  public async require(agentType: AgentType, permissionProfile?: string): Promise<void> {
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
          `Managed Codex policy in ${policy.source} sets allow_managed_hooks_only = true, so Codex skips the project hooks Aboard scaffolds for a ${agentType} session and its result would never arrive. Ask your administrator to allow project hooks.`,
        );
      }
      if (permissionProfile !== undefined) {
        if (policy.allowedPermissionProfiles !== undefined && policy.allowedPermissionProfiles[permissionProfile] !== true) {
          throw new ChatGptPolicyError(
            "permission-profile",
            `Managed Codex policy in ${policy.source} does not allow the ${permissionProfile} permission profile required to isolate the user's original checkout. Ask your administrator to allow that profile.`,
          );
        }
        if (policy.defaultPermissions !== undefined && policy.defaultPermissions !== permissionProfile) {
          throw new ChatGptPolicyError(
            "permission-profile",
            `Managed Codex policy in ${policy.source} requires the ${policy.defaultPermissions} permission profile, so Aboard cannot select ${permissionProfile} to isolate the user's original checkout.`,
          );
        }
      }
      const modes = policy.allowedSandboxModes;
      if (agentType === "explore" && permissionProfile === undefined && modes !== undefined && !modes.includes("read-only")) {
        throw new ChatGptPolicyError(
          "read-only-sandbox",
          `Managed Codex policy in ${policy.source} limits allowed_sandbox_modes to ${modes.join(", ")}, which excludes read-only. A ChatGPT explore session must run read-only. Ask your administrator to allow the read-only sandbox mode.`,
        );
      }
      const approvals = policy.allowedApprovalPolicies;
      if ((agentType === "explore" || permissionProfile !== undefined) && approvals !== undefined && !approvals.includes("never")) {
        const subject = permissionProfile === undefined
          ? "A ChatGPT explore session"
          : `The ${permissionProfile} permission profile`;
        throw new ChatGptPolicyError(
          "never-approval",
          `Managed Codex policy in ${policy.source} limits allowed_approval_policies to ${approvals.join(", ")}, which excludes never. ${subject} runs approval_policy="never" so it cannot escalate outside its filesystem boundary. Ask your administrator to allow the never approval policy.`,
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
  const allowedPermissionProfiles: Record<string, boolean> = {};
  let defaultPermissions: string | undefined;
  let allowManagedHooksOnly: boolean | undefined;
  let hooks: boolean | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = stripTomlComment(lines[index] ?? "");
    if (line.length === 0) continue;
    if (line.startsWith("[")) { table = line.replace(/^\[+/u, "").replace(/\]+$/u, "").trim(); continue; }
    const assignment = /^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/u.exec(line);
    if (assignment === null) continue;
    let value = assignment[2] ?? "";
    while (value.startsWith("[") && !value.includes("]") && index + 1 < lines.length) {
      index += 1;
      value += ` ${stripTomlComment(lines[index] ?? "")}`;
    }
    const key = table === "" ? assignment[1] : `${table}.${assignment[1] ?? ""}`;
    if (key === "allowed_sandbox_modes") allowedSandboxModes = strings(value);
    else if (key === "allowed_approval_policies") allowedApprovalPolicies = strings(value);
    else if (key === "default_permissions") defaultPermissions = string(value);
    else if (table === "allowed_permission_profiles" && assignment[1] !== undefined) {
      const allowed = boolean(value);
      if (allowed !== undefined) allowedPermissionProfiles[assignment[1]] = allowed;
    }
    else if (key === "allow_managed_hooks_only") allowManagedHooksOnly = boolean(value);
    else if (key === "features.hooks") hooks = boolean(value);
  }
  return {
    source,
    ...(allowedSandboxModes === undefined ? {} : { allowedSandboxModes }),
    ...(allowedApprovalPolicies === undefined ? {} : { allowedApprovalPolicies }),
    ...(Object.keys(allowedPermissionProfiles).length === 0 ? {} : { allowedPermissionProfiles }),
    ...(defaultPermissions === undefined ? {} : { defaultPermissions }),
    ...(allowManagedHooksOnly === undefined ? {} : { allowManagedHooksOnly }),
    ...(hooks === undefined ? {} : { hooks }),
  };
}

export function stripTomlComment(line: string): string {
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

function string(value: string): string | undefined {
  const match = /^(?:"([^"]*)"|'([^']*)')$/u.exec(value.trim());
  return match === null ? undefined : match[1] ?? match[2];
}
