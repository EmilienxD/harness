/**
 * aboard's four GitHub labels: `[AI]-spec`, `[AI]-todo`, `[AI]-afk`, `[AI]-hitl`.
 *
 * The `[AI]-` prefix keeps these from colliding with a user's own labels — a
 * plainly-named `todo` would let aboard adopt (or, worse, strip the label from)
 * an issue it does not own, and a user-applied `hitl` would silently flip
 * merge gating. The prefix is shared with the vendored user's issue skills
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

function normalizeLabel(label: string): string {
  return label.trim().toLowerCase();
}

/** GitHub label names are compared case-insensitively, as GitHub does. */
export function hasLabel(labels: readonly string[], expected: AboardLabel): boolean {
  const normalizedExpected = normalizeLabel(expected);
  return labels.some((label) => normalizeLabel(label) === normalizedExpected);
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
