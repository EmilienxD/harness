import { registerIssueWorkflow } from "../../hooks/pi-issue-workflows/workflows.ts";

export default function (pi: any): void {
  registerIssueWorkflow(pi, "issue-writers", ["draft-issue", "draft-issues", "to-spec", "to-spec-draft-issue"], true);
}
