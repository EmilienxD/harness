import { exec } from "node:child_process";

import type { VendoredSkillInstaller } from "./project.js";

const INSTALL_TIMEOUT_MS = 120_000;

/**
 * Runs a vendored skill's upstream install command through the platform shell so
 * the command table can hold ordinary shell one-liners on Windows and POSIX
 * alike. Output is surfaced only in the failure message: an install command is
 * the user's, and its stdout may name private repositories or tokens.
 */
export function createVendoredSkillInstaller(): VendoredSkillInstaller {
  return {
    run: (command, cwd) => new Promise<void>((resolve, reject) => {
      exec(command, { cwd, timeout: INSTALL_TIMEOUT_MS, windowsHide: true }, (error, _stdout, stderr) => {
        if (error === null) { resolve(); return; }
        const detail = stderr.trim().split(/\r?\n/u).at(-1) ?? "";
        reject(new Error(detail.length > 0 ? detail : error.message));
      });
    }),
  };
}
