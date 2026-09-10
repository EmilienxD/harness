import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { spawnableCommand } from "../core/path.js";

test("Windows npm commands preserve exact argv without cmd.exe", { skip: process.platform !== "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "harness-npm-shim-"));
  const shim = join(root, "example-cli.cmd");
  const entry = join(root, "node_modules", "example-cli", "bin", "cli.js");
  const args = [
    "-c",
    'hooks.SessionStart=[{matcher="startup|resume",hooks=[{command="echo (ready) ^ now"}]}]',
    "prompt with spaces & punctuation",
  ];
  try {
    mkdirSync(join(root, "node_modules", "example-cli", "bin"), { recursive: true });
    writeFileSync(entry, "process.stdout.write(JSON.stringify(process.argv.slice(2)))");
    writeFileSync(shim, `@ECHO off\nSETLOCAL\nSET "_prog=node"\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\example-cli\\bin\\cli.js" %*\n`);

    const command = spawnableCommand(shim, args);
    const result = spawnSync(command.file, [...command.args], { encoding: "utf8", windowsHide: true });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), args);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows launcher falls through an unknown shim to a native executable", { skip: process.platform !== "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "harness-native-fallback-"));
  const shimDirectory = join(root, "shim");
  const nativeDirectory = join(root, "native");
  const native = join(nativeDirectory, "example-cli.exe");
  const previousPath = process.env.PATH;
  try {
    mkdirSync(shimDirectory);
    mkdirSync(nativeDirectory);
    writeFileSync(join(shimDirectory, "example-cli.cmd"), "@ECHO off\r\nexit /b 0\r\n");
    writeFileSync(native, "not executed");
    process.env.PATH = `${shimDirectory}${delimiter}${nativeDirectory}`;

    assert.deepEqual(spawnableCommand("example-cli", ["--version"]), { file: native, args: ["--version"] });
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rmSync(root, { recursive: true, force: true });
  }
});
