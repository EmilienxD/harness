export const SESSION_TITLE_LIMIT = 40;

/** Keep full titles in state; apply the shared display limit only at UI boundaries. */
export function sessionTitleLabel(title: string | undefined): string {
  const clean = title?.replace(/[\u0000-\u001f\u007f\s]+/gu, " ").trim() || "New session";
  const characters = Array.from(clean);
  return characters.length <= SESSION_TITLE_LIMIT ? clean : `${characters.slice(0, SESSION_TITLE_LIMIT - 1).join("")}…`;
}
