import type { DelegationLaunchInput, DelegationPromptResolver } from "../bridge/delegation.js";
import type { PromptAuthority } from "../domain/contracts.js";
import {
  appendAutoRunGuidance,
  DEFAULT_CONTINUATION_INSTRUCTION,
  DEFAULT_IMPLEMENTATION_INSTRUCTION,
  DEFAULT_REVIEW_CHANGE_INSTRUCTION,
  PromptResolver,
  type ResolvedPrompt,
} from "../claude/prompts.js";

export class GitHubDelegationPromptResolver implements DelegationPromptResolver {
  public constructor(private readonly prompts: PromptResolver) {}

  public async resolve(input: DelegationLaunchInput, options: { readonly authority: PromptAuthority }): Promise<ResolvedPrompt | undefined> {
    if (options.authority !== "auto-run") {
      const instruction = input.prompt;
      if (instruction === undefined || instruction.trim().length === 0) {
        if (options.authority === "delegation") throw new Error("Manual delegation requires an explicit prompt");
        return undefined;
      }
      return this.prompts.resolve({ kind: "free-form", instruction });
    }
    if (input.type === "reviewer") {
      if (input.pullRequest === undefined) {
        return appendAutoRunGuidance(
          await this.prompts.resolve({ kind: "free-form", instruction: input.prompt ?? DEFAULT_REVIEW_CHANGE_INSTRUCTION }),
          input.permanentPrompt,
          input.additionalGuideline,
        );
      }
      if (input.prompt === undefined) {
        throw new Error("A pull-request reviewer requires an explicit prompt");
      }
      return appendAutoRunGuidance(await this.prompts.resolve({
        kind: "review",
        instruction: input.prompt,
        pullRequestNumber: input.pullRequest,
      }), input.permanentPrompt, input.additionalGuideline);
    }
    if (input.type === "Explore") {
      const instruction = input.prompt;
      if (instruction === undefined || instruction.trim().length === 0) {
        throw new Error("Explore requires an explicit prompt");
      }
      if (input.issues === undefined) {
        return appendAutoRunGuidance(
          await this.prompts.resolve({ kind: "free-form", instruction }),
          input.permanentPrompt,
          input.additionalGuideline,
        );
      }
      return appendAutoRunGuidance(
        await this.prompts.resolve({
          kind: "exploration",
          instruction,
          issueNumbers: input.issues,
          ...(input.issueContextDepth === undefined ? {} : { issueContextDepth: input.issueContextDepth }),
        }),
        input.permanentPrompt,
        input.additionalGuideline,
      );
    }
    if (input.type === "implementer" && input.issues !== undefined) {
      return appendAutoRunGuidance(
        await this.prompts.resolve({
          kind: "implementation",
          instruction: input.prompt ?? DEFAULT_IMPLEMENTATION_INSTRUCTION,
          issueNumbers: input.issues,
          ...(input.codebaseContext === undefined ? {} : { codebaseContext: input.codebaseContext }),
          ...(input.issueContextDepth === undefined ? {} : { issueContextDepth: input.issueContextDepth }),
        }),
        input.permanentPrompt,
        input.additionalGuideline,
      );
    }
    return this.prompts.resolve({ kind: "free-form", instruction: input.prompt ?? DEFAULT_CONTINUATION_INSTRUCTION });
  }
}
