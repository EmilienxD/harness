import type { Disposable } from "vscode";

import { agentPlatformName } from "../domain/contracts.js";
import { sessionTitleLabel } from "../domain/session-title.js";
import { basename } from "node:path";
import { describeReopenOutcome, type ReopenCoordinator, type ReopenOption } from "../platform/reopen.js";
import { describeIssueNumbers } from "../shared/issues.js";

export interface ReopenQuickPickItem {
  readonly label: string;
  readonly description: string;
  readonly detail: string;
  readonly option: ReopenOption;
}

export interface ReopenCommandHost {
  registerCommand(command: string, callback: (...args: readonly unknown[]) => unknown): Disposable;
  /** Returns the chosen item, or undefined when the user dismissed the picker. */
  pick(items: readonly ReopenQuickPickItem[], placeholder: string, load?: (publish: (items: readonly ReopenQuickPickItem[]) => void, signal: AbortSignal) => Promise<void>): Promise<ReopenQuickPickItem | undefined>;
  info(message: string): void;
  warning(message: string): void;
  error(message: string): void;
}

export function renderReopenItems(
  options: readonly ReopenOption[],
  now: Date = new Date(),
): readonly ReopenQuickPickItem[] {
  return options.map((option) => {
    const { candidate } = option;
    const label = sessionTitleLabel(candidate.title);
    const described = candidate.issueNumbers === undefined ? "" : describeIssueNumbers(candidate.issueNumbers);
    return {
      label,
      description: [agentPlatformName(candidate.platform), candidate.cwd === undefined ? "" : basename(candidate.cwd.replaceAll("\\", "/")), described].filter(Boolean).join(" · "),
      detail: [
        detailFor(option, now),
        candidate.cwd,
        candidate.title !== undefined && candidate.title !== label ? candidate.title : "",
      ].filter(Boolean).join(" · "),
      option,
    };
  });
}

/** An exact pasted session ID bypasses VS Code's visible-text filter without displaying IDs. */
export function reopenItemsForQuery(
  items: readonly ReopenQuickPickItem[],
  value: string,
): readonly (ReopenQuickPickItem & { readonly alwaysShow?: boolean })[] {
  const sessionId = value.trim().toLowerCase();
  const matches = items.filter((item) => item.option.candidate.sessionId.toLowerCase() === sessionId);
  return matches.length > 0 ? matches.map((item) => ({ ...item, alwaysShow: true })) : items;
}

function detailFor(option: ReopenOption, now: Date): string {
  const { candidate } = option;
  const chrome = candidate.chromeEnabled === true ? " · Chrome" : "";
  if (!option.resumable) {
    return option.reason === "inspection-failed"
      ? `Cannot inspect this conversation; ${option.diagnostic ?? "unknown platform error"}${chrome}`
      : `Conversation unavailable · Last active ${age(candidate.at, now)}${chrome}`;
  }
  switch (candidate.origin) {
    case "live": return `Open in Aboard · Focus existing terminal${chrome}`;
    case "native": return `Last active ${age(candidate.at, now)} · Native history · May be open outside Aboard${chrome}`;
    case "ended": return `Last active ${age(candidate.at, now)} · Aboard history · Resume conversation${chrome}`;
  }
}

/** Coarse on purpose: the picker sorts by recency, so this only has to place a row in time. */
export function age(at: string, now: Date): string {
  const elapsed = now.getTime() - Date.parse(at);
  if (!Number.isFinite(elapsed) || elapsed < 0) return "recently";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function registerReopenCommand(host: ReopenCommandHost, reopen: ReopenCoordinator): Disposable {
  return host.registerCommand("aboard.reopenSession", async () => {
    const chosen = await host.pick([], "Reopen a session from this project or its Git worktrees", async (publish, signal) => {
      let pending: readonly ReopenOption[] | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let published = false;
      const cancel = () => {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
        pending = undefined;
      };
      const flush = () => {
        const options = pending;
        cancel();
        if (options !== undefined && !signal.aborted) publish(renderReopenItems(options));
      };
      const update = (options: readonly ReopenOption[]) => {
        if (signal.aborted) return;
        // Deliver the first useful rows immediately. Thereafter render only the newest
        // snapshot once per interval, not every discovery batch over the extension bridge.
        if (!published) {
          if (options.length === 0) return;
          published = true;
          publish(renderReopenItems(options));
          return;
        }
        pending = options;
        if (timer === undefined) timer = setTimeout(flush, 150);
      };
      signal.addEventListener("abort", cancel, { once: true });
      try {
        if (signal.aborted) return;
        const items = await reopen.list(update, signal);
        pending = items;
        flush(); // Always deliver the complete final list before clearing the loading indicator.
      } catch (error) {
        flush();
        if (!signal.aborted) host.error(error instanceof Error ? error.message : "Unable to list sessions");
      } finally {
        signal.removeEventListener("abort", cancel);
        cancel();
      }
    });
    if (chosen === undefined) return;
    if (!chosen.option.resumable) {
      host.warning(chosen.option.reason === "inspection-failed"
        ? `The conversation for ${chosen.label} could not be inspected: ${chosen.option.diagnostic ?? "unknown platform error"}`
        : `The selected agent platform no longer has the conversation for ${chosen.label}, so it cannot be reopened.`);
      return;
    }
    try {
      const outcome = await reopen.reopen(chosen.option.candidate);
      if (outcome.action === "unresumable") host.warning(describeReopenOutcome(outcome));
      else if (outcome.action === "none") host.info(describeReopenOutcome(outcome));
    } catch (error) {
      host.error(error instanceof Error ? error.message : "Unable to reopen that session");
    }
  });
}
