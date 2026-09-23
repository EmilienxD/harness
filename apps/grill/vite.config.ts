import { fileURLToPath } from "node:url";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

export default defineConfig(({ command }) => ({
  server: { host: "::", port: 8080 },
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  plugins: [
    tanstackStart({ server: { entry: "server" } }),
    // Nitro packages the production server for Vercel; the dev server runs TanStack Start directly.
    command === "build" && nitro({ preset: "vercel" }),
    viteReact(),
  ],
}));
