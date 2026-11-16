import { copyFile, mkdir, readdir } from "node:fs/promises";
const source = new URL("../../../docs/user/assets/", import.meta.url);
const target = new URL("../public/assets/", import.meta.url);
await mkdir(target, { recursive: true });
for (const entry of await readdir(source, { withFileTypes: true })) {
  if (entry.isFile() && entry.name.endsWith(".png")) {
    await copyFile(new URL(entry.name, source), new URL(entry.name, target));
  }
}
