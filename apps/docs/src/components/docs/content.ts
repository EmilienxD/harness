// Shared documentation types. Markdown in `docs/user/` is parsed into these shapes at build time.
export type IconName = "rocket" | "settings" | "terminal" | "zap" | "shield" | "workflow" | "puzzle" | "git" | "book" | "layers";

export interface ResourceCard {
  title: string;
  href: string;
  icon: IconName;
  description?: string;
}

export interface CodeToken {
  content: string;
  color?: string;
  fontStyle?: number;
}

export type HighlightedCode = CodeToken[][];

export type CalloutTone = "info" | "tip" | "warning";

export type ContentBlock =
  | { type: "prose"; html: string }
  | { type: "callout"; tone: CalloutTone; title?: string; html: string }
  | { type: "code"; title?: string; language: string; code: string; highlightedCode?: HighlightedCode }
  | { type: "table"; columns: string[]; rows: string[][] }
  | { type: "image"; src: string; alt: string };

export interface DocSection {
  // Sections without a title hold the introduction before the first `##` heading.
  id?: string;
  title?: string;
  titleHtml?: string;
  blocks: ContentBlock[];
}

export interface DocArticle {
  slug: string;
  href: string;
  title: string;
  group: string;
  titleId: string;
  tab: string;
  description: string;
  platforms: string[];
  sourcePath: string;
  sections: DocSection[];
}

// The serializable subset that client components need for navigation.
export interface NavLink {
  slug: string;
  href: string;
  title: string;
}

export interface NavGroupData {
  title: string;
  links: NavLink[];
}

export interface NavTabData {
  label: string;
  href: string;
  groups: NavGroupData[];
}

export function slugHref(slug: string) {
  return slug ? `/${slug}/` : "/";
}
