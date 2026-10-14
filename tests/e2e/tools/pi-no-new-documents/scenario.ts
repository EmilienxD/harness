import { createPiToolScenario } from "../../core/pi-scenario.js";

export const marker = "[E2E:pi-no-new-documents]";
export function scenario() {
  const shell = process.platform === "win32" ? "powershell" : "bash";
  return createPiToolScenario({ name: "pi-no-new-documents", marker, steps: [
    { checkpoint: "deny-native-document", tool: "write", input: { path: "docs/new.md", content: "forbidden\n" } },
    { checkpoint: "write-mirrored-draft", tool: "write", input: { path: ".harness/doc-drafts/docs/new.md", content: "approved content\n" } },
    { checkpoint: "existing-document-edit", tool: "write", input: { path: "docs/existing.md", content: "updated existing\n" } },
    { checkpoint: "deny-literal-shell-create", tool: shell, input: { command: 'echo forbidden > docs/shell.md' } },
    { checkpoint: "deny-shell-draft-promotion", tool: shell, input: { command: shell === "powershell" ? 'Copy-Item .harness/doc-drafts/docs/new.md docs/new.md' : 'cp .harness/doc-drafts/docs/new.md docs/new.md' } },
    { checkpoint: "unprotected-write", tool: "write", input: { path: "result.txt", content: "ordinary file\n" } },
    { checkpoint: "rejectable-draft", tool: "write", input: { path: ".harness/doc-drafts/docs/reject.md", content: "reject content\n" } },
    { checkpoint: "quoted-path-draft", tool: "write", input: { path: ".harness/doc-drafts/docs/space name.md", content: "quoted content\n" } },
    { checkpoint: "collision-draft", tool: "write", input: { path: ".harness/doc-drafts/docs/existing.md", content: "keep draft\n" } },
    { checkpoint: "nested-native-guard", tool: "documents_probe", input: {} },
  ] });
}
