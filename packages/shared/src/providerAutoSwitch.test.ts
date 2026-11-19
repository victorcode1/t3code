import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProjectId,
  ProviderInstanceId,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  autoSwitchThresholdReached,
  DELEGATION_COOLDOWN_MS,
  delegationCooldownsAfterRun,
  delegationTargetState,
  isQuotaFailure,
  nextAutoSwitchTarget,
  projectAutoSwitchSettings,
} from "./providerAutoSwitch.ts";

const selection = (instanceId: string): ModelSelection => ({
  instanceId: ProviderInstanceId.make(instanceId),
  model: "model",
});

const provider = (
  instanceId: string,
  usage: { readonly session?: number; readonly weekly?: number } = {},
  overrides: Partial<ServerProvider> = {},
): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-18T00:00:00.000Z",
  models: [{ slug: "model", name: "Model", isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
  usageLimits: {
    checkedAt: "2026-11-18T00:00:00.000Z",
    windows: (["session", "weekly"] as const).flatMap((kind) =>
      usage[kind] === undefined ? [] : [{ id: kind, kind, label: kind, usedPercent: usage[kind] }],
    ),
  },
  ...overrides,
});

const route = (...ids: ReadonlyArray<string>) => ({
  ...DEFAULT_SERVER_SETTINGS.providerAutoSwitch,
  mode: "route" as const,
  route: ids.map(selection),
});

describe("nextAutoSwitchTarget", () => {
  it("continues after the current provider and wraps around the route", () => {
    const providers = [provider("a"), provider("b"), provider("c")];
    expect(nextAutoSwitchTarget(route("a", "b", "c"), providers, selection("b"))).toEqual(
      selection("c"),
    );
    expect(nextAutoSwitchTarget(route("a", "b", "c"), providers, selection("c"))).toEqual(
      selection("a"),
    );
    expect(nextAutoSwitchTarget(route("a", "b"), providers, selection("z"))).toEqual(
      selection("a"),
    );
  });

  it("skips exhausted, disabled, and missing providers, and never returns the current one", () => {
    const providers = [
      provider("a"),
      provider("b", { weekly: 100 }),
      provider("c", {}, { enabled: false }),
      provider("e"),
    ];
    expect(nextAutoSwitchTarget(route("a", "b", "c", "d", "e"), providers, selection("a"))).toEqual(
      selection("e"),
    );
    expect(nextAutoSwitchTarget(route("a", "b", "c"), providers, selection("a"))).toBeNull();
  });

  it("skips targets already past the threshold so the route does not bounce", () => {
    const settings = { ...route("a", "b", "c"), trigger: "session" as const, thresholdPercent: 80 };
    const providers = [
      provider("a", { session: 85 }),
      provider("b", { session: 90 }),
      provider("c"),
    ];
    expect(autoSwitchThresholdReached(settings, providers, selection("a"))).toBe(true);
    expect(nextAutoSwitchTarget(settings, providers, selection("a"))).toEqual(selection("c"));
  });
});

describe("autoSwitchThresholdReached", () => {
  it("watches only the configured window and ignores providers that report no usage", () => {
    const weekly = { ...route("a"), trigger: "weekly" as const, thresholdPercent: 50 };
    expect(
      autoSwitchThresholdReached(weekly, [provider("a", { session: 99 })], selection("a")),
    ).toBe(false);
    expect(
      autoSwitchThresholdReached(weekly, [provider("a", { weekly: 50 })], selection("a")),
    ).toBe(true);
    expect(
      autoSwitchThresholdReached(route("a"), [provider("a", { weekly: 100 })], selection("a")),
    ).toBe(false);
  });
});

