import assert from "node:assert/strict";
import test from "node:test";

import { ChatGptPolicyError, ChatGptPolicyProbe, parseManagedPolicy } from "../../src/chatgpt/policy.js";

function probe(files: Readonly<Record<string, string>>): ChatGptPolicyProbe {
  return new ChatGptPolicyProbe({ paths: Object.keys(files), read: async (path) => files[path] });
}

test("managed Codex requirements are read for the keys Aboard depends on", () => {
  const policy = parseManagedPolicy([
    "# managed",
    'allowed_sandbox_modes = ["workspace-write", "READ-ONLY"] # both',
    'default_permissions = "aboard-worktree"',
    "allow_managed_hooks_only = false",
    "",
    "[allowed_permission_profiles]",
    "aboard-worktree = true",
    "other-profile = false",
    "",
    "[features]",
    "hooks = true",
    "",
    "[[hooks.PreToolUse]]",
    'matcher = "^Bash$"',
  ].join("\n"), "requirements.toml");

  assert.deepEqual(policy, {
    source: "requirements.toml",
    allowedSandboxModes: ["workspace-write", "read-only"],
    allowedPermissionProfiles: { "aboard-worktree": true, "other-profile": false },
    defaultPermissions: "aboard-worktree",
    allowManagedHooksOnly: false,
    hooks: true,
  });
});

test("an absent managed policy leaves every capability unconstrained", async () => {
  const empty = new ChatGptPolicyProbe({ paths: ["/etc/codex/requirements.toml"], read: async () => undefined });
  assert.deepEqual(await empty.policies(), []);
  await empty.require("Explore");
});

test("a managed sandbox allowlist without read-only blocks a ChatGPT Explore session", async () => {
  const policy = probe({ "/etc/codex/requirements.toml": 'allowed_sandbox_modes = ["workspace-write"]\n' });

  await assert.rejects(policy.require("Explore"), (error: unknown) => {
    assert.ok(error instanceof ChatGptPolicyError);
    assert.equal(error.capability, "read-only-sandbox");
    assert.match(error.message, /\/etc\/codex\/requirements\.toml/u);
    assert.match(error.message, /allowed_sandbox_modes to workspace-write, which excludes read-only/u);
    return true;
  });
  await policy.require("interactive");
});

test("a managed approval allowlist without never blocks a ChatGPT Explore session", async () => {
  const policy = probe({ "/etc/codex/requirements.toml": 'allowed_approval_policies = ["untrusted", "on-request"]\n' });

  await assert.rejects(policy.require("Explore"), (error: unknown) => {
    assert.ok(error instanceof ChatGptPolicyError);
    assert.equal(error.capability, "never-approval");
    assert.match(error.message, /\/etc\/codex\/requirements\.toml/u);
    assert.match(error.message, /allowed_approval_policies to untrusted, on-request, which excludes never/u);
    return true;
  });
  await policy.require("interactive");
});

test("managed policy that disables Aboard's hooks is reported as policy, not as a timeout", async () => {
  await assert.rejects(probe({ "C:/codex/requirements.toml": "[features]\nhooks = false\n" }).require("Explore"), (error: unknown) => {
    assert.ok(error instanceof ChatGptPolicyError);
    assert.equal(error.capability, "lifecycle-hooks");
    assert.match(error.message, /hooks = false/u);
    return true;
  });

  await assert.rejects(probe({ "C:/codex/requirements.toml": "allow_managed_hooks_only = true\n" }).require("Explore"), (error: unknown) => {
    assert.ok(error instanceof ChatGptPolicyError);
    assert.equal(error.capability, "lifecycle-hooks");
    assert.match(error.message, /allow_managed_hooks_only = true/u);
    return true;
  });
});

test("a multi-line sandbox allowlist containing read-only is accepted", async () => {
  const policy = probe({
    "/etc/codex/requirements.toml": 'allowed_sandbox_modes = [\n  "read-only",\n  "workspace-write",\n]\n[features]\nhooks = true\n',
  });
  await policy.require("Explore");
});

test("managed permission requirements reject an isolated ChatGPT worker before launch", async () => {
  const policy = probe({
    "C:/codex/requirements.toml": [
      'allowed_approval_policies = ["on-request"]',
      "[allowed_permission_profiles]",
      'aboard-worktree = false',
    ].join("\n"),
  });

  await assert.rejects(policy.require("implementer", "aboard-worktree"), (error: unknown) => {
    assert.ok(error instanceof ChatGptPolicyError);
    assert.equal(error.capability, "permission-profile");
    assert.match(error.message, /aboard-worktree/u);
    return true;
  });
});

test("an allowed isolated ChatGPT profile still requires never approval", async () => {
  const policy = probe({
    "C:/codex/requirements.toml": [
      'allowed_approval_policies = ["on-request"]',
      "[allowed_permission_profiles]",
      'aboard-worktree = true',
    ].join("\n"),
  });

  await assert.rejects(policy.require("reviewer", "aboard-worktree"), (error: unknown) => {
    assert.ok(error instanceof ChatGptPolicyError);
    assert.equal(error.capability, "never-approval");
    return true;
  });
});
