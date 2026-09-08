export const LABEL_PREFIX = "[AI]-";

export const LABEL_TODO = `${LABEL_PREFIX}todo`;
export const LABEL_AFK = `${LABEL_PREFIX}afk`;
export const LABEL_HITL = `${LABEL_PREFIX}hitl`;
export const LABEL_CHROME = `${LABEL_PREFIX}chrome`;

export const ABOARD_LABELS = [LABEL_TODO, LABEL_AFK, LABEL_HITL, LABEL_CHROME] as const;
export type AboardLabel = (typeof ABOARD_LABELS)[number];

export const ISSUE_DIFFICULTIES = ["routine", "basic", "advanced", "expert"] as const;
export type IssueDifficulty = (typeof ISSUE_DIFFICULTIES)[number];

export const DIFFICULTY_LABELS: { readonly [K in IssueDifficulty]: `${typeof LABEL_PREFIX}${K}-difficulty` } = {
  routine: `${LABEL_PREFIX}routine-difficulty`,
  basic: `${LABEL_PREFIX}basic-difficulty`,
  advanced: `${LABEL_PREFIX}advanced-difficulty`,
  expert: `${LABEL_PREFIX}expert-difficulty`,
};

export type AboardDifficultyLabel = (typeof DIFFICULTY_LABELS)[IssueDifficulty];

function normalizeLabel(label: string): string {
  return label.trim().toLowerCase();
}

/** GitHub label names are compared case-insensitively, as GitHub does. */
export function hasLabel(labels: readonly string[], expected: AboardLabel | AboardDifficultyLabel): boolean {
  const normalizedExpected = normalizeLabel(expected);
  return labels.some((label) => normalizeLabel(label) === normalizedExpected);
}

export function issueDifficulty(labels: readonly string[]): IssueDifficulty | undefined {
  for (let index = ISSUE_DIFFICULTIES.length - 1; index >= 0; index -= 1) {
    const difficulty = ISSUE_DIFFICULTIES[index]!;
    if (hasLabel(labels, DIFFICULTY_LABELS[difficulty])) return difficulty;
  }
  return undefined;
}

export function issueDisposition(labels: readonly string[]): "afk" | "hitl" | "unclassified" {
  if (hasLabel(labels, LABEL_HITL)) return "hitl";
  return hasLabel(labels, LABEL_AFK) ? "afk" : "unclassified";
}
