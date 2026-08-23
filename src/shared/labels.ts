/**
 * aboard's GitHub labels: the four that classify an issue — `[AI]-spec`,
 * `[AI]-todo`, `[AI]-afk`, `[AI]-hitl` — and the four that rate one's
 * difficulty.
 *
 * The `[AI]-` prefix keeps these from colliding with a user's own labels — a
 * plainly-named `todo` would let aboard adopt (or, worse, strip the label from)
 * an issue it does not own, and a user-applied `hitl` would silently flip
 * merge gating. The prefix is shared with the project's issue skills
 * (map-issues/draft-issues/publish-issues emit the same names), so `[AI]-` is a
 * project convention, not an aboard-private one.
 *
 * Everything compares through the constants below; the literal strings never
 * appear in a query or a classification check anywhere else.
 */
export const LABEL_PREFIX = "[AI]-";

export const LABEL_SPEC = `${LABEL_PREFIX}spec`;
export const LABEL_TODO = `${LABEL_PREFIX}todo`;
export const LABEL_AFK = `${LABEL_PREFIX}afk`;
export const LABEL_HITL = `${LABEL_PREFIX}hitl`;

export const ABOARD_LABELS = [LABEL_SPEC, LABEL_TODO, LABEL_AFK, LABEL_HITL] as const;
export type AboardLabel = (typeof ABOARD_LABELS)[number];

/**
 * How much reasoning an issue is expected to need, in ascending order. The
 * issue-writing skill applies exactly one; aboard only reads it, and treats it
 * as a hint that selects launch policy (`src/claude/launch.ts`) rather than as
 * anything the run branches on.
 */
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

/**
 * The difficulty a label set expresses. The highest wins a contradictory set,
 * for the reason `[AI]-hitl` wins its own pair: of the two readings, only one
 * errs toward more capability than the work turned out to need.
 *
 * Absence is not an error and not a guess — it resolves to the same fallback an
 * unlabelled issue gets, which is the most capable tier.
 */
export function issueDifficulty(labels: readonly string[]): IssueDifficulty | undefined {
  for (let index = ISSUE_DIFFICULTIES.length - 1; index >= 0; index -= 1) {
    const difficulty = ISSUE_DIFFICULTIES[index]!;
    if (hasLabel(labels, DIFFICULTY_LABELS[difficulty])) return difficulty;
  }
  return undefined;
}

/**
 * The disposition a label set expresses. `[AI]-hitl` wins a contradictory pair
 * because only a human may close it. Absence of both is legitimate — the
 * caller reports it as unclassified and never guesses.
 */
export function issueDisposition(labels: readonly string[]): "afk" | "hitl" | "unclassified" {
  if (hasLabel(labels, LABEL_HITL)) return "hitl";
  return hasLabel(labels, LABEL_AFK) ? "afk" : "unclassified";
}
