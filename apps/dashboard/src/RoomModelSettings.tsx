import { useEffect, useState } from 'react';

import {
  fetchRoomModelSettings,
  updateRoomModelSetting,
  type RoomModelRole,
  type RoomModelRoleSetting,
  type RoomModelSettingsRoom,
  type RoomModelSettingsSnapshot,
} from './api';
import { type Locale, type Messages } from './i18n';
import { roomModelMessages, type RoomModelMessages } from './i18n/room-models';
import { SettingsCard } from './SettingsPanelChrome';
import {
  type AgentType,
  type EffortValue,
  effortValuesForAgent,
  formatEffortOption,
  isPresetModel,
  PRESET_MODELS,
} from './settings-options';

function roleLabel(role: RoomModelRole, t: Messages): string {
  if (role === 'owner') return t.settings.models.roleOwner;
  if (role === 'reviewer') return t.settings.models.roleReviewer;
  return t.settings.models.roleArbiter;
}

function presetsForAgent(agentType: AgentType): readonly string[] {
  if (agentType === 'codex') return PRESET_MODELS.codex;
  if (agentType === 'glm-code') return PRESET_MODELS.glm;
  return PRESET_MODELS.claude;
}

function fillPlaceholder(template: string, value: string): string {
  return template.replace('{value}', value ? ` (${value})` : '');
}

function effortLabel(value: EffortValue, t: Messages): string {
  const key = value as keyof typeof t.settings.models.effortOptions;
  const localized = t.settings.models.effortOptions[key] ?? value;
  return formatEffortOption(value, localized);
}

export function RoomModelSettings({
  locale,
  t,
}: {
  locale: Locale;
  t: Messages;
}) {
  const [snapshot, setSnapshot] = useState<RoomModelSettingsSnapshot | null>(
    null,
  );
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [customDrafts, setCustomDrafts] = useState<Record<string, string>>({});
  const section = roomModelMessages[locale];

  useEffect(() => {
    let cancelled = false;
    fetchRoomModelSettings()
      .then((fresh) => {
        if (cancelled) return;
        setSnapshot(fresh);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function apply(
    roomJid: string,
    role: RoomModelRole,
    patch: { model?: string; effort?: string },
  ) {
    const key = `${roomJid}:${role}`;
    setBusyKey(key);
    setError(null);
    try {
      const fresh = await updateRoomModelSetting({ roomJid, role, ...patch });
      setSnapshot(fresh);
    } catch (err) {
      setError(
        `${section.updateFailed}: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <SettingsCard description={section.hint} title={section.title}>
      {error ? <p className="settings-error">{error}</p> : null}
      {!snapshot ? (
        <p className="settings-hint">{t.settings.common.loading}</p>
      ) : snapshot.rooms.length === 0 ? (
        <p className="settings-hint">{section.empty}</p>
      ) : (
        <div className="settings-section-stack">
          {snapshot.rooms.map((room) => (
            <RoomModelRoomFields
              busyKey={busyKey}
              customDrafts={customDrafts}
              key={room.jid}
              onApply={apply}
              onCustomDraftChange={(key, value) =>
                setCustomDrafts((prev) => ({ ...prev, [key]: value }))
              }
              room={room}
              section={section}
              t={t}
            />
          ))}
          <small className="settings-hint">{section.applyHint}</small>
        </div>
      )}
    </SettingsCard>
  );
}

function RoomModelRoomFields({
  busyKey,
  customDrafts,
  onApply,
  onCustomDraftChange,
  room,
  section,
  t,
}: {
  busyKey: string | null;
  customDrafts: Record<string, string>;
  onApply: (
    roomJid: string,
    role: RoomModelRole,
    patch: { model?: string; effort?: string },
  ) => void;
  onCustomDraftChange: (key: string, value: string) => void;
  room: RoomModelSettingsRoom;
  section: RoomModelMessages;
  t: Messages;
}) {
  return (
    <article className="settings-model-card">
      <header className="settings-model-card-head">
        <span className="settings-kicker">{room.roomMode}</span>
        <strong>{room.name}</strong>
      </header>
      <div className="settings-model-fields">
        {room.roles.map((setting) => (
          <RoomModelRoleRow
            busyKey={busyKey}
            customDrafts={customDrafts}
            key={setting.role}
            onApply={onApply}
            onCustomDraftChange={onCustomDraftChange}
            roomJid={room.jid}
            section={section}
            setting={setting}
            t={t}
          />
        ))}
      </div>
    </article>
  );
}

function RoomModelRoleRow({
  busyKey,
  customDrafts,
  onApply,
  onCustomDraftChange,
  roomJid,
  section,
  setting,
  t,
}: {
  busyKey: string | null;
  customDrafts: Record<string, string>;
  onApply: (
    roomJid: string,
    role: RoomModelRole,
    patch: { model?: string; effort?: string },
  ) => void;
  onCustomDraftChange: (key: string, value: string) => void;
  roomJid: string;
  section: RoomModelMessages;
  setting: RoomModelRoleSetting;
  t: Messages;
}) {
  const key = `${roomJid}:${setting.role}`;
  const busy = busyKey !== null;
  const presets = presetsForAgent(setting.agentType);
  const customDraft = customDrafts[key];
  const usingCustom =
    customDraft !== undefined ||
    (setting.model !== '' && !isPresetModel(setting.model));
  const effortOptions = effortValuesForAgent(setting.agentType).filter(
    (value) => value !== '',
  );

  return (
    <div className="settings-row-group">
      <p className="settings-inline-meta">
        <strong>{roleLabel(setting.role, t)}</strong>
        {' · '}
        {setting.agentType}
      </p>
      <label className="settings-row">
        <span className="settings-label">{t.settings.models.modelLabel}</span>
        <select
          aria-label={`${setting.role} ${t.settings.models.modelLabel}`}
          disabled={busy}
          onChange={(event) => {
            const value = event.target.value;
            if (value === '__custom__') {
              onCustomDraftChange(key, setting.model);
              return;
            }
            onApply(roomJid, setting.role, { model: value });
          }}
          value={usingCustom ? '__custom__' : setting.model}
        >
          <option value="">
            {fillPlaceholder(section.globalDefault, setting.globalModel)}
          </option>
          {presets.map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
          <option value="__custom__">{t.settings.models.modelCustom}</option>
        </select>
      </label>
      {usingCustom ? (
        <label className="settings-row">
          <span className="settings-label">
            {t.settings.models.modelCustomLabel}
          </span>
          <input
            disabled={busy}
            onBlur={(event) => {
              onApply(roomJid, setting.role, {
                model: event.target.value.trim(),
              });
            }}
            onChange={(event) => onCustomDraftChange(key, event.target.value)}
            placeholder={t.settings.models.modelPlaceholder}
            type="text"
            value={customDraft ?? setting.model}
          />
        </label>
      ) : null}
      <label className="settings-row">
        <span className="settings-label">{t.settings.models.effortLabel}</span>
        <select
          aria-label={`${setting.role} ${t.settings.models.effortLabel}`}
          disabled={busy}
          onChange={(event) =>
            onApply(roomJid, setting.role, { effort: event.target.value })
          }
          value={setting.effort}
        >
          <option value="">
            {fillPlaceholder(section.globalDefault, setting.globalEffort)}
          </option>
          {effortOptions.map((value) => (
            <option key={value} value={value}>
              {effortLabel(value, t)}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
