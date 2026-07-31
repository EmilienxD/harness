import type { DelegationLaunchInput, DelegationPromptResolver } from "../bridge/delegation.js";
import { PromptResolver, type ResolvedPrompt } from "../claude/prompts.js";
import { isInteractiveAgentType } from "../domain/contracts.js";

const PR_DOCTOR_INSTRUCTION =
  "Review this pull request against its issue contract. Apply the fixes yourself rather than describing them; aboard commits what you leave in the working tree. Do not commit, push, merge, or post review comments.";

export class GitHubDelegationPromptResolver implements DelegationPromptResolver {
  public constructor(private readonly prompts: PromptResolver) {}

  public async resolve(input: DelegationLaunchInput): Promise<ResolvedPrompt | undefined> {
    // Both pr-doctors take the same launch prompt: the diff, the issue, the
    // parent spec excerpt, the PR number, and the branch. Divergence between
    // them is a bug — they are the same reviewer with different permission to
    // act — so `pr-doctor-hitl` is resolved here rather than falling into the
    // interactive path that would leave it with no diff.
    if (input.type === "pr-doctor-afk" || input.type === "pr-doctor-hitl") {
      if (input.pullRequest === undefined) {
        return this.prompts.resolve({ kind: "free-form", instruction: input.prompt ?? "Review the supplied change against its contract." });
      }
      return this.prompts.resolve({
        kind: "review",
        instruction: input.prompt ?? PR_DOCTOR_INSTRUCTION,
        pullRequestNumber: input.pullRequest,
        ...(input.focus === undefined ? {} : { focus: input.focus }),
      });
    }
    // Any other interactive agent has a user in front of it, so it needs no
    // opening message. Substituting filler here would spend a whole turn on
    // "Continue with the requested task." before the user has said anything.
    if (isInteractiveAgentType(input.type)) {
      const instruction = input.prompt?.trim();
      return instruction === undefined || instruction.length === 0
        ? undefined
        : await this.prompts.resolve({ kind: "free-form", instruction });
    }
    if (input.type === "implementer" && input.issue !== undefined) {
      return this.prompts.resolve({ kind: "implementation", instruction: input.prompt ?? "Implement the issue.", issueNumber: input.issue });
    }
    return this.prompts.resolve({ kind: "free-form", instruction: input.prompt ?? "Continue with the requested task." });
  }
}
