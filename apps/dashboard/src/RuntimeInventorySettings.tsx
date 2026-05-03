import { useEffect, useState } from 'react';

import {
  fetchRoomSkillSettings,
  fetchRuntimeInventory,
  updateRoomSkillSetting,
  type RuntimeAgentInventory,
  type RuntimeInventorySnapshot,
  type RuntimePathSnapshot,
  type RuntimeSkillDirSnapshot,
  type RoomSkillCatalogItem,
  type RoomSkillSettingUpdateInput,
  type RoomSkillSettingsSnapshot,
} from './api';
import { SettingsSectionHeading } from './SettingsPanelChrome';
import './RuntimeInventorySettings.css';

function ExistsBadge({ exists }: { exists: boolean }) {
  return (
    <span className={`settings-account-badge ${exists ? 'is-active' : ''}`}>
      {exists ? '감지됨' : '없음'}
    </span>
  );
}

function PathRow({ item }: { item: RuntimePathSnapshot }) {
  return (
    <li className="runtime-path-row">
      <span>
        <strong>{item.label}</strong>
        <code>{item.path}</code>
      </span>
      <ExistsBadge exists={item.exists} />
    </li>
  );
}

function SkillDirCard({ dir }: { dir: RuntimeSkillDirSnapshot }) {
  const preview = dir.skills.slice(0, 6);
  return (
    <article className="runtime-skill-card">
      <header>
        <div>
          <strong>{dir.label}</strong>
          <code>{dir.path}</code>
        </div>
        <span className="settings-account-badge is-active">
          {dir.count} skills
        </span>
      </header>
      {preview.length === 0 ? (
        <p className="settings-hint">표시할 SKILL.md 없음</p>
      ) : (
        <ul className="runtime-skill-list">
          {preview.map((skill) => (
            <li key={skill.path}>
              <strong>{skill.name}</strong>
              {skill.description ? <span>{skill.description}</span> : null}
            </li>
          ))}
        </ul>
      )}
      {dir.count > preview.length ? (
        <small className="settings-hint">
          외 {dir.count - preview.length}개 더 있음
        </small>
      ) : null}
    </article>
  );
}

function AgentInventoryCard({
  title,
  inventory,
}: {
  title: string;
  inventory: RuntimeAgentInventory;
}) {
  return (
    <article className="runtime-agent-card">
      <header className="runtime-card-head">
        <h4>{title}</h4>
        <span className="settings-account-badge is-active">
          MCP {inventory.mcp.ejclawConfigured ? '연결' : '미감지'}
        </span>
      </header>
      <ul className="runtime-path-list">
        {inventory.configFiles.map((item) => (
          <PathRow item={item} key={item.path} />
        ))}
        <PathRow item={inventory.mcp.configPath} />
      </ul>
      <p className="settings-hint">
        MCP servers {inventory.mcp.serverCount}개 · EJClaw section{' '}
        {inventory.mcp.ejclawConfigured ? '있음' : '없음'}
      </p>
      <div className="runtime-skill-grid">
        {inventory.skillDirs.map((dir) => (
          <SkillDirCard dir={dir} key={dir.path} />
        ))}
      </div>
    </article>
  );
}

function agentLabel(agentType: 'claude-code' | 'codex') {
  return agentType === 'codex' ? 'Codex' : 'Claude Code';
}

