import { isAbsolute, normalize, relative } from "node:path";

export function containsPath(parent: string, candidate: string): boolean {
  const rel = relative(normalize(parent), normalize(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
