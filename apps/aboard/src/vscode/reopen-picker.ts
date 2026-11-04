import type { QuickPick } from "vscode";
import { reopenItemsForQuery, type ReopenQuickPickItem, type ReopenCommandHost } from "./reopen.js";

type Load = Parameters<ReopenCommandHost["pick"]>[2];

/** Native QuickPick lifecycle, kept separate from extension activation for interaction tests. */
export function pickReopenSession(
  picker: QuickPick<ReopenQuickPickItem>,
  initialItems: readonly ReopenQuickPickItem[],
  placeholder: string,
  load: Load,
  log: (message: string) => void,
): Promise<ReopenQuickPickItem | undefined> {
  let items = initialItems;
  let closed = false;
  let applyingItems = false;
  let userNavigated = false;
  let automaticFocus: string | undefined;
  const key = (item: ReopenQuickPickItem | undefined) => item === undefined ? undefined : `${item.option.candidate.platform}:${item.option.candidate.sessionId}`;
  const refresh = () => {
    const previous = key(picker.activeItems[0]);
    applyingItems = true;
    try {
      const visibleItems = [...reopenItemsForQuery(items, picker.value)];
      const retained = userNavigated ? visibleItems.find((item) => key(item) === previous) : undefined;
      const target = retained ?? visibleItems[0];
      automaticFocus = key(target);
      picker.items = visibleItems;
      // Let native filtering choose its matching row while a query is entered.
      if (!picker.value) picker.activeItems = target ? [target] : [];
    } finally { applyingItems = false; }
  };
  const abort = new AbortController();
  picker.placeholder = placeholder;
  picker.matchOnDescription = true;
  picker.matchOnDetail = true;
  picker.items = [...items];
  return new Promise((resolve) => {
    const subscriptions = [
      picker.onDidChangeValue(() => { userNavigated = false; refresh(); }),
      picker.onDidChangeActive((active) => {
        const selected = key(active[0]);
        // Ignore programmatic focus, including stale events delivered after a refresh.
        if (applyingItems || selected === undefined || selected !== key(picker.activeItems[0]) || selected === automaticFocus) return;
        userNavigated = true;
      }),
      picker.onDidAccept(() => {
        const chosen = picker.selectedItems[0] ?? picker.activeItems[0];
        if (chosen !== undefined) { resolve(chosen); picker.hide(); }
      }),
      picker.onDidHide(() => {
        closed = true; abort.abort(); resolve(undefined);
        for (const subscription of subscriptions) subscription.dispose();
        picker.dispose();
      }),
    ];
    picker.busy = load !== undefined;
    picker.show();
    void load?.((next) => {
      if (closed) return;
      items = next;
      refresh();
    }, abort.signal).catch((error: unknown) => {
      if (!closed) log(`Reopen: ${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => { if (!closed) picker.busy = false; });
  });
}
