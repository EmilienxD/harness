import assert from "node:assert/strict";
import test from "node:test";

import { ChatGptBrowserProbe, codexConfigPath, parseBrowserBackends } from "../src/chatgpt/browser.js";

test("browser capability parsing accepts casing, whitespace, duplicates, and any configured tool server name", () => {
  assert.deepEqual(parseBrowserBackends(`
[mcp_servers.my-browser-server]
command = "browser-use"

[mcp_servers.my-browser-server.env]
BROWSER_USE_AVAILABLE_BACKENDS = "  CDP , Chrome ,chrome,  "
OPENAI_API_KEY = "secret"
`), ["cdp", "chrome"]);

  assert.deepEqual(parseBrowserBackends(`
[mcp_servers.browser]
env = { OTHER = "x", BROWSER_USE_AVAILABLE_BACKENDS = "chrome,builtin" }
`), ["chrome", "builtin"]);

  assert.deepEqual(parseBrowserBackends(`
[mcp_servers.browser]
env = {
  BROWSER_USE_AVAILABLE_BACKENDS = "chrome"
}
`), ["chrome"]);

  assert.deepEqual(parseBrowserBackends(`
mcp_servers.browser.env.BROWSER_USE_AVAILABLE_BACKENDS = "chrome" # inline comment
`), ["chrome"]);
});

test("browser capability parsing ignores missing, malformed, and unrelated declarations", () => {
  assert.deepEqual(parseBrowserBackends(""), []);
  assert.deepEqual(parseBrowserBackends("[mcp_servers.browser.env]\nBROWSER_USE_AVAILABLE_BACKENDS = \n"), []);
  assert.deepEqual(parseBrowserBackends("[mcp_servers.browser.env]\nBROWSER_USE_AVAILABLE_BACKENDS = [\"chrome\"]\n"), []);
  assert.deepEqual(parseBrowserBackends("[mcp_servers.browser.env]\nBROWSER_USE_AVAILABLE_BACKENDS = \" , , \"\n"), []);
  assert.deepEqual(parseBrowserBackends("[shell_environment_policy.env]\nBROWSER_USE_AVAILABLE_BACKENDS = \"chrome\"\n"), []);
  assert.deepEqual(parseBrowserBackends("[mcp_servers.browser]\nBROWSER_USE_AVAILABLE_BACKENDS = \"chrome\"\n"), []);
  // A commented-out declaration is not an effective declaration.
  assert.deepEqual(parseBrowserBackends("[mcp_servers.browser.env]\n# BROWSER_USE_AVAILABLE_BACKENDS = \"chrome\"\n"), []);
});

test("the browser probe merges every configured tool server and reports Chrome as available", async () => {
  const probe = new ChatGptBrowserProbe({
    paths: ["config.toml"],
    read: async () => `
[mcp_servers.scans.env]
BROWSER_USE_AVAILABLE_BACKENDS = "builtin"

[mcp_servers."visual qa".env]
BROWSER_USE_AVAILABLE_BACKENDS = "chrome"
`,
  });

  assert.deepEqual(await probe.backends(), ["builtin", "chrome"]);
  await probe.require("implementer");
});

test("the browser probe refuses Chrome work without exposing unrelated configuration", async () => {
  const probe = new ChatGptBrowserProbe({
    paths: ["C:/codex/config.toml"],
    read: async () => `
[mcp_servers.browser]
command = "browser-use"

[mcp_servers.browser.env]
OPENAI_API_KEY = "sk-do-not-print-this"
BROWSER_USE_AVAILABLE_BACKENDS = "builtin"
`,
  });

  await assert.rejects(probe.require("implementer"), (error: Error) => {
    assert.match(error.message, /BROWSER_USE_AVAILABLE_BACKENDS/u);
    assert.match(error.message, /declared: builtin/u);
    assert.doesNotMatch(error.message, /sk-do-not-print-this|browser-use/u);
    return true;
  });
});

test("the browser probe treats an unreadable Codex configuration as no declared backend", async () => {
  const probe = new ChatGptBrowserProbe({ paths: [codexConfigPath("C:/missing")], read: async () => undefined });

  assert.deepEqual(await probe.backends(), []);
  await assert.rejects(probe.require("implementer"), /config\.toml/u);
});
