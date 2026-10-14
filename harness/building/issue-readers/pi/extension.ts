import { registerIssueWorkflow } from "../../hooks/pi-support/workflows.ts";

export default function (pi: any): void {
  registerIssueWorkflow(pi, "issue-readers", ["address-this", "review-this"]);
}
