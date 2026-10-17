// Load the shipped payload against the installed Pi SDK without a second SDK dependency.
import { after } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const [packageRoot, extensionPath] = process.argv.slice(2);
if (!packageRoot || !extensionPath) throw new Error("Expected installed Pi package and extension paths");
const requirePi = createRequire(join(packageRoot, "package.json"));
const dependencies = new Map([
  ["@earendil-works/pi-coding-agent", join(packageRoot, "dist/index.js")],
  ...["@earendil-works/pi-tui", "typebox"].map(name => [name, requirePi.resolve(name)]),
]);
const root = await mkdtemp(join(tmpdir(), "harness-background-shell-components-"));
after(() => rm(root, { recursive: true, force: true }));
try {
  await build({
    entryPoints: { extension: extensionPath, ui: join(dirname(extensionPath), "ui.ts") },
    bundle: true, splitting: true, platform: "node", format: "esm", target: "node22",
    outdir: root, outExtension: { ".js": ".mjs" }, logLevel: "silent",
    plugins: [{ name: "installed-pi", setup(builder) {
      builder.onResolve({ filter: /^(@earendil-works\/pi-(coding-agent|tui)|typebox)$/ }, args =>
        ({ path: pathToFileURL(dependencies.get(args.path)).href, external: true }));
    } }],
  });
} catch (error) {
  await rm(root, { recursive: true, force: true });
  throw error;
}
export const { default: install } = await import(pathToFileURL(join(root, "extension.mjs")).href);
export const { JobPanel, clean, openJobPanel } = await import(pathToFileURL(join(root, "ui.mjs")).href);
export const { getKeybindings, ScrollView, TuiAltScreen, VStack, visibleWidth } =
  await import(pathToFileURL(requirePi.resolve("@earendil-works/pi-tui")).href);
