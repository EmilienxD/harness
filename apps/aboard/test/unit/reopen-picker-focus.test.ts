import assert from "node:assert/strict";
import test from "node:test";
import type { QuickPick } from "vscode";
import { pickReopenSession } from "../../src/vscode/reopen-picker.js";
import { renderReopenItems, type ReopenQuickPickItem } from "../../src/vscode/reopen.js";
import type { AgentId, SessionId, IsoTimestamp } from "../../src/domain/contracts.js";

function row(id: string): ReopenQuickPickItem {
  return renderReopenItems([{ resumable: true, candidate: {
    platform: "pi", agentId: id as AgentId, sessionId: id as SessionId, title: id,
    type: "interactive", origin: "native", description: "Pi", at: "2026-01-01T00:00:00.000Z" as IsoTimestamp,
  } }])[0]!;
}
class Picker {
  value = "";
  busy = false;
  list: readonly ReopenQuickPickItem[] = [];
  active: readonly ReopenQuickPickItem[] = [];
  selectedItems: readonly ReopenQuickPickItem[] = [];
  listeners = new Map<string, Set<(value?: unknown) => void>>();
  constructor(readonly deferred: boolean) {}
  event(name: string) {
    return (callback: (value?: unknown) => void) => {
      const listeners = this.listeners.get(name) ?? new Set();
      listeners.add(callback); this.listeners.set(name, listeners);
      return { dispose: () => { listeners.delete(callback); } };
    };
  }
  emit(name: string, value?: unknown) {
    for (const callback of this.listeners.get(name) ?? []) {
      if (this.deferred && name === "active") queueMicrotask(() => callback(value)); else callback(value);
    }
  }
  onDidChangeValue = this.event("value");
  onDidChangeActive = this.event("active");
  onDidAccept = this.event("accept");
  onDidHide = this.event("hide");
  set items(items: readonly ReopenQuickPickItem[]) { this.list = items; this.activeItems = items.length ? [items[0]!] : []; }
  get items() { return this.list; }
  set activeItems(items: readonly ReopenQuickPickItem[]) { this.active = items; this.emit("active", items); }
  get activeItems() { return this.active; }
  show() {}
  hide() { this.emit("hide"); }
  dispose() {}
}
for (const deferred of [false, true]) {
  test(`picker follows newest arrival until manual navigation (${deferred ? "deferred" : "synchronous"} focus events)`, async () => {
    const picker = new Picker(deferred);
    let publish!: (items: readonly ReopenQuickPickItem[]) => void;
    const result = pickReopenSession(picker as unknown as QuickPick<ReopenQuickPickItem>, [], "Reopen", async (update) => { publish = update; }, () => {});
    const older = row("older"); const newer = row("newer"); const newest = row("newest");
    publish([older]); await Promise.resolve();
    publish([newer, older]); await Promise.resolve();
    assert.equal(picker.activeItems[0]?.option.candidate.sessionId, "newer", "automatically selected first arrival must not stay pinned");
    picker.activeItems = [older]; await Promise.resolve();
    publish([newest, newer, older]); await Promise.resolve();
    assert.equal(picker.activeItems[0]?.option.candidate.sessionId, "older", "manual navigation must survive refresh");
    // Typing an exact ID uses the native search path; clearing it restores newest-first focus.
    picker.value = "older";
    picker.emit("value", picker.value);
    await Promise.resolve();
    assert.equal(picker.items.length, 1);
    picker.value = "";
    picker.emit("value", picker.value);
    await Promise.resolve();
    assert.equal(picker.activeItems[0]?.option.candidate.sessionId, "newest");
    picker.emit("accept");
    assert.equal((await result)?.option.candidate.sessionId, "newest");
  });
}
