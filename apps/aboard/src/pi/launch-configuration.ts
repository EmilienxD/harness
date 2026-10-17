import type { AgentType } from "../domain/contracts.js";
import type { ConfiguredLaunch } from "../platform/agent-platform.js";
import { DELEGATION_TASKS, LaunchFileError, type DelegationTask, type PlatformLaunchFile } from "../platform/launch-configuration.js";
import { PI_EFFORTS, type PiLaunchConfiguration } from "./launch.js";

type Profile = Pick<PiLaunchConfiguration, "declaredCommand" | "declaredModel" | "declaredEffort">;
function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new LaunchFileError(`${path} must be an object`);
  return value as Record<string, unknown>;
}
function command(value: unknown, path: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || !value.every((v) => typeof v === "string" && v.trim().length > 0 && !/[\r\n\0]/u.test(v))) throw new LaunchFileError(`${path} must contain non-empty command tokens`);
  return value;
}
export function parsePiLaunchFile(root: Record<string, unknown>): { readonly value: PlatformLaunchFile; readonly unknownFields: readonly string[] } {
  const unknownFields = Object.keys(root).filter((k) => !["command", "interactive", "delegations", "autoRun"].includes(k));
  const baseCommand = command(root.command, "providers.pi.command") ?? ["pi"];
  const parse = (value: unknown, path: string, explore = false): Profile => {
    const input = value === undefined ? {} : object(value, path);
    unknownFields.push(...Object.keys(input).filter((k) => !["command", "model", "effort"].includes(k)).map((k) => `${path}.${k}`));
    const model = input.model === "inherit" ? undefined : input.model;
    const requestedEffort = input.effort === "inherit" ? undefined : input.effort ?? (explore ? "low" : undefined);
    const effort = requestedEffort === "none" ? "off" : requestedEffort === "ultra" ? "max" : requestedEffort;
    if (model !== undefined && (typeof model !== "string" || model.trim().length === 0 || model.startsWith("-") || /[\r\n\0]/u.test(model))) throw new LaunchFileError(`${path}.model must be inherit or a Pi model ID`);
    if (effort !== undefined && !PI_EFFORTS.includes(effort as never)) throw new LaunchFileError(`${path}.effort must be inherit or ${PI_EFFORTS.join(", ")}`);
    return { declaredCommand: command(input.command, `${path}.command`) ?? baseCommand, ...(model === undefined ? {} : { declaredModel: model as string }), ...(effort === undefined ? {} : { declaredEffort: effort as NonNullable<Profile["declaredEffort"]> }) };
  };
  const interactive = parse(root.interactive, "interactive");
  const delegationsInput = root.delegations === undefined ? {} : object(root.delegations, "providers.pi.delegations");
  const autoInput = root.autoRun === undefined ? {} : object(root.autoRun, "providers.pi.autoRun");
  unknownFields.push(...Object.keys(delegationsInput).filter((k) => !DELEGATION_TASKS.includes(k as DelegationTask)).map((k) => `delegations.${k}`), ...Object.keys(autoInput).filter((k) => !["explore", "address", "review"].includes(k)).map((k) => `autoRun.${k}`));
  const delegations = new Map(DELEGATION_TASKS.map((task) => [task, parse(delegationsInput[task], `delegations.${task}`, task === "explore")]));
  const autoRun = new Map(["explore", "address", "review"].map((task) => [task, parse(autoInput[task], `autoRun.${task}`, task === "explore")]));
  const configured = (selected: Profile, type: string, worker = false): ConfiguredLaunch => ({ platform: "pi", settings: { ...selected, shape: type === "explore" ? "explore" : worker ? "skill" : "default", ...(worker ? { skillName: `${type}-this` } : {}) } satisfies PiLaunchConfiguration });
  return { unknownFields, value: {
    platform: "pi",
    configuration: (type: AgentType) => type === "interactive" ? configured(interactive, type) : autoRun.has(type) ? configured(autoRun.get(type)!, type, type !== "explore") : configured(delegations.get(type as DelegationTask)!, type),
    delegationConfiguration: (task: DelegationTask) => configured(delegations.get(task)!, task),
  } };
}
