import {
  CommandId,
  MessageId,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
  type ProviderAutoSwitchSettings,
  type RunId,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  autoSwitchReason,
  nextAutoSwitchTarget,
  projectAutoSwitchSettings,
} from "@t3tools/shared/providerAutoSwitch";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

/**
 * Commands that move a thread along the auto-switch route once `runId` ends. A run that hit its
 * usage limit switches and continues; a run that finished past the threshold switches so the next
 * message goes to the new provider. The ids derive from the run, so a replayed event is a no-op;
 * `attempt` keeps a retry from replaying the receipt of a refused switch.
 */
export function autoSwitchCommands(input: {
  readonly thread: Pick<
    OrchestrationV2ThreadShell,
    | "id"
    | "status"
    | "lastErrorClass"
    | "latestRunId"
    | "archivedAt"
    | "settledOverride"
    | "pendingRuntimeRequest"
    | "lineage"
    | "modelSelection"
  >;
  readonly runId: RunId;
  readonly settings: ProviderAutoSwitchSettings;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly attempt?: number;
}): ReadonlyArray<OrchestrationV2Command> {
  const { thread, runId, settings, providers, attempt = 0 } = input;
  if (
    settings.mode !== "route" ||
    thread.latestRunId !== runId ||
    thread.archivedAt !== null ||
    thread.settledOverride === "settled" ||
    thread.pendingRuntimeRequest !== null ||
    thread.lineage.relationshipToParent === "subagent"
  )
    return [];
  const reason = autoSwitchReason({
    settings,
    providers,
    selection: thread.modelSelection,
    runStatus: thread.status,
    lastErrorClass: thread.lastErrorClass,
  });
  if (reason === null) return [];
  const target = nextAutoSwitchTarget(settings, providers, thread.modelSelection);
  if (target === null) return [];
  const identity = `${thread.id}:${runId}`;
  const commands: Array<OrchestrationV2Command> = [
    {
      type: "provider.switch",
      commandId: CommandId.make(
        attempt === 0 ? `auto-switch:${identity}` : `auto-switch:${identity}:retry:${attempt}`,
      ),
      threadId: thread.id,
      modelSelection: target,
    },
  ];
  if (reason === "exhausted") {
    commands.push({
      type: "message.dispatch",
      commandId: CommandId.make(`auto-switch-resume:${identity}`),
      messageId: MessageId.make(`auto-switch-resume:${identity}`),
      threadId: thread.id,
      text: "Continue where you left off.",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "agent",
      creationSource: "server",
    });
  }
  return commands;
}

// Events that can mean a session's background work ended, so a refused switch may now go through.
const BACKGROUND_WORK_EVENTS: ReadonlySet<OrchestrationV2DomainEvent["type"]> = new Set([
  "provider-session.detached",
  "provider-session.updated",
  "provider-turn.updated",
  "run.background-work-cancelled",
  "subagent.updated",
  "node.updated",
]);

export interface BlockedAutoSwitch {
  readonly runId: RunId;
  readonly attempt: number;
}

/** The switch attempt `event` calls for: a run that just ended, or a retry of a refused switch. */
export function autoSwitchAttemptFor(
  event: OrchestrationV2DomainEvent,
  blocked: ReadonlyMap<OrchestrationV2ThreadShell["id"], BlockedAutoSwitch>,
): (BlockedAutoSwitch & { readonly threadId: OrchestrationV2ThreadShell["id"] }) | null {
  if (
    event.type === "run.updated" &&
    (event.payload.status === "completed" || event.payload.status === "failed")
  ) {
    return { threadId: event.payload.threadId, runId: event.payload.id, attempt: 0 };
  }
  const waiting = blocked.get(event.threadId);
  return waiting !== undefined && BACKGROUND_WORK_EVENTS.has(event.type)
    ? { threadId: event.threadId, runId: waiting.runId, attempt: waiting.attempt + 1 }
    : null;
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const settings = yield* ServerSettings.ServerSettingsService;
    const registry = yield* ProviderRegistry;

    // Threads whose switch the orchestrator refused, usually because background work would end.
    // Their next session or background-work change retries it.
    const blocked = new Map<OrchestrationV2ThreadShell["id"], BlockedAutoSwitch>();

    const trySwitch = Effect.fn("ProviderAutoSwitchWorker.trySwitch")(function* (
      threadId: OrchestrationV2ThreadShell["id"],
      runId: RunId,
      attempt: number,
    ) {
      const current = yield* settings.getSettings;
      const thread = yield* projections.getThreadShell(threadId);
      const commands =
        thread === null
          ? []
          : autoSwitchCommands({
              thread,
              runId,
              settings: projectAutoSwitchSettings(current, thread.projectId),
              providers: yield* registry.getProviders,
              attempt,
            });
      const [switchCommand, ...rest] = commands;
      if (thread === null || switchCommand === undefined) {
        blocked.delete(threadId);
        return;
      }
      const switched = yield* threads.dispatch(switchCommand).pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          Effect.logInfo("orchestration-v2.provider-auto-switch.blocked", { threadId, cause }).pipe(
            Effect.as(false),
          ),
        ),
      );
      if (!switched) {
        blocked.set(threadId, { runId, attempt });
        return;
      }
      blocked.delete(threadId);
      for (const command of rest) yield* threads.dispatch(command);
      yield* Effect.logInfo("orchestration-v2.provider-auto-switch.switched", {
        threadId,
        from: thread.modelSelection.instanceId,
        to:
          switchCommand.type === "provider.switch" ? switchCommand.modelSelection.instanceId : null,
      });
    });

    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
        Effect.suspend(() => {
          const next = autoSwitchAttemptFor(event, blocked);
          return next === null ? Effect.void : trySwitch(next.threadId, next.runId, next.attempt);
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("orchestration-v2.provider-auto-switch.failed", {
              threadId: event.threadId,
              cause,
            }),
          ),
        ),
      ),
    );
  }),
);
