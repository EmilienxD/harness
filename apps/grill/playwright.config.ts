import { execSync } from "node:child_process";
import { defineConfig } from "@playwright/test";

// Always bind acceptance tests to the local stack, regardless of deployment env files.
const local = JSON.parse(execSync("npx supabase status -o json", { encoding: "utf8" }));
if (!new URL(local.API_URL).hostname.match(/^(127\.0\.0\.1|localhost)$/)) {
  throw new Error("Browser tests require local Supabase");
}

export default defineConfig({
  testDir: "./test/browser",
  workers: 1,
  projects: [
    { name: "desktop", use: { viewport: { width: 1280, height: 900 } } },
    { name: "mobile", use: { viewport: { width: 390, height: 844 } } },
  ],
  use: { baseURL: "http://localhost:8087", headless: true },
  webServer: {
    command: "npm run dev -- --port 8087 --strictPort",
    url: "http://localhost:8087",
    reuseExistingServer: false,
    env: {
      SUPABASE_URL: local.API_URL,
      SUPABASE_SECRET_KEY: local.SERVICE_ROLE_KEY,
      HARNESS_GRILL_CODE: "1234",
      HARNESS_GRILL_SESSION_SECRET: "local-notes-acceptance-secret-only",
    },
  },
});
