import { Rocket, Settings2, Terminal, Zap, ShieldCheck, Workflow, Puzzle, GitBranch, BookOpen, Layers } from "lucide-react";
import type { IconName } from "./content";
const icons = { rocket: Rocket, settings: Settings2, terminal: Terminal, zap: Zap, shield: ShieldCheck, workflow: Workflow, puzzle: Puzzle, git: GitBranch, book: BookOpen, layers: Layers };
export function DocIcon({ name, className }: { name: IconName; className?: string }) {
  const Icon = icons[name];
  return <Icon className={className} size={24} strokeWidth={1.5} aria-hidden="true" />;
}
export function BrandMark({ className = "" }: { className?: string }) {
  return <span className={`brand-mark ${className}`} aria-hidden="true" />;
}
