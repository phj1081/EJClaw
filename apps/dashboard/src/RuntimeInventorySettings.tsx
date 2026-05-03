import { useEffect, useState } from 'react';

import {
  fetchRuntimeInventory,
  type RuntimeAgentInventory,
  type RuntimeInventorySnapshot,
  type RuntimePathSnapshot,
  type RuntimeSkillDirSnapshot,
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

export function RuntimeInventorySettings() {
  const [snapshot, setSnapshot] = useState<RuntimeInventorySnapshot | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchRuntimeInventory()
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
