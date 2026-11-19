import {
  CommandId,
  isDelegatedAppThread,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import { t3DelegationInstructions } from "@t3tools/provider-core/server/orchestrationInstructions";
import {
  delegationCooldownsAfterRun,
  delegationTargetState,
} from "@t3tools/shared/providerAutoSwitch";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

export class SimpleTaskDelegation extends Context.Service<
  SimpleTaskDelegation,
  {
    /** The delegation guidance for a turn of `thread` on `selection`, or none. */
    readonly instructionsFor: (input: {
      readonly thread: Pick<OrchestrationV2AppThread, "projectId" | "lineage" | "delegatedFrom">;
      readonly selection: ModelSelection;
    }) => Effect.Effect<string | undefined>;
  }
>()("t3/orchestration-v2/SimpleTaskDelegation") {}

export const layer = Layer.effect(
  SimpleTaskDelegation,
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const registry = yield* ProviderRegistry;
    return {
      instructionsFor: Effect.fn("SimpleTaskDelegation.instructionsFor")(
        function* ({ thread, selection }) {
          // Delegates do their own work; the orchestration rules already say so.
          if (isDelegatedAppThread(thread)) return undefined;
          const current = yield* settings.getSettings;
          const state = delegationTargetState(
            current,
            yield* registry.getProviders,
            thread.projectId,
            yield* Clock.currentTimeMillis,
          );
          if (state.status !== "ready") return undefined;
          const { target } = state;
          if (target.instanceId === selection.instanceId && target.model === selection.model) {
            return undefined;
          }
          return t3DelegationInstructions({
            providerInstanceId: target.instanceId,
            model: target.model,
          });
        },
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.simple-task-delegation.read-failed", { cause }).pipe(
            Effect.as(undefined),
          ),
        ),
      ),
    };
  }),
);

/** Sidelines a delegation target whose delegate ran out of quota, and settles that delegate. */
export const cooldownLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const settings = yield* ServerSettings.ServerSettingsService;

    const onRunFailed = Effect.fn("SimpleTaskDelegation.onRunFailed")(function* (run: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
    }) {
      const thread = yield* projections.getThreadShell(run.threadId);
      if (thread === null || thread.latestRunId !== run.runId) return;
      const cooldowns = delegationCooldownsAfterRun(
        yield* settings.getSettings,
        thread,
        yield* Clock.currentTimeMillis,
      );
      if (cooldowns === null) return;
      yield* settings.updateSettings({ delegationCooldowns: cooldowns });
      // The parent does the part itself, so a later limit reset must not resume this delegate.
      yield* threads.dispatch({
        type: "thread.settle",
        commandId: CommandId.make(`delegation-quota-settle:${thread.id}:${run.runId}`),
        threadId: thread.id,
        expectedLatestRunId: run.runId,
      });
      yield* Effect.logInfo("orchestration-v2.simple-task-delegation.cooldown", {
        threadId: thread.id,
        instanceId: thread.modelSelection.instanceId,
      });
    });

    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
        event.type === "run.updated" && event.payload.status === "failed"
          ? onRunFailed({ threadId: event.payload.threadId, runId: event.payload.id }).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("orchestration-v2.simple-task-delegation.cooldown-failed", {
                  threadId: event.payload.threadId,
                  cause,
                }),
              ),
            )
          : Effect.void,
      ),
    );
  }),
);
