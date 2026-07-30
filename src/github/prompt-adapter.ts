import type { DelegationLaunchInput, DelegationPromptResolver } from "../bridge/delegation.js";
import { PromptResolver, type ResolvedPrompt } from "../claude/prompts.js";

export class GitHubDelegationPromptResolver implements DelegationPromptResolver {
  public constructor(private readonly prompts: PromptResolver) {}

  public resolve(input: DelegationLaunchInput): Promise<ResolvedPrompt | undefined> {
    if (input.type === "reviewer") {
      if (input.pullRequest === undefined) return this.prompts.resolve({ kind: "free-form", instruction: input.prompt ?? "Review the supplied change." });
      return this.prompts.resolve({ kind: "review", instruction: input.prompt ?? "Review the pull request.", pullRequestNumber: input.pullRequest, ...(input.focus === undefined ? {} : { focus: input.focus }) });
    }
    if (input.type === "fixer" && input.pullRequest !== undefined) {
      return this.prompts.resolve({ kind: "fix", instruction: input.prompt ?? "Address the unresolved review feedback.", pullRequestNumber: input.pullRequest });
    }
    if (input.type === "implementer" && input.issue !== undefined) {
      return this.prompts.resolve({ kind: "implementation", instruction: input.prompt ?? "Implement the issue.", issueNumber: input.issue });
    }
    return this.prompts.resolve({ kind: "free-form", instruction: input.prompt ?? "Continue with the requested task." });
  }
}
