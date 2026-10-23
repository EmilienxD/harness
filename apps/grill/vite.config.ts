import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig, type Plugin } from "vite";

/** Keep editor fonts on our origin, with identical paths in development and production. */
function diagramAssets(): Plugin {
  const root = fileURLToPath(new URL("./node_modules/@excalidraw/excalidraw/dist/prod/", import.meta.url));
  const paths = readdirSync(join(root, "fonts"), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).replaceAll("\\", "/"));
  const notices = readFileSync(new URL("./THIRD-PARTY-NOTICES.md", import.meta.url));
  return {
    name: "grill-diagram-assets",
    configureServer(server) {
      server.middlewares.use("/diagram-assets/", (request, response, next) => {
        const path = request.url?.split("?")[0]?.replace(/^\//, "");
        if (path === "THIRD-PARTY-NOTICES.md") {
          response.setHeader("Content-Type", "text/plain; charset=utf-8");
          response.end(notices);
          return;
        }
        if (!path || !paths.includes(path)) return next();
        response.setHeader("Content-Type", path.endsWith(".woff2") ? "font/woff2" : "text/plain");
        response.end(readFileSync(join(root, path)));
      });
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "diagram-assets/THIRD-PARTY-NOTICES.md", source: notices });
      for (const path of paths)
        this.emitFile({ type: "asset", fileName: `diagram-assets/${path}`, source: readFileSync(join(root, path)) });
    },
  };
}

export default defineConfig(({ command }) => ({
  server: { host: "::", port: 8080 },
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  plugins: [
    diagramAssets(),
    tanstackStart({ server: { entry: "server" } }),
    // Nitro packages the production server for Vercel; the dev server runs TanStack Start directly.
    command === "build" && nitro({ preset: "vercel" }),
    viteReact(),
  ],
}));
