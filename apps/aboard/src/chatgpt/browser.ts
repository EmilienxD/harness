import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { AgentType } from "../domain/contracts.js";
import { codexConfigDirectory, stripTomlComment } from "./policy.js";

export const BROWSER_BACKENDS_VARIABLE = "BROWSER_USE_AVAILABLE_BACKENDS";
export const CHROME_BACKEND = "chrome";

export class ChatGptBrowserError extends Error {
  public constructor(public readonly backend: string, message: string) {
    super(message);
    this.name = "ChatGptBrowserError";
  }
}

export function codexConfigPath(codexHome: string = codexConfigDirectory()): string {
  return join(codexHome, "config.toml");
}

/** Backends a configured Codex tool server declares, whatever that server is named. */
export function parseBrowserBackends(text: string): readonly string[] {
  const lines = text.split(/\r?\n/u);
  const found: string[] = [];
  let table = "";
  for (let index = 0; index < lines.length; index += 1) {
    const line = stripTomlComment(lines[index] ?? "");
    if (line.length === 0) continue;
    if (line.startsWith("[")) { table = key(line.replace(/^\[+/u, "").replace(/\]+$/u, "")); continue; }
    const assignment = /^([^=]+?)\s*=\s*(.*)$/u.exec(line);
    if (assignment === null) continue;
    let value = (assignment[2] ?? "").trim();
    while (value.startsWith("{") && !value.includes("}") && index + 1 < lines.length) {
      index += 1;
      value += ` ${stripTomlComment(lines[index] ?? "")}`;
    }
    const path = key(`${table === "" ? "" : `${table}.`}${assignment[1] ?? ""}`);
    if (!path.startsWith("mcp_servers.")) continue;
    if (path.endsWith(`.env.${BROWSER_BACKENDS_VARIABLE}`)) found.push(...backends(quoted(value)));
    else if (path.endsWith(".env")) found.push(...backends(inlineEntry(value)));
  }
  return unique(found);
}

export class ChatGptBrowserProbe {
  readonly #read: (path: string) => Promise<string | undefined>;
  readonly #paths: readonly string[];

  public constructor(options: { readonly codexHome?: string; readonly paths?: readonly string[]; readonly read?: (path: string) => Promise<string | undefined> } = {}) {
    this.#paths = options.paths ?? [codexConfigPath(options.codexHome)];
    this.#read = options.read ?? (async (path) => readFile(path, "utf8").catch(() => undefined));
  }

  public async backends(): Promise<readonly string[]> {
    const texts = await Promise.all(this.#paths.map((path) => this.#read(path)));
    return unique(texts.flatMap((text) => (text === undefined ? [] : [...parseBrowserBackends(text)])));
  }

  public async require(agentType: AgentType): Promise<void> {
    const available = await this.backends();
    if (available.includes(CHROME_BACKEND)) return;
    throw new ChatGptBrowserError(
      CHROME_BACKEND,
      `This ${agentType} carries [AI]-chrome, but no configured Codex tool server in ${this.#paths.join(", ")} declares ${CHROME_BACKEND} in ${BROWSER_BACKENDS_VARIABLE}${available.length === 0 ? "" : ` (declared: ${available.join(", ")})`}. Add ${CHROME_BACKEND} to that server's ${BROWSER_BACKENDS_VARIABLE} value, or remove the [AI]-chrome label.`,
    );
  }
}

function key(path: string): string {
  return path.replaceAll(/["'\s]/gu, "");
}

function quoted(value: string): string | undefined {
  const match = /^"([^"]*)"$|^'([^']*)'$/u.exec(value);
  return match === null ? undefined : match[1] ?? match[2];
}

function inlineEntry(value: string): string | undefined {
  if (!value.startsWith("{")) return undefined;
  const match = new RegExp(`(?:^|[{,\\s])["']?${BROWSER_BACKENDS_VARIABLE}["']?\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "u").exec(value);
  return match === null ? undefined : match[1] ?? match[2];
}

function backends(value: string | undefined): readonly string[] {
  if (value === undefined) return [];
  return value.split(",").map((entry) => entry.trim().toLowerCase()).filter((entry) => entry.length > 0);
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}
