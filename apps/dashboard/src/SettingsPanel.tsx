import { useEffect, useState } from 'react';

import {
  type ClaudeAccountSummary,
  type CodexAccountSummary,
  type CodexFeatureSnapshot,
  type FastModeSnapshot,
  type ModelConfigSnapshot,
  type ModelRoleConfig,
  addClaudeAccount,
  deleteAccount,
  fetchAccounts,
  fetchCodexFeatures,
  fetchFastMode,
  fetchModelConfig,
  refreshAllCodexAccounts as refreshAllCodexAccountsApi,
  refreshCodexAccount as refreshCodexAccountApi,
  setCurrentCodexAccount as setCurrentCodexAccountApi,
  updateCodexFeatures,
  updateFastMode,
  updateModels,
} from './api';
import { type Locale, type Messages } from './i18n';
import { MoaSettingsPanel } from './MoaSettingsPanel';
import { RuntimeInventorySettings } from './RuntimeInventorySettings';
import {
  GeneralSettings,
  SettingsApplyCard,
  SettingsNav,
  SettingsSectionHeading,
  type SettingsSectionId,
} from './SettingsPanelChrome';

type AccountProvider = 'claude' | 'codex';

interface AccountData {
  claude: ClaudeAccountSummary[];
  codex: CodexAccountSummary[];
  codexCurrentIndex?: number;
}

export interface SettingsPanelProps {
  locale: Locale;
  nickname: string;
  onLocaleChange: (locale: Locale) => void;
  onNicknameChange: (next: string) => void;
  onRestartStack: () => void;
  t: Messages;
}

export function SettingsPanel({
  locale,
  nickname,
  onLocaleChange,
  onNicknameChange,
  onRestartStack,
  t,
}: SettingsPanelProps) {
  const [activeSection, setActiveSection] =
    useState<SettingsSectionId>('settings-general');

  return (
    <div className="settings-panel">
      <div className="settings-layout">
        <aside className="settings-sidebar" aria-label="설정 탐색과 적용">
          <SettingsNav
            activeSection={activeSection}
            onSelect={setActiveSection}
          />
          <SettingsApplyCard onRestartStack={onRestartStack} />
        </aside>
        <main className="settings-content" aria-label="설정 항목">
          <div hidden={activeSection !== 'settings-general'}>
            <GeneralSettings
              locale={locale}
              nickname={nickname}
              onLocaleChange={onLocaleChange}
              onNicknameChange={onNicknameChange}
              t={t}
            />
          </div>

          <div hidden={activeSection !== 'settings-models'}>
            <ModelSettings />
          </div>

          <div hidden={activeSection !== 'settings-runtime'}>
            <RuntimeInventorySettings />
          </div>

          <div hidden={activeSection !== 'settings-moa'}>
            <MoaSettingsPanel />
          </div>

          <div hidden={activeSection !== 'settings-codex'}>
            <CodexRuntimeSettings />
          </div>

          <div hidden={activeSection !== 'settings-accounts'}>
            <AccountSettings />
          </div>
        </main>
      </div>
    </div>
  );
}

