/**
 * aboard's four GitHub labels: `ai:spec`, `ai:todo`, `ai:afk`, `ai:hitl`.
 *
 * The `ai:` prefix keeps these from colliding with a user's own labels — a
 * plainly-named `todo` would let aboard adopt (or, worse, strip the label from)
 * an issue it does not own, and a user-applied `hitl` would silently flip
 * merge gating. The prefix is shared with the vendored user's issue skills
 * (map-issues/draft-issues/publish-issues emit the same names), so `ai:` is a
 * project convention, not an aboard-private one.
 *
 * Everything compares through the constants below; the literal strings never
 * appear in a query or a classification check anywhere else.
 */
export const LABEL_PREFIX = "ai:";

export const LABEL_SPEC = "ai:spec";
export const LABEL_TODO = "ai:todo";
export const LABEL_AFK = "ai:afk";
export const LABEL_HITL = "ai:hitl";

export const ABOARD_LABELS = [LABEL_SPEC, LABEL_TODO, LABEL_AFK, LABEL_HITL] as const;
export type AboardLabel = (typeof ABOARD_LABELS)[number];

/**
 * The disposition a label set expresses. `ai:hitl` wins a contradictory pair
 * because only a human may close it. Absence of both is legitimate — the
 * caller reports it as unclassified and never guesses.
 */
export function issueDisposition(labels: readonly string[]): "afk" | "hitl" | "unclassified" {
  const normalized = new Set(labels.map((label) => label.trim().toLowerCase()));
  if (normalized.has(LABEL_HITL)) return "hitl";
  return normalized.has(LABEL_AFK) ? "afk" : "unclassified";
}
