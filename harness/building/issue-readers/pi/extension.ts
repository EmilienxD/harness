import { registerIssueWorkflow } from "../../harness/pi-issue-workflows/workflows.ts";

export default function (pi: any): void {
  registerIssueWorkflow(pi, "issue-readers", ["address-this", "review-this"]);
}
