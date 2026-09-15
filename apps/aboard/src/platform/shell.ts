
export const SHELL_KINDS = ["powershell", "git-bash", "cmd"] as const;

export type ShellKind = (typeof SHELL_KINDS)[number];

const ARGUMENT_HAZARDS: Readonly<Record<ShellKind, RegExp>> = {
  // PowerShell's outer single-quoted argument safely carries double quotes;
  // Codex hook overrides need those quotes inside their TOML value.
  powershell: /[\r\n]/,
  "git-bash": /[\r\n]/,
  cmd: /[\r\n"%!^&|<>]/,
};

export class ShellQuotingError extends Error {
  public constructor(
    public readonly shell: ShellKind,
    message: string,
  ) {
    super(message);
  }
}

/** True when `value` can be passed as a single command-line argument. */
export function canQuoteArgument(shell: ShellKind, value: string): boolean {
  return !ARGUMENT_HAZARDS[shell].test(value);
}

const BARE_ARGUMENT = /^[A-Za-z0-9_.:=+/-]+$/;

export function quoteArgument(shell: ShellKind, value: string): string {
  if (!canQuoteArgument(shell, value)) {
    throw new ShellQuotingError(
      shell,
      `Argument cannot be represented on a ${shell} command line`,
    );
  }
  if (BARE_ARGUMENT.test(value)) return value;
  switch (shell) {
    case "powershell":
      return `'${value.replaceAll("'", "''")}'`;
    case "git-bash":
      return `'${value.replaceAll("'", "'\\''")}'`;
    case "cmd":
      return `"${value}"`;
  }
}

export function buildChangeDirectoryCommandLine(shell: ShellKind, cwd: string): string {
  switch (shell) {
    case "powershell":
      return `cd -LiteralPath ${quoteArgument(shell, cwd)}`;
    case "git-bash":
      return `cd -- ${quoteArgument(shell, cwd)}`;
    case "cmd":
      return `cd /d ${quoteArgument(shell, cwd)}`;
  }
}

export function buildCommandLine(
  shell: ShellKind,
  command: readonly string[],
  args: readonly string[],
): string {
  const quoted = [...command, ...args].map((value) => quoteArgument(shell, value));
  // PowerShell needs the call operator to run a quoted path.
  const parts = shell === "powershell" ? ["&", ...quoted] : quoted;
  return parts.join(" ");
}

