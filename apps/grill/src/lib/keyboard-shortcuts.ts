import { useMemo, useSyncExternalStore } from "react";

export type ShortcutId =
  | "help"
  | "toggleSessions"
  | "closeOverlay"
  | "scrollUp"
  | "scrollDown"
  | "previousRound"
  | "nextRound"
  | "previousQuestion"
  | "nextQuestion"
  | "selectOption"
  | "focusNote"
  | "reviewPrompt"
  | "copyPrompt";

type ShortcutDefinition = {
  scope: "Global" | "Rounds" | "Questions" | "Prompt review";
  description: string;
  key: string | "Letter";
};

/**
 * The board's complete shortcut plan. Change bindings and help copy here; handlers
 * and visible shortcut hints consume the same definitions. Every shortcut is a single
 * unmodified key, so browser and system combinations stay untouched. Options only run
 * A–D plus "None of these", so letters from F onwards are free for other shortcuts.
 */
export const SHORTCUTS: Record<ShortcutId, ShortcutDefinition> = {
  help: { scope: "Global", description: "Show keyboard shortcuts", key: "h" },
  toggleSessions: { scope: "Global", description: "Toggle session list", key: "m" },
  closeOverlay: { scope: "Global", description: "Close dialog or session list, or leave a text field", key: "Escape" },
  scrollUp: { scope: "Global", description: "Scroll up", key: "ArrowUp" },
  scrollDown: { scope: "Global", description: "Scroll down", key: "ArrowDown" },
  previousRound: { scope: "Rounds", description: "Previous round", key: "PageUp" },
  nextRound: { scope: "Rounds", description: "Next round", key: "PageDown" },
  previousQuestion: { scope: "Questions", description: "Previous question", key: "ArrowLeft" },
  nextQuestion: { scope: "Questions", description: "Next question", key: "ArrowRight" },
  selectOption: {
    scope: "Questions",
    description: "Select matching option, or None of these to write your own",
    key: "Letter",
  },
  focusNote: { scope: "Questions", description: "Move to additional context", key: "n" },
  reviewPrompt: { scope: "Questions", description: "Review prompt", key: "Enter" },
  copyPrompt: { scope: "Prompt review", description: "Copy prompt", key: "c" },
};

const KEY_LABELS: Record<string, string> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  PageUp: "PgUp",
  PageDown: "PgDn",
  Escape: "Esc",
  Enter: "Enter",
  Letter: "A–E",
};

export function shortcutLabel(id: ShortcutId, letter?: string): string {
  const key = SHORTCUTS[id].key;
  return letter?.toUpperCase() ?? KEY_LABELS[key] ?? key.toUpperCase();
}

function shortcutAria(id: ShortcutId, letter?: string): string {
  const key = SHORTCUTS[id].key;
  return letter?.toUpperCase() ?? (key.length === 1 ? key.toUpperCase() : key);
}

function shortcutTitle(label: string, id: ShortcutId): string {
  return `${label} (${shortcutLabel(id)})`;
}

// A fine, hovering primary pointer is the closest signal of a keyboard; phones and tablets fail it.
const KEYBOARD_DEVICE = "(hover: hover) and (pointer: fine)";

function watchKeyboardDevice(onChange: () => void): () => void {
  const query = window.matchMedia(KEYBOARD_DEVICE);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

export type Shortcuts = {
  /** Whether handlers run and hints show. The server renders without them. */
  enabled: boolean;
  aria: (id: ShortcutId, letter?: string) => string | undefined;
  title: (label: string, id: ShortcutId) => string;
};

/** Shortcut availability and hints; a device without a keyboard gets neither handlers nor hints. */
export function useShortcuts(): Shortcuts {
  const enabled = useSyncExternalStore(
    watchKeyboardDevice,
    () => window.matchMedia(KEYBOARD_DEVICE).matches,
    () => false,
  );
  return useMemo(
    () => ({
      enabled,
      aria: (id, letter) => (enabled ? shortcutAria(id, letter) : undefined),
      title: (label, id) => (enabled ? shortcutTitle(label, id) : label),
    }),
    [enabled],
  );
}

export function matchesShortcut(event: KeyboardEvent | React.KeyboardEvent, id: ShortcutId): boolean {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
  const key = SHORTCUTS[id].key;
  return key === "Letter" ? shortcutLetter(event) !== null : event.key.toLocaleLowerCase() === key.toLocaleLowerCase();
}

/**
 * Letter typed by the key. Unmodified keys report the layout's character, so AZERTY and
 * QWERTY users both press the key printed with the option's letter.
 */
export function shortcutLetter(event: KeyboardEvent | React.KeyboardEvent): string | null {
  return /^[a-z]$/iu.test(event.key) ? event.key.toLocaleLowerCase() : null;
}

const TEXT_ENTRY =
  "textarea, select, [contenteditable='true'], .explanation, input:not([type='radio'], [type='checkbox'], [type='button'], [type='submit'], [type='reset'])";

const ACTIVATES_ON_ENTER = "button, a[href], summary, [role='button']";

function isTextEntry(target: EventTarget | null): target is HTMLElement {
  return target instanceof HTMLElement && Boolean(target.closest(TEXT_ENTRY));
}

/**
 * Whether board shortcuts must stay out of this event. Every shortcut is off while typing,
 * and Enter keeps activating a focused button instead of reviewing the prompt.
 */
export function ignoresShortcuts(event: KeyboardEvent): boolean {
  if (
    document.querySelector(".diagram-shell.is-fullscreen") ||
    (event.target instanceof Element && event.target.closest("[data-diagram-shortcuts]"))
  )
    return true;
  if (event.isComposing || isTextEntry(event.target)) return true;
  return event.key === "Enter" && event.target instanceof Element && Boolean(event.target.closest(ACTIVATES_ON_ENTER));
}

/** Escape inside a text field only leaves it, handing the keyboard back to the shortcuts. */
export function leaveTextEntry(event: KeyboardEvent): void {
  if (event.target instanceof Element && event.target.closest("[data-diagram-shortcuts]")) return;
  if (event.isComposing || !matchesShortcut(event, "closeOverlay") || !isTextEntry(event.target)) return;
  event.preventDefault();
  event.target.blur();
}
