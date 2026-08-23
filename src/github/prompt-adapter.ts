import type { DelegationLaunchInput, DelegationPromptResolver } from "../bridge/delegation.js";
import { PromptResolver, type ResolvedPrompt } from "../claude/prompts.js";
import { isInteractiveAgentType } from "../domain/contracts.js";

const PR_DOCTOR_INSTRUCTION =
  "Review this pull request against its issue contract. Apply the fixes yourself rather than describing them; aboard commits what you leave in the working tree. Do not commit, push, merge, or post review comments.";

export class GitHubDelegationPromptResolver implements DelegationPromptResolver {
  public constructor(private readonly prompts: PromptResolver) {}

  public async resolve(input: DelegationLaunchInput, options: { readonly interactive: boolean }): Promise<ResolvedPrompt | undefined> {
    // Both pr-doctors take the same launch prompt: the diff, the issue, the
    // parent spec excerpt, the PR number, and the branch. Divergence between
    // them is a bug — they are the same reviewer with different permission to
    // act — so `pr-doctor-hitl` is resolved here rather than falling into the
    // interactive path that would leave it with no diff.
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
    // Any agent handed to the user has one in front of it, so it needs no
    // opening message — whether it is an interactive-only type or a dual-mode
    // builtin launched with `interactive: true`. Substituting filler here would
    // spend a whole turn on "Continue with the requested task." before the user
    // has said anything.
    if (options.interactive || isInteractiveAgentType(input.type)) {
      const instruction = input.prompt?.trim();
      if (instruction === undefined || instruction.length === 0) return undefined;
      // Exception: a dual-mode interactive launch may name an opening topic
      // *against one or more issues*. The bridge resolves each contract into the
      // first prompt once; the user steers from there. Interactive-only types keep
      // the free-form topic — their conversation defines its own scope.
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
      // The resolved issues and their parent specs lead; the Manager's wording
      // scopes the task within them. No `??` fallback — for automated launches
      // the MCP boundary already requires `prompt`, and bare `issues` must fail
      // loudly rather than guess the task.
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