describe("projectAutoSwitchSettings", () => {
  const personal = ProjectId.make("personal");
  const work = ProjectId.make("work");
  const disabled = { enabled: false };
  const accounts = ["mine-1", "mine-2", "company-1", "company-2"];
  const settings = {
    ...DEFAULT_SERVER_SETTINGS,
    providerInstances: Object.fromEntries(
      accounts.map((id) => [id, { driver: ProviderDriverKind.make("codex") }]),
    ),
    providerAutoSwitch: route(...accounts),
    projectSettingsOverrides: {
      [personal]: { providerInstances: { "company-1": disabled, "company-2": disabled } },
      [work]: { providerAutoSwitch: route("company-2", "company-1", "mine-1") },
    },
  };
  const steps = (projectId: ProjectId | null) =>
    projectAutoSwitchSettings(settings, projectId).route.map((step) => step.instanceId);

  it("drops route steps on providers the project disables", () => {
    expect(steps(personal)).toEqual(["mine-1", "mine-2"]);
    expect(
      nextAutoSwitchTarget(
        projectAutoSwitchSettings(settings, personal),
        accounts.map((id) => provider(id)),
        selection("mine-2"),
      ),
    ).toEqual(selection("mine-1"));
  });

  it("follows the project's own route and keeps the global one elsewhere", () => {
    expect(steps(work)).toEqual(["company-2", "company-1", "mine-1"]);
    expect(steps(null)).toEqual(accounts);
  });
});

describe("simple task delegation", () => {
  const now = Date.parse("2026-11-19T12:00:00.000Z");
  const deepseek = { instanceId: ProviderInstanceId.make("opencode"), model: "deepseek/v4" };
  const settings = {
    ...DEFAULT_SERVER_SETTINGS,
    providerInstances: { opencode: { driver: ProviderDriverKind.make("opencode"), enabled: true } },
    simpleTaskDelegation: { enabled: true, target: deepseek },
  };
  const failedDelegate = (
    failure: {
      lastErrorClass?: "usage_limit" | "provider_error";
      lastErrorCode?: string;
      lastError?: string;
    },
    relationshipToParent: "subagent" | null = "subagent",
  ) =>
    ({
      status: "failed" as const,
      lastErrorClass: failure.lastErrorClass ?? "provider_error",
      lastErrorCode: failure.lastErrorCode ?? null,
      lastError: failure.lastError ?? null,
      modelSelection: deepseek,
      lineage: { relationshipToParent, parentThreadId: null },
    }) as unknown as Parameters<typeof delegationCooldownsAfterRun>[1];

  it("treats usage limits and balance errors as quota failures", () => {
    expect(isQuotaFailure({ lastErrorClass: "usage_limit" })).toBe(true);
    expect(isQuotaFailure({ lastErrorCode: "provider.quota" })).toBe(true);
    expect(isQuotaFailure({ lastError: "402 Insufficient Balance" })).toBe(true);
    expect(isQuotaFailure({ lastError: "You exceeded your current quota" })).toBe(true);
    expect(isQuotaFailure({ lastErrorClass: "provider_error", lastError: "socket hang up" })).toBe(
      false,
    );
  });

  it("cools a target down for an hour after its delegate runs out of balance", () => {
    const cooldowns = delegationCooldownsAfterRun(
      settings,
      failedDelegate({ lastError: "Insufficient Balance" }),
      now,
    );
    expect(cooldowns).toEqual({ opencode: "2026-11-19T13:00:00.000Z" });
    const cooled = { ...settings, delegationCooldowns: cooldowns ?? {} };
    expect(delegationTargetState(cooled, [provider("opencode")], null, now + 1).status).toBe(
      "cooling",
    );
    expect(
      delegationTargetState(cooled, [provider("opencode")], null, now + DELEGATION_COOLDOWN_MS)
        .status,
    ).toBe("ready");
  });

  it("leaves cooldowns alone for other failures and for top-level threads", () => {
    expect(
      delegationCooldownsAfterRun(settings, failedDelegate({ lastError: "socket hang up" }), now),
    ).toBeNull();
    expect(
      delegationCooldownsAfterRun(
        settings,
        failedDelegate({ lastError: "Insufficient Balance" }, null),
        now,
      ),
    ).toBeNull();
  });

  it("skips a target that reports its usage as spent", () => {
    expect(
      delegationTargetState(settings, [provider("opencode", { session: 100 })], null, now),
    ).toEqual({ status: "unavailable", target: deepseek });
  });
});
