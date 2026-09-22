export type ShortcutId =
  | "help"
  | "toggleSessions"
  | "closeOverlay"
  | "previousRound"
  | "nextRound"
  | "previousQuestion"
  | "nextQuestion"
  | "selectOption"
  | "focusNote"
  | "saveAnswer"
  | "reviewPrompt"
  | "copyPrompt";

type ShortcutDefinition = {
  scope: "Global" | "Rounds" | "Questions" | "Prompt review";
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
  previousRound: { scope: "Rounds", description: "Previous round", key: "ArrowUp", alt: true, shift: true },
  nextRound: { scope: "Rounds", description: "Next round", key: "ArrowDown", alt: true, shift: true },
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
  selectOption: {
    scope: "Questions",
    description: "Select matching option, or None of these to write your own",
    key: "Letter",
    alt: true,
    shift: true,
  },
  focusNote: { scope: "Questions", description: "Move to additional context", key: "k", alt: true, shift: true },
  saveAnswer: { scope: "Questions", description: "Save answer now", key: "s", alt: true, shift: true },
  reviewPrompt: { scope: "Questions", description: "Review prompt", key: "Enter", alt: true, shift: true },
  copyPrompt: { scope: "Prompt review", description: "Copy prompt", key: "c", alt: true, shift: true },
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
  const letter = shortcutLetter(event);
  const keyMatches =
    shortcut.key === "Letter"
      ? letter !== null
      : shortcut.key.length === 1
        ? letter === shortcut.key.toLocaleLowerCase()
        : event.key.toLocaleLowerCase() === shortcut.key.toLocaleLowerCase();
  return (
    keyMatches &&
    event.altKey === Boolean(shortcut.alt) &&
    event.shiftKey === Boolean(shortcut.shift) &&
    (event.ctrlKey || event.metaKey) === Boolean(shortcut.controlOrMeta)
  );
}

/**
 * Letter of the physical key. Alt/Option and Shift rewrite `event.key` on macOS and many
 * layouts (Option+Shift+A is "Å"), so letters come from `event.code` instead.
 */
export function shortcutLetter(event: KeyboardEvent | React.KeyboardEvent): string | null {
  const match = /^Key([A-Z])$/u.exec(event.code);
  return match?.[1]?.toLocaleLowerCase() ?? null;
}

const TEXT_ENTRY =
  "textarea, select, [contenteditable='true'], .explanation, input:not([type='radio'], [type='checkbox'], [type='button'], [type='submit'], [type='reset'])";

/**
 * Whether a board shortcut must stay out of this event. Modified shortcuts never produce
 * text, so they work whatever holds focus (radios, buttons, the note field); bare keys
 * such as Escape still yield to text entry.
 */
export function ignoresShortcuts(event: KeyboardEvent): boolean {
  if (event.isComposing) return true;
  if (event.altKey || event.ctrlKey || event.metaKey) return false;
  return event.target instanceof Element && Boolean(event.target.closest(TEXT_ENTRY));
}

export function shortcutTitle(label: string, id: ShortcutId): string {
  return `${label} (${shortcutLabel(id)})`;
}
