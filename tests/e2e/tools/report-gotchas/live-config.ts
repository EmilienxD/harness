import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** The explicit live journey reads only the configured webhook; never log or persist its URL. */
export async function configuredWebhookUrl(): Promise<string> {
  let value = process.env.HARNESS_REPORT_GOTCHAS_E2E_WEBHOOK_URL ?? process.env.HARNESS_REPORT_GOTCHAS_WEBHOOK_URL;
  if (!value) {
    try {
      const config = JSON.parse(await readFile(join(homedir(), ".harness", "report-gotchas", "config.json"), "utf8"));
      if (config.version === 1) value = config.webhook_url;
    } catch { /* report a structural configuration error below */ }
  }
  if (typeof value !== "string") throw new Error("Live Discord E2E needs a configured webhook; use the pinned uvx configure command in docs/user/tools/productivity/report-gotchas.md");
  try {
    const url = new URL(value.trim());
    if (url.protocol === "https:" && (url.hostname === "discord.com" || url.hostname.endsWith(".discord.com")) && url.pathname.startsWith("/api/webhooks/")) return url.toString();
  } catch { /* never echo a secret-bearing URL */ }
  throw new Error("Live Discord E2E configuration is not a Discord HTTPS webhook URL");
}
