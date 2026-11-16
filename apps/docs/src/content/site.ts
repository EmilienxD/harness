import type { IconName } from "@/components/docs/content";

// Branding, header tabs, sidebar groups and home cards. Guide text lives in `docs/user/`.
export const siteConfig = {
  name: "Harness",
  title: "Harness documentation",
  description: "Install and configure Harness skills, hooks, command-line tools and extensions for Claude Code, ChatGPT and Pi.",
  repositoryUrl: "https://github.com/EmilienxD/harness",
  repositoryLabel: "Repository",
  // Base URL for "Open in GitHub" links; Markdown paths are appended.
  editBaseUrl: "https://github.com/EmilienxD/harness/blob/main/docs/user/",
};

// A string is a Markdown path relative to `docs/user/`, without `.md`.
// `{ dir }` lists every guide in that folder, sorted by title, so new guides appear automatically.
export type NavItem = string | { path: string; label: string } | { dir: string };

export interface NavGroupConfig {
  title: string;
  items: NavItem[];
}

export interface NavTabConfig {
  label: string;
  groups: NavGroupConfig[];
}

export const navigation: NavTabConfig[] = [
  {
    label: "Guides",
    groups: [
      { title: "Get started", items: [{ path: "index", label: "Introduction" }, "getting-started", "configuration"] },
      { title: "Scripted installation", items: ["ci-usage"] },
    ],
  },
  {
    label: "Productivity",
    groups: [
      { title: "Productivity", items: [{ path: "tools/productivity", label: "Overview" }] },
      { title: "Tools", items: [{ dir: "tools/productivity" }] },
    ],
  },
  {
    label: "Guards & extensions",
    groups: [
      { title: "Guards and extensions", items: [{ path: "tools/guards-and-extensions", label: "Overview" }] },
      { title: "Guards", items: [{ dir: "tools/guards" }] },
      { title: "Extensions", items: [{ dir: "tools/extensions" }] },
    ],
  },
  {
    label: "Workflows",
    groups: [
      { title: "Workflows", items: [{ path: "tools/workflows", label: "Overview" }] },
      { title: "Planning", items: ["tools/workflows/audit", "tools/workflows/breakdown-help-wanted-issue", "tools/workflows/grill-me", "tools/workflows/grill-me-in-cloud", "tools/workflows/lavish", "tools/workflows/prototype", "tools/workflows/read-all-adrs", "tools/workflows/websearch", "tools/workflows/writing-adrs"] },
      { title: "Building", items: ["tools/workflows/flush-out-useless-tests", "tools/workflows/issue-readers", "tools/workflows/issue-writers", "tools/workflows/tdd", "tools/workflows/test-workflows"] },
      { title: "Engineering", items: ["tools/workflows/commit", "tools/workflows/resolving-merge-conflicts", "tools/workflows/setup-git-worktree-maker"] },
      { title: "Shipping", items: ["tools/workflows/setup-help"] },
    ],
  },
];

// Guides that are published but intentionally absent from the sidebar.
// The build fails when any other Markdown file is missing from `navigation`.
export const unlistedPages: Record<string, { tab: string; group: string }> = {
  "tools/workflows/ship": { tab: "Workflows", group: "Unavailable" },
};

export const homeCards: { title: string; path: string; icon: IconName; description: string }[] = [
  { title: "Get started", path: "getting-started", icon: "rocket", description: "Launch the catalogue, choose providers and scope, and script installs." },
  { title: "Configuration", path: "configuration", icon: "settings", description: "Choose installation scope, connect your private board, and customize tools." },
  { title: "Productivity tools", path: "tools/productivity", icon: "zap", description: "Subagents, launchers, handoffs and Pi quality-of-life extensions." },
  { title: "Guards and extensions", path: "tools/guards-and-extensions", icon: "shield", description: "Policy hooks, native Pi guards and the Aboard VS Code extension." },
  { title: "Workflows", path: "tools/workflows", icon: "workflow", description: "Planning, building and engineering skills such as grill-me and commit." },
  { title: "Grill me in cloud", path: "tools/workflows/grill-me-in-cloud", icon: "workflow", description: "Explore design choices with visual interviews on your own private board." },
];
