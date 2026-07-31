/**
 * Shell-safe command line construction.
 *
 * A launch command is delivered to a terminal as a single line, so any argument
 * containing a newline is unrepresentable in every shell. The remaining hazards
 * are per shell, and an argument that trips one is never escaped cleverly: the
 * caller spills it to a file instead (spec section 5.1.4, "spilling is always
 * safe, so an implementation that is unsure should spill").
 */

export const SHELL_KINDS = ["powershell", "git-bash", "cmd"] as const;

export type ShellKind = (typeof SHELL_KINDS)[number];

/**
 * Characters that cannot be passed inline for a given shell.
 *
 * - PowerShell quotes literally inside `'...'`, but a native argument
 *   containing `"` is passed differently by Windows PowerShell 5.1 and
 *   PowerShell 7.3+, so double quotes are treated as unrepresentable.
 * - Git Bash `'...'` is fully literal; only the single-line rule applies.
 * - `cmd.exe` expands `%VAR%` inside quotes and has no escape for it, so every
 *   metacharacter is treated as unrepresentable.
 */
const ARGUMENT_HAZARDS: Readonly<Record<ShellKind, RegExp>> = {
  powershell: /[\r\n"]/,
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

/**
 * Characters that are literal in every supported shell. Arguments made only of
 * these are emitted bare, because the user reads these command lines in a real
 * terminal and quoting every flag makes them unreadable.
 */
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

/**
 * `command` is the launch command as tokens: the program followed by any fixed
 * arguments it takes before Claude Code's own (`clauder run kiro --`). Every
 * token is quoted individually, so a wrapper's arguments cannot turn into shell
 * operators and a program path may contain spaces.
 */
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
