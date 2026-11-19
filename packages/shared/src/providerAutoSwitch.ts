import {
  isDelegatedAppThread,
  isProviderAvailable,
  type ModelSelection,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  type ProviderAutoSwitchSettings,
  type ProviderInstanceId,
  type ProviderAutoSwitchTrigger,
  resolveProjectProviderInstanceEnabled,
  type ServerProvider,
  type ServerProviderUsageWindow,
  type ServerSettings,
} from "@t3tools/contracts";

import * as DateTime from "effect/DateTime";

import { resolveProjectSettings } from "./projectSettings.ts";

const windowApplies = (window: ServerProviderUsageWindow, model: string) =>
  window.modelIds === undefined || window.modelIds.includes(model);

/**
 * The auto-switch settings a thread in `projectId` follows: the project's own override when it has
 * one, minus route steps on providers the project disables, so a switch never leaves its allow-list.
 */
export function projectAutoSwitchSettings(
  settings: ServerSettings,
  projectId: ProjectId | null,
): ProviderAutoSwitchSettings {
  const autoSwitch = resolveProjectSettings(settings, projectId).settings.providerAutoSwitch;
  return {
    ...autoSwitch,
    route: autoSwitch.route.filter((step) =>
      resolveProjectProviderInstanceEnabled(settings, projectId, step.instanceId),
    ),
  };
}

/** Highest reported use, in percent, of the windows of `kind` that apply to `model`. */
export function usedPercent(
  provider: ServerProvider | undefined,
  model: string,
  kind?: Exclude<ProviderAutoSwitchTrigger, "exhausted">,
): number | null {
  const windows = (provider?.usageLimits?.windows ?? []).filter(
    (window) => (kind === undefined || window.kind === kind) && windowApplies(window, model),
  );
  return windows.length === 0 ? null : Math.max(...windows.map((window) => window.usedPercent));
}

/** Whether the selection's watched window has reached the threshold. `exhausted` only reacts to failures. */
export function autoSwitchThresholdReached(
  settings: ProviderAutoSwitchSettings,
  providers: ReadonlyArray<ServerProvider>,
  selection: ModelSelection,
): boolean {
  if (settings.trigger === "exhausted") return false;
  const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
  const used = usedPercent(provider, selection.model, settings.trigger);
  return used !== null && used >= settings.thresholdPercent;
}

/** A target is usable when it is enabled, reachable, and below the limit that would switch it away again. */
export function isAutoSwitchTargetUsable(
  settings: ProviderAutoSwitchSettings,
  providers: ReadonlyArray<ServerProvider>,
  selection: ModelSelection,
): boolean {
  const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
  if (
    provider === undefined ||
    !provider.enabled ||
    !isProviderAvailable(provider) ||
    provider.status === "error" ||
    provider.status === "disabled" ||
    !provider.models.some((model) => model.slug === selection.model)
  )
    return false;
  const used = usedPercent(provider, selection.model);
  if (used !== null && used >= 100) return false;
  return !autoSwitchThresholdReached(settings, providers, selection);
}

/**
 * The route entry to switch to: the first usable one after the current provider's place in the
 * route, wrapping around. Entries on the current provider are skipped, so a route never loops.
 */
export function nextAutoSwitchTarget(
  settings: ProviderAutoSwitchSettings,
  providers: ReadonlyArray<ServerProvider>,
  current: ModelSelection,
): ModelSelection | null {
  const route = settings.route;
  const position = route.findLastIndex((entry) => entry.instanceId === current.instanceId);
  for (let offset = 1; offset <= route.length; offset++) {
    const entry = route[(position + offset + route.length) % route.length];
    if (entry === undefined || entry.instanceId === current.instanceId) continue;
    if (isAutoSwitchTargetUsable(settings, providers, entry)) return entry;
  }
  return null;
}

