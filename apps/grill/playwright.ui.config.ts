import { defineConfig } from "@playwright/test";

// Browser-only state/race regressions intercept every API call and need no database.
export default defineConfig({
  testDir: "./test/ui",
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
      SUPABASE_URL: "http://127.0.0.1:9",
      SUPABASE_SECRET_KEY: "ui-tests-do-not-use-a-database",
      HARNESS_GRILL_CODE: "1234",
      HARNESS_GRILL_SESSION_SECRET: "local-ui-acceptance-secret-only",
    },
  },
});
