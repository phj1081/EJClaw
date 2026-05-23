import { useEffect, useMemo, useState } from 'react';

import {
  fetchRoomSkillSettings,
  updateRoomSkillSetting,
  type RoomSkillCatalogItem,
  type RoomSkillSettingUpdateInput,
  type RoomSkillSettingsSnapshot,
} from './api';
import { SettingsCard, SettingsSectionHeading } from './SettingsPanelChrome';
import { type Messages } from './i18n';

type RoomSkillRoom = RoomSkillSettingsSnapshot['rooms'][number];
type RoomSkillAgent = RoomSkillRoom['agents'][number];
type AgentType = RoomSkillAgent['agentType'];

function agentLabel(agentType: AgentType, t: Messages): string {
  return agentType === 'codex'
    ? t.settings.runtime.agentCodex
    : t.settings.runtime.agentClaude;
}

function scopeLabel(scope: RoomSkillCatalogItem['scope'], t: Messages): string {
  if (scope === 'codex-user') return t.settings.runtime.scopeCodexUser;
  if (scope === 'claude-user') return t.settings.runtime.scopeClaudeUser;
  return t.settings.runtime.scopeRunner;
}

function applyOptimisticToggle(
  snapshot: RoomSkillSettingsSnapshot,
  input: RoomSkillSettingUpdateInput,
): RoomSkillSettingsSnapshot {
  const { roomJid, agentType, skillId, enabled } = input;

  return {
    ...snapshot,
    rooms: snapshot.rooms.map((room) => {
      if (room.jid !== roomJid) return room;
      return {
        ...room,
        agents: room.agents.map((agent) => {
          if (agent.agentType !== agentType) return agent;

          const disabledSkillIds = enabled
            ? agent.disabledSkillIds.filter((id) => id !== skillId)
            : agent.disabledSkillIds.includes(skillId)
              ? agent.disabledSkillIds
              : [...agent.disabledSkillIds, skillId];

          const effectiveEnabledSkillIds = enabled
            ? agent.availableSkillIds.filter(
                (id) => !disabledSkillIds.includes(id),
              )
            : agent.availableSkillIds.filter(
                (id) => id !== skillId && !disabledSkillIds.includes(id),
              );

          return {
            ...agent,
            mode: disabledSkillIds.length === 0 ? 'all-enabled' : 'custom',
            disabledSkillIds,
            effectiveEnabledSkillIds,
          };
        }),
      };
    }),
  };
}

interface RoomSkillControlsProps {
  onAgentChange: (agentType: AgentType) => void;
  onRoomChange: (roomJid: string) => void;
  selectedAgentType: AgentType;
  selectedRoom: RoomSkillRoom | null;
  selectedRoomJid: string;
  snapshot: RoomSkillSettingsSnapshot;
  t: Messages;
}