function ModelSettings() {
  const [config, setConfig] = useState<ModelConfigSnapshot | null>(null);
  const [draft, setDraft] = useState<ModelConfigSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    fetchModelConfig()
      .then((c) => {
        if (cancelled) return;
        setConfig(c);
        setDraft(c);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function save() {
    if (!draft || !config) return;
    setBusy(true);
    setError(null);
    try {
      const next = await updateModels(draft);
      setConfig(next);
      setDraft(next);
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function setRole(
    role: keyof ModelConfigSnapshot,
    patch: Partial<ModelRoleConfig>,
  ) {
    setDraft((prev) =>
      prev
        ? {
            ...prev,
            [role]: { ...prev[role], ...patch },
          }
        : prev,
    );
  }

  const dirty =
    draft !== null &&
    config !== null &&
    JSON.stringify(draft) !== JSON.stringify(config);

  return (
    <section
      aria-labelledby="settings-models-tab"
      className="settings-section"
      id="settings-models"
      role="tabpanel"
    >
      <SettingsSectionHeading
        detail="Agent routing"
        title="모델"
        description="역할별 모델과 reasoning effort를 지정합니다."
      />
      {error ? <p className="settings-error">{error}</p> : null}
      {!draft ? (
        <p className="settings-hint">
          {busy ? '불러오는 중…' : '모델 정보 없음'}
        </p>
      ) : (
        <>
          {(['owner', 'reviewer', 'arbiter'] as const).map((role) => (
            <div className="settings-row settings-row-inline" key={role}>
              <span className="settings-label">{role}</span>
              <input
                aria-label={`${role} model`}
                onChange={(e) => setRole(role, { model: e.target.value })}
                placeholder="claude / codex / claude-opus-4-7 …"
                type="text"
                value={draft[role].model}
              />
              <input
                aria-label={`${role} effort`}
                className="settings-input-narrow"
                onChange={(e) => setRole(role, { effort: e.target.value })}
                placeholder="effort"
                type="text"
                value={draft[role].effort}
              />
            </div>
          ))}
          <div className="settings-actions">
            <button
              className="settings-save"
              disabled={!dirty || busy}
              onClick={() => void save()}
              type="button"
            >
              {busy ? '저장 중…' : '모델 저장'}
            </button>
            {savedAt && !dirty ? (
              <small className="settings-hint">
                저장됨. 적용하려면 상단의 스택 재시작을 눌러 주세요.
              </small>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}

function CodexRuntimeSettings() {
  return (
    <section
      aria-labelledby="settings-codex-tab"
      className="settings-section"
      id="settings-codex"
      role="tabpanel"
    >
      <SettingsSectionHeading
        detail="Codex runtime"
        title="Codex 옵션"
        description="빠른 응답과 실험 기능을 관리합니다. /goal은 여기에서 찾을 수 있습니다."
      />
      <div className="settings-section-stack">
        <FastModeSettings />
        <CodexFeatureSettings />
      </div>
    </section>
  );
}

function FastModeSettings() {
  const [state, setState] = useState<FastModeSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchFastMode()
      .then((s) => {
        if (cancelled) return;
        setState(s);
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

  async function toggle(provider: keyof FastModeSnapshot) {
    if (!state) return;
    const next = !state[provider];
    const optimistic = { ...state, [provider]: next };
    setState(optimistic);
    setBusy(true);
    setError(null);
    try {
      const fresh = await updateFastMode({ [provider]: next });
      setState(fresh);
    } catch (err) {
      setState(state);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-subsection">
      <h4>패스트 모드</h4>
      {error ? <p className="settings-error">{error}</p> : null}
      {!state ? (
        <p className="settings-hint">불러오는 중…</p>
      ) : (
        <>
          <label className="settings-toggle-row">
            <span className="settings-toggle-label">
              <span className="settings-toggle-title">Codex (GPT)</span>
              <small className="settings-hint">
                ~/.codex/config.toml [features].fast_mode — 사용량 더 소모하지만
                응답이 빨라집니다.
              </small>
            </span>
            <input
              checked={state.codex}
              disabled={busy}
              onChange={() => void toggle('codex')}
              type="checkbox"
            />
          </label>
          <label className="settings-toggle-row">
            <span className="settings-toggle-label">
              <span className="settings-toggle-title">Claude</span>
              <small className="settings-hint">
                ~/.claude/settings.json fastMode — 인터랙티브 세션의 /fast 와
                동일 키. opus-4-6 한정으로 동작.
              </small>
            </span>
            <input
              checked={state.claude}
              disabled={busy}
              onChange={() => void toggle('claude')}
              type="checkbox"
            />
          </label>
        </>
      )}
    </section>
  );
}

function CodexFeatureSettings() {
  const [state, setState] = useState<CodexFeatureSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchCodexFeatures()
      .then((snapshot) => {
        if (cancelled) return;
        setState(snapshot);
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

  async function toggleGoals() {
    if (!state) return;
    const previous = state;
    const optimistic = { ...state, goals: !state.goals };
    setState(optimistic);
    setBusy(true);
    setError(null);
    try {
      const fresh = await updateCodexFeatures({ goals: optimistic.goals });
      setState(fresh);
      setSavedAt(Date.now());
    } catch (err) {
      setState(previous);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-subsection">
      <h4>Codex 실험 기능</h4>
      {error ? <p className="settings-error">{error}</p> : null}
      {!state ? (
        <p className="settings-hint">불러오는 중…</p>
      ) : (
        <>
          <label className="settings-toggle-row">
            <span className="settings-toggle-label">
              <span className="settings-toggle-title">/goal</span>
              <small className="settings-hint">
                CODEX_GOALS=true — Codex 0.128의 under-development goals
                기능입니다. 기본 OFF이며, 저장 후 스택 재시작이 필요합니다.
              </small>
            </span>
            <input
              checked={state.goals}
              disabled={busy}
              onChange={() => void toggleGoals()}
              type="checkbox"
            />
          </label>
          {savedAt ? (
            <small className="settings-hint">
              저장됨. 적용하려면 상단의 스택 재시작을 눌러 주세요.
            </small>
          ) : null}
        </>
      )}
    </section>
  );
}

function formatExpiry(
  iso: string | null,
): { label: string; cls: string } | null {
  if (!iso) return null;
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return null;
  const days = (dt.getTime() - Date.now()) / 86400000;
  const dateStr = dt.toLocaleDateString('ko-KR', {
    year: '2-digit',
    month: '2-digit',
    day: '2-digit',
  });
  if (days < 0) {
    const ago = Math.ceil(-days);
    return {
      label: `결제 만료 ${dateStr} (${ago}일 전)`,
      cls: 'is-expired',
    };
  }
  if (days < 7) {
    return {
      label: `결제 ${dateStr}까지 (${Math.floor(days)}일)`,
      cls: 'is-soon',
    };
  }
  return {
    label: `결제 ${dateStr}까지 (${Math.floor(days)}일)`,
    cls: 'is-active',
  };
}

function AccountSettings() {
  const [data, setData] = useState<AccountData | null>(null);
  const [busy, setBusy] = useState(false);
  const [perRowBusy, setPerRowBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tokenInput, setTokenInput] = useState('');

  async function refresh() {
    setBusy(true);
    setError(null);
    try {
      const fresh = await fetchAccounts();
      setData(fresh);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function handleDelete(provider: AccountProvider, index: number) {
    if (
      !window.confirm(
        `${provider} 계정 #${index} 디렉터리를 삭제합니다. 되돌릴 수 없습니다. 계속할까요?`,
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await deleteAccount(provider, index);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleAdd() {
    const token = tokenInput.trim();
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      await addClaudeAccount(token);
      setTokenInput('');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleCodexRefresh(index: number) {
    setPerRowBusy(`refresh:${index}`);
    setError(null);
    try {
      await refreshCodexAccountApi(index);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPerRowBusy(null);
    }
  }

  async function handleRefreshAllCodex() {
    setBusy(true);
    setError(null);
    try {
      const result = await refreshAllCodexAccountsApi();
      await refresh();
      if (result.failed.length > 0) {
        setError(
          `일부 갱신 실패: ${result.failed.map((f) => `#${f.index}`).join(', ')}`,
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleSwitchCodex(index: number) {
    setPerRowBusy(`switch:${index}`);
    setError(null);
    try {
      await setCurrentCodexAccountApi(index);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPerRowBusy(null);
    }
  }

  return (
    <section
      aria-labelledby="settings-accounts-tab"
      className="settings-section"
      id="settings-accounts"
      role="tabpanel"
    >
      <SettingsSectionHeading
        detail="Credentials"
        title="계정"
        description="Claude OAuth와 Codex 계정 상태를 확인하고 전환합니다."
      />
      {error ? <p className="settings-error">{error}</p> : null}
      <ClaudeAccounts
        busy={busy}
        data={data}
        onAdd={() => void handleAdd()}
        onDelete={(index) => void handleDelete('claude', index)}
        onTokenInputChange={setTokenInput}
        tokenInput={tokenInput}
      />
      <CodexAccounts
        busy={busy}
        data={data}
        onDelete={(index) => void handleDelete('codex', index)}
        onRefresh={(index) => void handleCodexRefresh(index)}
        onRefreshAll={() => void handleRefreshAllCodex()}
        onSwitch={(index) => void handleSwitchCodex(index)}
        perRowBusy={perRowBusy}
      />
    </section>
  );
}

function ClaudeAccounts({
  busy,
  data,
  onAdd,
  onDelete,
  onTokenInputChange,
  tokenInput,
}: {
  busy: boolean;
  data: AccountData | null;
  onAdd: () => void;
  onDelete: (index: number) => void;
  onTokenInputChange: (value: string) => void;
  tokenInput: string;
}) {
  return (
    <div className="settings-account-group">
      <h4>Claude</h4>
      {!data ? (
        <p className="settings-hint">{busy ? '불러오는 중…' : '없음'}</p>
      ) : data.claude.length === 0 ? (
        <p className="settings-hint">계정 없음</p>
      ) : (
        <ul className="settings-account-list">
          {data.claude.map((acc) => (
            <li key={acc.index} className="settings-account-row">
              <div className="settings-account-main">
                <span className="settings-account-tag">#{acc.index}</span>
                <span className="settings-account-email">
                  {acc.subscriptionType ?? 'unknown'}
                  {acc.rateLimitTier ? ` · ${acc.rateLimitTier}` : ''}
                </span>
                <span className="settings-account-plan">claude</span>
                <span className="settings-account-badge is-active">
                  토큰 자동갱신
                </span>
              </div>
              {acc.index > 0 ? (
                <button
                  className="settings-delete"
                  disabled={busy}
                  onClick={() => onDelete(acc.index)}
                  type="button"
                >
                  삭제
                </button>
              ) : (
                <span className="settings-account-default">기본</span>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="settings-add-token">
        <textarea
          onChange={(e) => onTokenInputChange(e.target.value)}
          placeholder="Claude OAuth 토큰 (claude CLI 로그인 후 ~/.claude/.credentials.json 에서 accessToken 값을 페이스트)"
          rows={2}
          value={tokenInput}
        />
        <button
          disabled={!tokenInput.trim() || busy}
          onClick={onAdd}
          type="button"
        >
          추가
        </button>
      </div>
    </div>
  );
}

function CodexAccounts({
  busy,
  data,
  onDelete,
  onRefresh,
  onRefreshAll,
  onSwitch,
  perRowBusy,
}: {
  busy: boolean;
  data: AccountData | null;
  onDelete: (index: number) => void;
  onRefresh: (index: number) => void;
  onRefreshAll: () => void;
  onSwitch: (index: number) => void;
  perRowBusy: string | null;
}) {
  return (
    <div className="settings-account-group">
      <div className="settings-account-group-head">
        <h4>Codex</h4>
        <button
          className="settings-secondary"
          disabled={busy}
          onClick={onRefreshAll}
          type="button"
        >
          전체 갱신
        </button>
      </div>
      {!data ? (
        <p className="settings-hint">{busy ? '불러오는 중…' : '없음'}</p>
      ) : data.codex.length === 0 ? (
        <p className="settings-hint">계정 없음</p>
      ) : (
        <ul className="settings-account-list">
          {data.codex.map((acc) => (
            <CodexAccountRow
              acc={acc}
              busy={busy}
              isActive={data.codexCurrentIndex === acc.index}
              key={acc.index}
              onDelete={onDelete}
              onRefresh={onRefresh}
              onSwitch={onSwitch}
              perRowBusy={perRowBusy}
            />
          ))}
        </ul>
      )}
      <p className="settings-hint">
        OAuth 토큰은 6시간마다 자동 갱신됩니다. plan 변경/해지가 즉시 반영되게
        하려면 수동으로 “전체 갱신”을 누르세요.
      </p>
    </div>
  );
}

function CodexAccountRow({
  acc,
  busy,
  isActive,
  onDelete,
  onRefresh,
  onSwitch,
  perRowBusy,
}: {
  acc: CodexAccountSummary;
  busy: boolean;
  isActive: boolean;
  onDelete: (index: number) => void;
  onRefresh: (index: number) => void;
  onSwitch: (index: number) => void;
  perRowBusy: string | null;
}) {
  const expiry = formatExpiry(acc.subscriptionUntil);
  const refreshing = perRowBusy === `refresh:${acc.index}`;
  const switching = perRowBusy === `switch:${acc.index}`;

  return (
    <li
      className={`settings-account-row${isActive ? ' is-active-account' : ''}`}
    >
      <div className="settings-account-main">
        <span className="settings-account-tag">
          {isActive ? '●' : ''}#{acc.index}
        </span>
        {acc.email ? (
          <span className="settings-account-email" title={acc.email}>
            {acc.email}
          </span>
        ) : null}
        <span className="settings-account-plan">
          {acc.planType ?? 'unknown'}
        </span>
        {expiry ? (
          <span
            className={`settings-account-badge ${expiry.cls}`}
            title={
              acc.subscriptionLastChecked
                ? `last checked: ${acc.subscriptionLastChecked.slice(0, 10)}`
                : undefined
            }
          >
            {expiry.label}
          </span>
        ) : null}
      </div>
      <div className="settings-account-actions">
        <button
          className="settings-secondary"
          disabled={busy || perRowBusy !== null}
          onClick={() => onRefresh(acc.index)}
          title="OAuth 토큰을 다시 받아 구독 상태를 갱신합니다"
          type="button"
        >
          {refreshing ? '갱신중…' : '갱신'}
        </button>
        {!isActive ? (
          <button
            className="settings-secondary"
            disabled={busy || perRowBusy !== null}
            onClick={() => onSwitch(acc.index)}
            title="이 계정으로 즉시 전환합니다 (다음 codex 호출부터 적용)"
            type="button"
          >
            {switching ? '전환중…' : '전환'}
          </button>
        ) : (
          <span className="settings-account-default">사용중</span>
        )}
        {acc.index > 0 ? (
          <button
            className="settings-delete"
            disabled={busy || perRowBusy !== null}
            onClick={() => onDelete(acc.index)}
            type="button"
          >
            삭제
          </button>
        ) : null}
      </div>
    </li>
  );
}
