import { readdir, rename, rmdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Next 16.3's exporter flattens '/' in segment names, but collectSegmentPaths uses
// path.join. On Windows it leaves nested __next.* directories where the browser
// requests dot-separated .txt filenames. Keep the export portable to plain hosts.
const output = fileURLToPath(new URL("../out/", import.meta.url));
function insideOutput(file) {
  const relative = path.relative(output, file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Export path outside out/: ${file}`);
  return file;
}
async function flatten(directory, routeDirectory, segments) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const source = insideOutput(path.join(directory, entry.name));
    const parts = [...segments, entry.name];
    if (entry.isDirectory()) await flatten(source, routeDirectory, parts);
    else await rename(source, insideOutput(path.join(routeDirectory, parts.join("."))));
  }
  await rmdir(directory);
}
async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "_next") continue;
    const child = insideOutput(path.join(directory, entry.name));
    if (entry.name.startsWith("__next.")) await flatten(child, directory, [entry.name]);
    else await visit(child);
  }
}
await visit(output);