/** Why a run that just ended should move its thread, or null when it should stay. */
export function autoSwitchReason(input: {
  readonly settings: ProviderAutoSwitchSettings;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly selection: ModelSelection;
  readonly runStatus: string;
  readonly lastErrorClass: string | null | undefined;
}): "exhausted" | "threshold" | null {
  if (input.runStatus === "failed" && input.lastErrorClass === "usage_limit") return "exhausted";
  // Thread shells report a finished run as idle.
  return (input.runStatus === "completed" || input.runStatus === "idle") &&
    autoSwitchThresholdReached(input.settings, input.providers, input.selection)
    ? "threshold"
    : null;
}

export const DELEGATION_COOLDOWN_MS = 60 * 60 * 1000;

// Balance errors such as DeepSeek's HTTP 402 arrive as provider errors, not usage limits.
const QUOTA_FAILURE_MESSAGE =
  /insufficient[\s_-]*(balance|quota|credits?|funds)|quota exceeded|exceeded your current quota|credit balance is too low|payment required|out of credits/i;

/** Whether a run failed because its provider ran out of usage, quota, or balance. */
export function isQuotaFailure(
  thread: Pick<OrchestrationV2ThreadShell, "lastErrorClass" | "lastErrorCode" | "lastError">,
): boolean {
  return (
    thread.lastErrorClass === "usage_limit" ||
    /quota|billing|insufficient/i.test(thread.lastErrorCode ?? "") ||
    QUOTA_FAILURE_MESSAGE.test(thread.lastError ?? "")
  );
}

export type DelegationTargetState =
  | { readonly status: "off" }
  | { readonly status: "ready"; readonly target: ModelSelection }
  | { readonly status: "cooling"; readonly target: ModelSelection; readonly until: string }
  | { readonly status: "unavailable"; readonly target: ModelSelection };

/** Whether threads in `projectId` should hand mechanical subtasks to the delegation target now. */
export function delegationTargetState(
  settings: ServerSettings,
  providers: ReadonlyArray<ServerProvider>,
  projectId: ProjectId | null,
  nowMs: number,
): DelegationTargetState {
  const { enabled, target } = resolveProjectSettings(settings, projectId).settings
    .simpleTaskDelegation;
  if (!enabled || target === null) return { status: "off" };
  const until = settings.delegationCooldowns[target.instanceId];
  if (until !== undefined && Date.parse(until) > nowMs) return { status: "cooling", target, until };
  const provider = providers.find((candidate) => candidate.instanceId === target.instanceId);
  const usable =
    resolveProjectProviderInstanceEnabled(settings, projectId, target.instanceId) &&
    provider !== undefined &&
    provider.enabled &&
    isProviderAvailable(provider) &&
    provider.status !== "error" &&
    provider.status !== "disabled" &&
    (usedPercent(provider, target.model) ?? 0) < 100;
  return usable ? { status: "ready", target } : { status: "unavailable", target };
}

/**
 * The cooldowns to store after a delegated thread's run ends, or null to keep them. A delegate that
 * ran out of quota on a delegation target sidelines that target for an hour.
 */
export function delegationCooldownsAfterRun(
  settings: ServerSettings,
  thread: Pick<
    OrchestrationV2ThreadShell,
    | "status"
    | "lastErrorClass"
    | "lastErrorCode"
    | "lastError"
    | "modelSelection"
    | "lineage"
    | "delegatedFrom"
  >,
  nowMs: number,
): Readonly<Record<ProviderInstanceId, string>> | null {
  if (thread.status !== "failed" || !isDelegatedAppThread(thread) || !isQuotaFailure(thread)) {
    return null;
  }
  const { instanceId } = thread.modelSelection;
  const configured = [
    settings.simpleTaskDelegation,
    ...Object.values(settings.projectSettingsOverrides).map((entry) => entry.simpleTaskDelegation),
  ].some((delegation) => delegation?.target?.instanceId === instanceId);
  if (!configured) return null;
  const active = Object.entries(settings.delegationCooldowns).filter(
    ([, until]) => Date.parse(until) > nowMs,
  );
  return {
    ...Object.fromEntries(active),
    [instanceId]: DateTime.formatIso(DateTime.makeUnsafe(nowMs + DELEGATION_COOLDOWN_MS)),
  };
}