function RoomSkillPolicyCard({
  onToggle,
  savingKey,
  snapshot,
}: {
  onToggle: (input: RoomSkillSettingUpdateInput) => void;
  savingKey: string | null;
  snapshot: RoomSkillSettingsSnapshot | null;
}) {
  if (!snapshot) {
    return (
      <article className="runtime-agent-card">
        <header className="runtime-card-head">
          <h4>방별 스킬 정책</h4>
        </header>
        <p className="settings-hint">방별 스킬 정책을 불러오는 중…</p>
      </article>
    );
  }

  const catalogById = new Map<string, RoomSkillCatalogItem>(
    snapshot.catalog.map((skill) => [skill.id, skill]),
  );
  const roomPreview = snapshot.rooms.slice(0, 8);

  return (
    <article className="runtime-agent-card">
      <header className="runtime-card-head">
        <div>
          <h4>방별 스킬 정책</h4>
          <p className="settings-hint">
            전역 설정은 읽기 전용입니다. 이 목록은 다음 토글 PR에서 방 단위
            enable/disable 대상으로 쓰입니다.
          </p>
        </div>
        <span className="settings-account-badge is-active">
          {snapshot.catalog.length} skills · {snapshot.rooms.length} rooms
        </span>
      </header>

      {roomPreview.length === 0 ? (
        <p className="settings-hint">등록된 방이 없습니다.</p>
      ) : (
        <div className="runtime-room-skill-list">
          {roomPreview.map((room) => (
            <section className="runtime-room-skill-card" key={room.jid}>
              <header>
                <div>
                  <strong>{room.name}</strong>
                  <span>{room.folder}</span>
                </div>
                <code>{room.jid}</code>
              </header>
              <div className="runtime-room-agent-grid">
                {room.agents.map((agent) => {
                  const disabledNames = agent.disabledSkillIds
                    .map((id) => catalogById.get(id)?.displayName ?? id)
                    .slice(0, 3);
                  const enabledIds = new Set(agent.effectiveEnabledSkillIds);
                  return (
                    <div
                      className="runtime-room-agent-policy"
                      key={`${room.jid}:${agent.agentType}`}
                    >
                      <strong>{agentLabel(agent.agentType)}</strong>
                      <span>
                        {agent.mode === 'all-enabled'
                          ? '기본 전체 ON'
                          : `${agent.disabledSkillIds.length}개 OFF`}
                      </span>
                      <small>
                        사용 {agent.effectiveEnabledSkillIds.length} / 가능{' '}
                        {agent.availableSkillIds.length}
                      </small>
                      {disabledNames.length > 0 ? (
                        <small>OFF: {disabledNames.join(', ')}</small>
                      ) : null}
                      <div className="runtime-room-skill-toggles">
                        {agent.availableSkillIds.map((skillId) => {
                          const skill = catalogById.get(skillId);
                          const key = `${room.jid}:${agent.agentType}:${skillId}`;
                          return (
                            <label
                              className="runtime-room-skill-toggle"
                              key={skillId}
                            >
                              <input
                                checked={enabledIds.has(skillId)}
                                disabled={savingKey !== null}
                                onChange={(event) =>
                                  onToggle({
                                    roomJid: room.jid,
                                    agentType: agent.agentType,
                                    skillId,
                                    enabled: event.currentTarget.checked,
                                  })
                                }
                                type="checkbox"
                              />
                              <span>
                                <strong>{skill?.displayName ?? skillId}</strong>
                                <small>
                                  {skill?.scope ?? 'unknown'}
                                  {savingKey === key ? ' · 저장 중' : ''}
                                </small>
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
      {snapshot.rooms.length > roomPreview.length ? (
        <small className="settings-hint">
          외 {snapshot.rooms.length - roomPreview.length}개 방 더 있음
        </small>
      ) : null}
    </article>
  );
}

export function RuntimeInventorySettings() {
  const [snapshot, setSnapshot] = useState<RuntimeInventorySnapshot | null>(
    null,
  );
  const [roomSkillSnapshot, setRoomSkillSnapshot] =
    useState<RoomSkillSettingsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [roomSkillError, setRoomSkillError] = useState<string | null>(null);
  const [savingRoomSkillKey, setSavingRoomSkillKey] = useState<string | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchRuntimeInventory(), fetchRoomSkillSettings()])
      .then(([value, roomSkills]) => {
        if (cancelled) return;
        setSnapshot(value);
        setRoomSkillSnapshot(roomSkills);
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

  async function handleRoomSkillToggle(input: RoomSkillSettingUpdateInput) {
    const key = `${input.roomJid}:${input.agentType}:${input.skillId}`;
    setSavingRoomSkillKey(key);
    setRoomSkillError(null);
    try {
      const next = await updateRoomSkillSetting(input);
      setRoomSkillSnapshot(next);
    } catch (err) {
      setRoomSkillError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingRoomSkillKey(null);
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
        detail="Runtime inventory"
        title="런타임"
        description="Codex/Claude Code 설정, 스킬, MCP 연결 상태를 읽기 전용으로 확인합니다."
      />
      {error ? <p className="settings-error">{error}</p> : null}
      {!snapshot ? (
        <p className="settings-hint">런타임 정보를 불러오는 중…</p>
      ) : (
        <div className="runtime-inventory">
          <section className="runtime-summary-card">
            <div>
              <span className="settings-kicker">Current service</span>
              <strong>{snapshot.service.id}</strong>
              <small>
                {snapshot.service.agentType} · session{' '}
                {snapshot.service.sessionScope}
              </small>
            </div>
            <div>
              <span className="settings-kicker">Project</span>
              <code>{snapshot.projectRoot}</code>
              <small>data {snapshot.dataDir}</small>
            </div>
          </section>

          <AgentInventoryCard title="Codex" inventory={snapshot.codex} />
          <AgentInventoryCard title="Claude Code" inventory={snapshot.claude} />
          {roomSkillError ? (
            <p className="settings-error">{roomSkillError}</p>
          ) : null}
          <RoomSkillPolicyCard
            onToggle={(input) => {
              void handleRoomSkillToggle(input);
            }}
            savingKey={savingRoomSkillKey}
            snapshot={roomSkillSnapshot}
          />

          <article className="runtime-agent-card">
            <header className="runtime-card-head">
              <h4>EJClaw bridge</h4>
              <ExistsBadge exists={snapshot.ejclaw.mcpServer.exists} />
            </header>
            <ul className="runtime-path-list">
              <PathRow item={snapshot.ejclaw.mcpServer} />
              <PathRow item={snapshot.ejclaw.runnerSkillDir} />
            </ul>
          </article>
        </div>
      )}
    </section>
  );
}
