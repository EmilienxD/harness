import { ProgressLocation, Uri, commands, window } from "vscode";
import { samePath } from "../git/worktree.js";
import { CheckoutBranchInUseError, CheckoutSetupError, type CheckoutSelection, type ManualCheckouts } from "../platform/checkouts.js";

export async function pickCheckout(checkouts: ManualCheckouts, workspaceRoot: string): Promise<CheckoutSelection | undefined> {
  const choices = await checkouts.choices();
  const current = choices.entries.find((entry) => samePath(entry.path, workspaceRoot));
  const selected = await window.showQuickPick([
    { label: "Current checkout", description: current ? current.branch ?? "Detached HEAD" : "Current folder", selection: { kind: "current" } as CheckoutSelection },
    ...(choices.nextPath ? [{ label: "New worktree…", description: choices.nextPath, selection: { kind: "new", branch: "" } as CheckoutSelection }] : []),
    ...choices.entries.filter((entry) => !samePath(entry.path, workspaceRoot)).map((entry) => ({ label: entry.branch ?? "Detached HEAD", description: entry.path, detail: [!entry.available ? "Missing or unavailable checkout" : entry.reserved ? "Reserved by Auto Run" : entry.preparation ? "Setup incomplete" : entry.dirty ? "Modified files" : "", entry.agents ? `${entry.agents} agents in this window share these files` : ""].filter(Boolean).join(" · "), selection: { kind: "existing", path: entry.path } as CheckoutSelection })),
  ], { placeHolder: choices.error ?? "Choose the checkout for this agent" });
  if (!selected) return undefined;
  if (selected.selection.kind !== "new") return selected.selection;
  const branch = await window.showInputBox({ title: "New worktree", prompt: `Branch name · ${choices.nextPath}. Uncommitted changes stay in the source checkout.`, ignoreFocusOut: true, validateInput: (value) => value.trim() ? undefined : "Enter a branch name." });
  if (!branch) return undefined;
  const existing = await checkouts.branchExists(branch.trim());
  if (existing) {
    const answer = await window.showWarningMessage(`Branch ${branch.trim()} already exists. Create a worktree using that branch?`, { modal: true }, "Use existing branch");
    return answer ? { kind: "new", branch: branch.trim(), useExistingBranch: true } : undefined;
  }
  const startPoint = await window.showInputBox({ title: "New worktree: starting point", prompt: "Leave empty for the current checkout's exact HEAD, including local commits. Uncommitted changes are not copied.", placeHolder: "Current HEAD (default), branch, remote branch, or commit", ignoreFocusOut: true });
  if (startPoint === undefined) return undefined;
  return { kind: "new", branch: branch.trim(), ...(startPoint.trim() ? { startPoint: startPoint.trim() } : {}) };
}

export async function prepareCheckout(checkouts: ManualCheckouts, selection: CheckoutSelection, log: (message: string) => void, showLog: () => void): Promise<string | undefined> {
  try {
    return await window.withProgress({ location: ProgressLocation.Notification, title: "Preparing checkout", cancellable: false }, (progress) => checkouts.prepare(selection, (message) => { log(message); progress.report({ message }); }));
  } catch (error) {
    if (error instanceof CheckoutBranchInUseError) {
      const answer = await window.showWarningMessage(error.message, "Use existing worktree");
      return answer === "Use existing worktree" ? prepareCheckout(checkouts, { kind: "existing", path: error.path }, log, showLog) : undefined;
    }
    if (!(error instanceof CheckoutSetupError)) throw error;
    log(error.message);
    const action = await window.showErrorMessage(error.message, "Retry setup", "Open checkout", "View log");
    if (action === "Open checkout") await commands.executeCommand("vscode.openFolder", Uri.file(error.path), { forceNewWindow: true });
    if (action === "View log") showLog();
    if (action === "Retry setup") {
      return window.withProgress({ location: ProgressLocation.Notification, title: "Retrying worktree setup", cancellable: false }, (progress) => checkouts.retrySetup(error.path, (message) => { log(message); progress.report({ message }); }));
    }
    return undefined;
  }
}
