/**
 * One spelling for an agent's bound issue numbers.
 *
 * A launch may carry several issues, and four unrelated surfaces name them: the
 * fleet tree label, the completion notification, the Manager's session-start
 * briefing, and a worker's compaction re-grounding. Each formatting them itself
 * is how "issue #12, #14" and "issues #12,#14" end up in the same window.
 */

/** `#12` for one, `#12, #14` for several, empty for none. */
export function formatIssueNumbers(numbers: readonly number[]): string {
  return numbers.map((number) => `#${number}`).join(", ");
}

/** `issue #12` / `issues #12, #14`, empty for none so a caller can drop the clause. */
export function describeIssueNumbers(numbers: readonly number[]): string {
  if (numbers.length === 0) return "";
  return `${numbers.length === 1 ? "issue" : "issues"} ${formatIssueNumbers(numbers)}`;
}
