export const REQUESTED_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type RequestedEffort = (typeof REQUESTED_EFFORTS)[number];

export function isRequestedEffort(value: unknown): value is RequestedEffort {
  return typeof value === "string" && REQUESTED_EFFORTS.includes(value as RequestedEffort);
}

/** Nearest supported effort; ties favor the lower cost level. */
export function nearestEffort<T extends RequestedEffort>(effort: RequestedEffort | undefined, supported: readonly T[]): T | undefined {
  if (effort === undefined || supported.length === 0) return undefined;
  const index = REQUESTED_EFFORTS.indexOf(effort);
  return supported.reduce((best, level) =>
    Math.abs(REQUESTED_EFFORTS.indexOf(level) - index) < Math.abs(REQUESTED_EFFORTS.indexOf(best) - index) ? level : best);
}

export function claudeEffort(model: string | undefined, effort: RequestedEffort | undefined): "low" | "medium" | "high" | "xhigh" | "max" | undefined {
  const levels = ["low", "medium", "high", "xhigh", "max"] as const;
  if (model !== undefined && /opus[-_. ]4[-_. ](?:7|8)(?:[-_. ]|$)/u.test(model)) return nearestEffort(effort, levels);
  if (model !== undefined && /(?:haiku|sonnet|opus)[-_. ](?:3|4)(?:[-_. ]|$)/u.test(model)) {
    if (!/(?:opus|sonnet)[-_. ]4[-_. ]6/u.test(model)) return undefined;
    return nearestEffort(effort, ["low", "medium", "high", "max"]);
  }
  return nearestEffort(effort, levels);
}

// Codex CLI's advertised reasoning levels differ from the HTTP API's model defaults.
export function chatGptEffort(model: string | undefined, effort: RequestedEffort | undefined): RequestedEffort | undefined {
  const current = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
  if (model !== undefined && /^gpt-(?:6\.1-sol|6-(?:astra|sol)|5\.6-(?:sol|terra))(?:-|$)/u.test(model)) return nearestEffort(effort, current);
  if (model !== undefined && /^gpt-(?:6|5\.6)-luna(?:-|$)/u.test(model)) return nearestEffort(effort, current.slice(0, -1));
  return effort;
}
