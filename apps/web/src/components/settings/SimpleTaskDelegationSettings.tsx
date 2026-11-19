import type {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ServerProvider,
  SimpleTaskDelegationSettings as DelegationSettings,
} from "@t3tools/contracts";
import { pickModelSelection } from "@t3tools/shared/model";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { T, useGT } from "gt-react";
import { useState } from "react";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  getDefaultProviderInstanceModel,
  providerInstanceEntriesFor,
} from "../../providerInstances";
import { formatShortTimestamp } from "../../timestampFormat";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { useSearchableSetting } from "./settingsSearch";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME, SettingsRow, SettingsSection } from "./settingsLayout";

/**
 * Lets the thread's agent hand mechanical subtasks to a cheaper model. With `projectIds`, edits
 * those projects' override; the target only offers providers they keep on.
 */
export function SimpleTaskDelegationSettings({
  environmentId,
  providers,
  projectIds,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly projectIds: readonly ProjectId[];
  readonly readOnly: boolean;
}) {
  const setting = useSearchableSetting();
  const gt = useGT();
  const settings = useEnvironmentSettings(environmentId);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const [openedAt] = useState(() => Date.now());
  const projectId = projectIds[0] ?? null;
  const delegation = resolveProjectSettings(settings, projectId).settings.simpleTaskDelegation;
  const entries = providerInstanceEntriesFor(providers, settings, projectId).filter(
    (entry) => entry.enabled && entry.models.length > 0,
  );
  const update = (patch: Partial<DelegationSettings>) => {
    const next = { ...delegation, ...patch };
    if (projectIds.length === 0) return updateSettings({ simpleTaskDelegation: next });
    updateSettings({
      projectSettingsOverrides: Object.fromEntries(
        projectIds.map((id) => [
          id,
          { ...settings.projectSettingsOverrides[id], simpleTaskDelegation: next },
        ]),
      ),
    });
  };
  // OpenCode on its default model is the cheap target most setups have.
  const defaultTarget = (): ModelSelection | null => {
    const entry = entries.find((candidate) => candidate.driverKind === "opencode") ?? entries[0];
    const model =
      entry === undefined
        ? undefined
        : getDefaultProviderInstanceModel(providers, entry.instanceId);
    return entry === undefined || model === undefined
      ? null
      : { instanceId: entry.instanceId, model };
  };
  const target = delegation.target;
  const cooldownUntil =
    target === null ? undefined : settings.delegationCooldowns[target.instanceId];
  const cooling = cooldownUntil !== undefined && Date.parse(cooldownUntil) > openedAt;
  const clearCooldown = () => {
    if (target === null) return;
    updateSettings({
      delegationCooldowns: Object.fromEntries(
        Object.entries(settings.delegationCooldowns).filter(
          ([instanceId]) => instanceId !== target.instanceId,
        ),
      ),
    });
  };

  return (
    <SettingsSection {...setting("simple-task-delegation")}>
      <SettingsRow
        serverScoped
        settingKeys={["simpleTaskDelegation"]}
        title={gt("Delegate simple tasks")}
        description={gt(
          "Claude and Codex agents hand mechanical work, such as renames, formatting and log summaries, to a cheaper model as delegated tasks.",
        )}
        control={
          <Switch
            checked={delegation.enabled}
            disabled={readOnly}
            aria-label={gt("Delegate simple tasks")}
            onCheckedChange={(checked) =>
              update(
                checked && delegation.target === null
                  ? { enabled: true, target: defaultTarget() }
                  : { enabled: Boolean(checked) },
              )
            }
          />
        }
      />
      {delegation.enabled ? (
        <SettingsRow
          title={gt("Delegate to")}
          description={gt(
            "When it runs out of quota or balance, the agent does that part itself and stops delegating to it for an hour.",
          )}
          status={
            cooling ? (
              <span className="flex items-center gap-1.5">
                {gt("Out of quota until {time}", {
                  time: formatShortTimestamp(cooldownUntil, settings.timestampFormat),
                })}
                {readOnly ? null : (
                  <Button size="xs" variant="outline" onClick={clearCooldown}>
                    <T>Retry now</T>
                  </Button>
                )}
              </span>
            ) : null
          }
          control={
            target === null ? (
              <span className="text-xs text-muted-foreground">
                <T>No provider is available.</T>
              </span>
            ) : (
              <ProviderModelPicker
                environmentId={environmentId}
                activeInstanceId={target.instanceId}
                model={target.model}
                lockedProvider={null}
                instanceEntries={entries}
                modelOptionsByInstance={getCustomModelOptionsByInstance(
                  settings,
                  providers,
                  target.instanceId,
                  target.model,
                )}
                disabled={readOnly}
                triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                triggerAriaLabel={gt("Delegation target")}
                onInstanceModelChange={(instanceId, model) =>
                  update({ target: pickModelSelection(target, instanceId, model) })
                }
              />
            )
          }
        />
      ) : null}
    </SettingsSection>
  );
}
