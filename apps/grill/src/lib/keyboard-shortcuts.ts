export type ShortcutId =
  | "help"
  | "toggleSessions"
  | "closeOverlay"
  | "previousSession"
  | "nextSession"
  | "previousQuestion"
  | "nextQuestion"
  | "selectOption"
  | "queueAnswer"
  | "reviewPrompt"
  | "copyPrompt"
  | "sendPrompt";

type ShortcutDefinition = {
  scope: "Global" | "Sessions" | "Questions" | "Prompt review";
  description: string;
  key: string | "Letter";
  alt?: boolean;
  shift?: boolean;
  controlOrMeta?: boolean;
};

/**
 * The board's complete shortcut plan. Change bindings and help copy here; handlers
 * and visible shortcut hints consume the same definitions.
 */
export const SHORTCUTS: Record<ShortcutId, ShortcutDefinition> = {
  help: { scope: "Global", description: "Show keyboard shortcuts", key: "h", alt: true, shift: true },
  toggleSessions: { scope: "Global", description: "Toggle session list", key: "m", alt: true, shift: true },
  closeOverlay: { scope: "Global", description: "Close dialog or session list", key: "Escape" },
  previousSession: { scope: "Sessions", description: "Previous session", key: "ArrowUp", alt: true, shift: true },
  nextSession: { scope: "Sessions", description: "Next session", key: "ArrowDown", alt: true, shift: true },
  previousQuestion: {
    scope: "Questions",
    description: "Previous question",
    key: "ArrowLeft",
    alt: true,
    shift: true,
  },
  nextQuestion: {
    scope: "Questions",
    description: "Next question",
    key: "ArrowRight",
    alt: true,
    shift: true,
  },
  selectOption: { scope: "Questions", description: "Select matching option", key: "Letter", alt: true, shift: true },
  queueAnswer: { scope: "Questions", description: "Queue or update answer", key: "Enter", alt: true, shift: true },
  reviewPrompt: { scope: "Questions", description: "Review prompt", key: "r", alt: true, shift: true },
  copyPrompt: { scope: "Prompt review", description: "Copy prompt", key: "c", alt: true, shift: true },
  sendPrompt: { scope: "Prompt review", description: "Send via Aboard", key: "s", alt: true, shift: true },
};

const KEY_LABELS: Record<string, string> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Escape: "Esc",
  Enter: "Enter",
  Letter: "A–Z",
};

export function shortcutLabel(id: ShortcutId, letter?: string): string {
  const shortcut = SHORTCUTS[id];
  const key = letter?.toUpperCase() ?? KEY_LABELS[shortcut.key] ?? shortcut.key.toUpperCase();
  return [shortcut.controlOrMeta ? "Ctrl/Cmd" : "", shortcut.alt ? "Alt" : "", shortcut.shift ? "Shift" : "", key]
    .filter(Boolean)
    .join("+");
}

export function shortcutAria(id: ShortcutId, letter?: string): string {
  const shortcut = SHORTCUTS[id];
  const key = letter?.toUpperCase() ?? shortcut.key;
  return [shortcut.controlOrMeta ? "Control" : "", shortcut.alt ? "Alt" : "", shortcut.shift ? "Shift" : "", key]
    .filter(Boolean)
    .join("+");
}

export function matchesShortcut(event: KeyboardEvent | React.KeyboardEvent, id: ShortcutId): boolean {
  const shortcut = SHORTCUTS[id];
  const keyMatches =
    shortcut.key === "Letter"
      ? /^[a-z]$/iu.test(event.key)
      : event.key.toLocaleLowerCase() === shortcut.key.toLocaleLowerCase();
  return (
    keyMatches &&
    event.altKey === Boolean(shortcut.alt) &&
    event.shiftKey === Boolean(shortcut.shift) &&
    (event.ctrlKey || event.metaKey) === Boolean(shortcut.controlOrMeta)
  );
}

export function isShortcutEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest("input, textarea, select, [contenteditable='true'], .explanation"));
}

export function shortcutTitle(label: string, id: ShortcutId): string {
  return `${label} (${shortcutLabel(id)})`;
}
