import type { DelegationLaunchInput, DelegationPromptResolver } from "../bridge/delegation.js";
import { PromptResolver, type ResolvedPrompt } from "../claude/prompts.js";
import { isInteractiveAgentType } from "../domain/contracts.js";

const PR_DOCTOR_INSTRUCTION =
  "Review this pull request against its issue contract and follow your role's review and approval workflow. Leave any approved changes uncommitted in the working tree. Do not use git or gh to change the working tree, index, branches, remotes, issues, pull requests, reviews, or repository configuration.";

export class GitHubDelegationPromptResolver implements DelegationPromptResolver {
  public constructor(private readonly prompts: PromptResolver) {}

  public async resolve(input: DelegationLaunchInput, options: { readonly interactive: boolean }): Promise<ResolvedPrompt | undefined> {
    if (input.type === "pr-doctor-afk" || input.type === "pr-doctor-hitl") {
      if (input.pullRequest === undefined) {
        return appendAutoRunGuidance(
          await this.prompts.resolve({ kind: "free-form", instruction: input.prompt ?? "Review the supplied change against its contract." }),
          input.permanentPrompt,
          input.additionalGuideline,
        );
      }
      return appendAutoRunGuidance(await this.prompts.resolve({
        kind: "review",
        instruction: input.prompt ?? PR_DOCTOR_INSTRUCTION,
        pullRequestNumber: input.pullRequest,
        ...(input.focus === undefined ? {} : { focus: input.focus }),
      }), input.permanentPrompt, input.additionalGuideline);
    }
    if (options.interactive || isInteractiveAgentType(input.type)) {
      const instruction = input.prompt?.trim();
      if (instruction === undefined || instruction.length === 0) return undefined;
      return this.prompts.resolve({ kind: "free-form", instruction });
    }
    if (input.type === "implementer" && input.issues !== undefined) {
      return appendAutoRunGuidance(
        await this.prompts.resolve({
          kind: "implementation",
          instruction: input.prompt ?? "Address the issue.",
          issueNumbers: input.issues,
          ...(input.recursiveIssueReferences === undefined ? {} : { recursiveIssueReferences: input.recursiveIssueReferences }),
        }),
        input.permanentPrompt,
        input.additionalGuideline,
      );
    }
    return this.prompts.resolve({ kind: "free-form", instruction: input.prompt ?? "Continue with the requested task." });
  }
}

const ADDITIONAL_GUIDELINE_HEADING = "# Additional User Guideline For this Session";
const PERMANENT_PROMPT_HEADING = "# User Guidance";

/** Appends configured guidance first and the per-run guidance literally last. */
function appendAutoRunGuidance(
  prompt: ResolvedPrompt | undefined,
  permanentPrompt: string | undefined,
  additionalGuideline: string | undefined,
): ResolvedPrompt | undefined {
  if (prompt === undefined) return undefined;
  const sections = [
    guidanceSection(PERMANENT_PROMPT_HEADING, permanentPrompt),
    guidanceSection(ADDITIONAL_GUIDELINE_HEADING, additionalGuideline),
  ].filter((section): section is string => section !== undefined);
  if (sections.length === 0) return prompt;
  const appended = sections.join("\n\n");
  return {
    ...prompt,
    body: prompt.body.length === 0 ? appended : `${prompt.body}\n\n${appended}`,
    text: `${prompt.text}\n\n${appended}`,
  };
}

function guidanceSection(heading: string, value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : `${heading}\n\n${trimmed}`;
}
