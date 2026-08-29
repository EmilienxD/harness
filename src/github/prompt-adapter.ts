import type { DelegationLaunchInput, DelegationPromptResolver } from "../bridge/delegation.js";
import { PromptResolver, type ResolvedPrompt } from "../claude/prompts.js";
import { isInteractiveAgentType } from "../domain/contracts.js";

const PR_DOCTOR_INSTRUCTION =
  "Review this pull request against its issue contract and follow your role's review and approval workflow. Leave any approved changes uncommitted in the working tree. Do not use git or gh to change the working tree, index, branches, remotes, issues, pull requests, reviews, or repository configuration; aboard owns those actions.";

export class GitHubDelegationPromptResolver implements DelegationPromptResolver {
  public constructor(private readonly prompts: PromptResolver) {}

  public async resolve(input: DelegationLaunchInput, options: { readonly interactive: boolean }): Promise<ResolvedPrompt | undefined> {
    if (input.type === "pr-doctor-afk" || input.type === "pr-doctor-hitl") {
      if (input.pullRequest === undefined) {
        return appendAdditionalGuideline(
          await this.prompts.resolve({ kind: "free-form", instruction: input.prompt ?? "Review the supplied change against its contract." }),
          input.additionalGuideline,
        );
      }
      return appendAdditionalGuideline(await this.prompts.resolve({
        kind: "review",
        instruction: input.prompt ?? PR_DOCTOR_INSTRUCTION,
        pullRequestNumber: input.pullRequest,
        ...(input.focus === undefined ? {} : { focus: input.focus }),
      }), input.additionalGuideline);
    }
    if (options.interactive || isInteractiveAgentType(input.type)) {
      const instruction = input.prompt?.trim();
      if (instruction === undefined || instruction.length === 0) return undefined;
      if (input.issues !== undefined && !isInteractiveAgentType(input.type)) {
        return this.prompts.resolve({ kind: "issue-context", instruction, issueNumbers: input.issues });
      }
      return this.prompts.resolve({ kind: "free-form", instruction });
    }
    if (input.type === "implementer" && input.issues !== undefined) {
      return appendAdditionalGuideline(
        await this.prompts.resolve({ kind: "implementation", instruction: input.prompt ?? "Address the issue.", issueNumbers: input.issues }),
        input.additionalGuideline,
      );
    }
    if (input.issues !== undefined) {
      return this.prompts.resolve({ kind: "issue-context", instruction: input.prompt ?? "Address the work described in these issues.", issueNumbers: input.issues });
    }
    return this.prompts.resolve({ kind: "free-form", instruction: input.prompt ?? "Continue with the requested task." });
  }
}

const ADDITIONAL_GUIDELINE_HEADING = "# Additional User Guideline For this Session";

/** Appends user guidance literally last, after every resolved contract section. */
function appendAdditionalGuideline(prompt: ResolvedPrompt | undefined, guideline: string | undefined): ResolvedPrompt | undefined {
  const trimmed = guideline?.trim();
  if (prompt === undefined || trimmed === undefined || trimmed.length === 0) return prompt;
  const section = `${ADDITIONAL_GUIDELINE_HEADING}\n\n${trimmed}`;
  return {
    ...prompt,
    body: prompt.body.length === 0 ? section : `${prompt.body}\n\n${section}`,
    text: `${prompt.text}\n\n${section}`,
  };
}
