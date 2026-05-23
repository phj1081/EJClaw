import { type ModelConfigSnapshot, type ModelRoleConfig } from './api';
import { type Messages } from './i18n';
import {
  type AgentType,
  type EffortValue,
  effortValuesForAgent,
  formatEffortOption,
  isEffortSupported,
  isPresetModel,
  PRESET_MODELS,
} from './settings-options';

const MODEL_ROLES = ['owner', 'reviewer', 'arbiter'] as const;

export type ModelRole = (typeof MODEL_ROLES)[number];

function modelRoleLabel(role: ModelRole, t: Messages): string {
  if (role === 'owner') return t.settings.models.roleOwner;
  if (role === 'reviewer') return t.settings.models.roleReviewer;
  return t.settings.models.roleArbiter;
}

function modelRoleHint(role: ModelRole, t: Messages): string {
  if (role === 'owner') return t.settings.models.roleOwnerHint;
  if (role === 'reviewer') return t.settings.models.roleReviewerHint;
  return t.settings.models.roleArbiterHint;
}

function agentTypeLabel(agentType: AgentType, t: Messages): string {
  return agentType === 'codex'
    ? t.settings.models.agentTypeCodex
    : t.settings.models.agentTypeClaude;
}

function effortLabel(value: EffortValue, t: Messages): string {
  if (value === '') return t.settings.models.effortDefault;
  const key = value as keyof typeof t.settings.models.effortOptions;
  const localized = t.settings.models.effortOptions[key] ?? value;
  return formatEffortOption(value, localized);
}

function modelGroupLabel(model: string, t: Messages): string {
  if ((PRESET_MODELS.codex as readonly string[]).includes(model)) {
    return t.settings.models.groupCodex;
  }
  if ((PRESET_MODELS.claude as readonly string[]).includes(model)) {
    return t.settings.models.groupClaude;
  }
  return t.settings.models.groupCustom;
}

function effortOptionsForRole(
  draft: ModelConfigSnapshot,
  role: ModelRole,
): readonly EffortValue[] {
  const agentType = draft.agentTypes?.[role];
  if (agentType) return effortValuesForAgent(agentType);
  return effortValuesForAgent('codex');
}

export function hasUnsupportedModelEffort(draft: ModelConfigSnapshot): boolean {
  for (const role of MODEL_ROLES) {
    const agentType = draft.agentTypes?.[role];
    if (!agentType) continue;
    if (!isEffortSupported(agentType, draft[role].effort)) return true;
  }
  return false;
}

export function ModelRoleFields({
  draft,
  onChange,
  t,
}: {
  draft: ModelConfigSnapshot;
  onChange: (role: ModelRole, patch: Partial<ModelRoleConfig>) => void;
  t: Messages;
}) {
  return (
    <div className="settings-model-stack">
      {MODEL_ROLES.map((role) => {
        const roleConfig = draft[role];
        const agentType = draft.agentTypes?.[role] ?? null;
        const effortOptions = effortOptionsForRole(draft, role);
        const effortInvalid =
          agentType !== null &&
          roleConfig.effort !== '' &&
          !isEffortSupported(agentType, roleConfig.effort);
        const usingCustom =
          roleConfig.model.trim() !== '' && !isPresetModel(roleConfig.model);

        return (
          <article className="settings-model-card" key={role}>
            <header className="settings-model-card-head">
              <span className="settings-kicker">{role}</span>
              <strong>{modelRoleLabel(role, t)}</strong>
              <p className="settings-hint">{modelRoleHint(role, t)}</p>
              {agentType ? (
                <p className="settings-inline-meta">
                  {t.settings.models.agentTypeLabel}:{' '}
                  {agentTypeLabel(agentType, t)}
                </p>
              ) : null}
            </header>

            <div className="settings-model-fields">
              <label className="settings-row">
                <span className="settings-label">
                  {t.settings.models.modelLabel}
                </span>
                <select
                  aria-label={`${modelRoleLabel(role, t)} ${t.settings.models.modelLabel}`}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (value === '__custom__') {
                      onChange(role, {
                        model: usingCustom ? roleConfig.model : '',
                      });
                      return;
                    }
                    onChange(role, { model: value });
                  }}
                  value={usingCustom ? '__custom__' : roleConfig.model}
                >
                  <option value="">{t.settings.models.modelDefault}</option>
                  <optgroup label={t.settings.models.groupCodex}>
                    {PRESET_MODELS.codex.map((model) => (
                      <option key={model} value={model}>
                        {model}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label={t.settings.models.groupClaude}>
                    {PRESET_MODELS.claude.map((model) => (
                      <option key={model} value={model}>
                        {model}
                      </option>
                    ))}
                  </optgroup>
                  <option value="__custom__">
                    {t.settings.models.modelCustom}
                  </option>
                </select>
              </label>

              {usingCustom ? (
                <label className="settings-row">
                  <span className="settings-label">
                    {t.settings.models.modelCustomLabel}
                  </span>
                  <input
                    onChange={(event) =>
                      onChange(role, { model: event.target.value })
                    }
                    placeholder={t.settings.models.modelPlaceholder}
                    type="text"
                    value={roleConfig.model}
                  />
                </label>
              ) : null}

              <label className="settings-row">
                <span className="settings-label">
                  {t.settings.models.effortLabel}
                </span>
                <select
                  aria-describedby={
                    effortInvalid ? `settings-effort-warn-${role}` : undefined
                  }
                  aria-invalid={effortInvalid || undefined}
                  aria-label={`${modelRoleLabel(role, t)} ${t.settings.models.effortLabel}`}
                  onChange={(event) =>
                    onChange(role, { effort: event.target.value })
                  }
                  value={roleConfig.effort}
                >
                  {effortOptions.map((value) => (
                    <option key={value || 'default'} value={value}>
                      {effortLabel(value, t)}
                    </option>
                  ))}
                  {effortInvalid ? (
                    <option value={roleConfig.effort}>
                      {effortLabel(roleConfig.effort as EffortValue, t)}
                    </option>
                  ) : null}
                </select>
              </label>

              {effortInvalid && agentType ? (
                <p
                  className="settings-effort-warn"
                  id={`settings-effort-warn-${role}`}
                  role="alert"
                >
                  {t.settings.models.effortInvalid
                    .replace('{value}', roleConfig.effort)
                    .replace('{agent}', agentTypeLabel(agentType, t))}
                </p>
              ) : null}

              {roleConfig.model || roleConfig.effort ? (
                <p className="settings-inline-meta">
                  {roleConfig.model
                    ? modelGroupLabel(roleConfig.model, t)
                    : t.settings.models.modelDefault}
                  {' · '}
                  {roleConfig.effort
                    ? effortLabel(roleConfig.effort as EffortValue, t)
                    : t.settings.models.effortDefault}
                </p>
              ) : null}
            </div>
          </article>
        );
      })}
    </div>
  );
}
