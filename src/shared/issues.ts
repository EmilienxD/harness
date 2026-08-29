
/** `#12` for one, `#12, #14` for several, empty for none. */
export function formatIssueNumbers(numbers: readonly number[]): string {
  return numbers.map((number) => `#${number}`).join(", ");
}

/** `issue #12` / `issues #12, #14`, empty for none so a caller can drop the clause. */
export function describeIssueNumbers(numbers: readonly number[]): string {
  if (numbers.length === 0) return "";
  return `${numbers.length === 1 ? "issue" : "issues"} ${formatIssueNumbers(numbers)}`;
}

export function referencedIssueNumbers(
  body: string,
  repository?: { readonly owner: string; readonly repo: string },
): readonly number[] {
  const prose = body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/~~~[\s\S]*?~~~/g, " ")
    .replace(/`[^`\r\n]*`/g, " ");
  const found = new Set<number>();
  for (const match of prose.matchAll(/(^|[^\p{L}\p{N}_])#([1-9]\d*)\b/gu)) {
    found.add(Number(match[2]));
  }
  if (repository !== undefined) {
    const owner = escapeRegExp(repository.owner);
    const repo = escapeRegExp(repository.repo);
    const pattern = new RegExp(
      `https?:\\/\\/(?:www\\.)?github\\.com\\/${owner}\\/${repo}\\/issues\\/([1-9]\\d*)\\b`,
      "giu",
    );
    for (const match of prose.matchAll(pattern)) found.add(Number(match[1]));
  }
  return [...found];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
