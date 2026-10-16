const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { writeFileSync, statSync } = require("node:fs");
const { join } = require("node:path");

const [cli, origin, root] = process.argv.slice(2);
function call(...args) {
  return execFileSync(process.execPath, [cli, ...args], {
    encoding: "utf8", timeout: 45_000, windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"], maxBuffer: 4 * 1024 * 1024,
  });
}

try {
  call("start", "--headless=true", `--userDataDir=${join(root, "browser-profile")}`, "--no-usage-statistics", "--no-performance-crux");
  const pages = call("new_page", origin);
  const row = pages.split("\n").find((line) => line.includes(origin) && /^\d+:/u.test(line));
  assert.ok(row, "CLI did not create the fixture page");
  const pageId = row.match(/^(\d+):/u)[1];
  const snapshot = call("take_snapshot", pageId);
  const uid = snapshot.match(/uid=([\w-]+) button "Increment"/u)?.[1];
  assert.ok(uid, "Browser snapshot did not expose the fixture button");
  call("click", pageId, uid);
  const changed = call("take_snapshot", pageId);
  assert.match(changed, /heading "Count: 1"/u);
  const screenshot = join(root, "browser.png");
  call("take_screenshot", pageId, "--filePath", screenshot);
  assert.ok(statSync(screenshot).size > 100);
  writeFileSync(join(root, "browser-result.json"), JSON.stringify({ count: 1, screenshot: true }));
  process.stdout.write("Browser interaction verified.\n");
} finally {
  call("stop");
}