function RoomSkillControls({
  onAgentChange,
  onRoomChange,
  selectedAgentType,
  selectedRoom,
  selectedRoomJid,
  snapshot,
  t,
}: RoomSkillControlsProps) {
  return (
    <div className="settings-form-grid settings-skill-controls">
      <label className="settings-row">
        <span className="settings-label">
          {t.settings.runtime.selectRoomLabel}
        </span>
        <select
          onChange={(event) => onRoomChange(event.target.value)}
          value={selectedRoomJid}
        >
          {snapshot.rooms.map((room) => (
            <option key={room.jid} value={room.jid}>
              {room.name} ({room.folder})
            </option>
          ))}
        </select>
      </label>

      {selectedRoom && selectedRoom.agents.length > 1 ? (
        <div className="settings-row">
          <span className="settings-label">
            {t.settings.runtime.selectAgentLabel}
          </span>
          <div className="settings-skill-agent-tabs" role="tablist">
            {selectedRoom.agents.map((agent) => (
              <button
                aria-selected={selectedAgentType === agent.agentType}
                className={
                  selectedAgentType === agent.agentType
                    ? 'is-active'
                    : undefined
                }
                key={agent.agentType}
                onClick={() => onAgentChange(agent.agentType)}
                role="tab"
                type="button"
              >
                {agentLabel(agent.agentType, t)}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

interface SkillToggleListProps {
  catalogById: Map<string, RoomSkillCatalogItem>;
  onToggle: (input: RoomSkillSettingUpdateInput) => void;
  savingKey: string | null;
  selectedAgent: RoomSkillAgent;
  selectedRoomJid: string;
  t: Messages;
}

function SkillToggleList({
  catalogById,
  onToggle,
  savingKey,
  selectedAgent,
  selectedRoomJid,
  t,
}: SkillToggleListProps) {
  return (
    <div className="settings-toggle-stack">
      {selectedAgent.availableSkillIds.map((skillId) => {
        const skill = catalogById.get(skillId);
        const key = `${selectedRoomJid}:${selectedAgent.agentType}:${skillId}`;
        const enabled =
          selectedAgent.effectiveEnabledSkillIds.includes(skillId);
        return (
          <label
            aria-busy={savingKey === key}
            className={`settings-toggle-row${savingKey === key ? ' is-busy' : ''}`}
            key={skillId}
          >
            <span className="settings-toggle-label">
              <span className="settings-toggle-title">
                {skill?.displayName ?? skillId}
              </span>
              <small>
                {skill ? scopeLabel(skill.scope, t) : null}
                {skill?.description ? ` · ${skill.description}` : null}
              </small>
            </span>
            <input
              checked={enabled}
              disabled={savingKey === key}
              onChange={(event) =>
                onToggle({
                  roomJid: selectedRoomJid,
                  agentType: selectedAgent.agentType,
                  skillId,
                  enabled: event.currentTarget.checked,
                })
              }
              type="checkbox"
            />
          </label>
        );
      })}
    </div>
  );
}

export function RuntimeInventorySettings({ t }: { t: Messages }) {
  const [snapshot, setSnapshot] = useState<RoomSkillSettingsSnapshot | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [selectedRoomJid, setSelectedRoomJid] = useState<string>('');
  const [selectedAgentType, setSelectedAgentType] =
    useState<AgentType>('codex');

  useEffect(() => {
    let cancelled = false;
    fetchRoomSkillSettings()
      .then((value) => {
        if (cancelled) return;
        setSnapshot(value);
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

  const selectedRoom = useMemo(
    () => snapshot?.rooms.find((room) => room.jid === selectedRoomJid) ?? null,
    [snapshot, selectedRoomJid],
  );

  const selectedAgent = useMemo(
    () =>
      selectedRoom?.agents.find(
        (agent) => agent.agentType === selectedAgentType,
      ) ?? null,
    [selectedRoom, selectedAgentType],
  );

  useEffect(() => {
    if (!snapshot || snapshot.rooms.length === 0) return;
    if (!snapshot.rooms.some((room) => room.jid === selectedRoomJid)) {
      setSelectedRoomJid(snapshot.rooms[0]?.jid ?? '');
    }
  }, [snapshot, selectedRoomJid]);

  useEffect(() => {
    if (!selectedRoom || selectedRoom.agents.length === 0) return;
    if (
      !selectedRoom.agents.some(
        (agent) => agent.agentType === selectedAgentType,
      )
    ) {
      setSelectedAgentType(selectedRoom.agents[0]?.agentType ?? 'codex');
    }
  }, [selectedRoom, selectedAgentType]);

  const catalogById = useMemo(
    () =>
      new Map<string, RoomSkillCatalogItem>(
        snapshot?.catalog.map((skill) => [skill.id, skill]) ?? [],
      ),
    [snapshot],
  );

  async function handleToggle(input: RoomSkillSettingUpdateInput) {
    const key = `${input.roomJid}:${input.agentType}:${input.skillId}`;
    setError(null);
    setSnapshot((current) =>
      current ? applyOptimisticToggle(current, input) : current,
    );
    setSavingKey(key);

    try {
      const next = await updateRoomSkillSetting(input);
      setSnapshot(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      try {
        setSnapshot(await fetchRoomSkillSettings());
      } catch {
        /* keep optimistic state if refetch also fails */
      }
    } finally {
      setSavingKey(null);
    }
  }

  return (
    <section
      aria-labelledby="settings-runtime-tab"
      className="settings-section"
      id="settings-runtime"
      role="tabpanel"
    >
      <SettingsSectionHeading
        description={t.settings.sections.runtime.description}
        detail={t.settings.sections.runtime.kicker}
        title={t.settings.sections.runtime.title}
      />

      <p className="settings-hint settings-skill-default-hint">
        {t.settings.runtime.defaultHint}
      </p>

      {error ? <p className="settings-error">{error}</p> : null}

      {!snapshot ? (
        <p className="settings-hint">{t.settings.common.loading}</p>
      ) : snapshot.rooms.length === 0 ? (
        <SettingsCard title={t.settings.runtime.selectRoomLabel}>
          <p className="settings-hint">{t.settings.runtime.emptyRooms}</p>
        </SettingsCard>
      ) : (
        <SettingsCard title={t.settings.runtime.selectRoomLabel}>
          <RoomSkillControls
            onAgentChange={setSelectedAgentType}
            onRoomChange={setSelectedRoomJid}
            selectedAgentType={selectedAgentType}
            selectedRoom={selectedRoom}
            selectedRoomJid={selectedRoomJid}
            snapshot={snapshot}
            t={t}
          />

          {!selectedAgent || selectedAgent.availableSkillIds.length === 0 ? (
            <p className="settings-hint">{t.settings.runtime.emptySkills}</p>
          ) : (
            <SkillToggleList
              catalogById={catalogById}
              onToggle={(input) => void handleToggle(input)}
              savingKey={savingKey}
              selectedAgent={selectedAgent}
              selectedRoomJid={selectedRoomJid}
              t={t}
            />
          )}
        </SettingsCard>
      )}
    </section>
  );
}
