import { useEffect, useState } from 'react';

import {
  type ClaudeAccountSummary,
  type CodexAccountSummary,
  type CreateScheduledTaskInput,
  type DashboardInboxAction,
  type DashboardRoomActivity,
  type DashboardTaskAction,
  type DashboardOverview,
  type DashboardTask,
  type FastModeSnapshot,
  type ModelConfigSnapshot,
  type ModelRoleConfig,
  type UpdateScheduledTaskInput,
  type StatusSnapshot,
  addClaudeAccount,
  createScheduledTask,
  deleteAccount,
  fetchAccounts,
  fetchDashboardData,
  fetchFastMode,
  fetchModelConfig,
  refreshAllCodexAccounts as refreshAllCodexAccountsApi,
  refreshCodexAccount as refreshCodexAccountApi,
  runInboxAction,
  runServiceAction,
  runScheduledTaskAction,
  sendRoomMessage,
  setCurrentCodexAccount as setCurrentCodexAccountApi,
  updateFastMode,
  updateModels,
  updateScheduledTask,
} from './api';
import {
  LOCALES,
  isLocale,
  languageNames,
  localeTags,
  matchLocale,
  messages,
  type Locale,
  type Messages,
} from './i18n';
import { useSelectedRoomActivity } from './useRoomActivity';
import {
  SectionNav,
  SideRail,
  type DashboardFreshness,
  type DashboardView,
} from './DashboardNav';
import { formatDate, statusLabel } from './dashboardHelpers';
import { InboxPanel, type InboxActionKey, type InboxItem } from './InboxPanel';
import { RoomBoardV2 } from './RoomBoardV2';
import { ServicePanel, type ServiceActionKey } from './ServicePanel';
import { TaskPanel, type RoomOption, type TaskActionKey } from './TaskPanel';
import { UsagePanel } from './UsagePanel';
import { ParsedBody } from './ParsedBody';
import './styles.css';

interface DashboardState {
  overview: DashboardOverview;
  snapshots: StatusSnapshot[];
  tasks: DashboardTask[];
}

type FreshnessLevel = DashboardFreshness;

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
};

const REFRESH_INTERVAL_MS = 15_000;
const LOCALE_STORAGE_KEY = 'ejclaw.dashboard.locale.v2';
const DEFAULT_VIEW: DashboardView = 'rooms';
const DASHBOARD_STALE_MS = 75_000;

function makeClientRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function isDashboardView(
  value: string | null | undefined,
): value is DashboardView {
  return (
    value === 'usage' ||
    value === 'inbox' ||
    value === 'health' ||
    value === 'rooms' ||
    value === 'scheduled' ||
    value === 'settings'
  );
}

function readViewFromHash(): DashboardView {
  if (typeof window === 'undefined') return DEFAULT_VIEW;
  const raw = window.location.hash.replace(/^#\/?/, '');
  return isDashboardView(raw) ? raw : DEFAULT_VIEW;
}

function readInitialLocale(): Locale {
  const stored =
    typeof window === 'undefined'
      ? null
      : window.localStorage.getItem(LOCALE_STORAGE_KEY);
  if (isLocale(stored)) return stored;

  const languages =
    typeof navigator === 'undefined'
      ? []
      : [...(navigator.languages || []), navigator.language];
  for (const language of languages) {
    const matched = matchLocale(language);
    if (matched) return matched;
  }

  return 'en';
}

function persistNickname(trimmed: string): void {
  if (typeof window === 'undefined') return;
  if (trimmed) window.localStorage.setItem('ejclaw-nickname', trimmed);
  else window.localStorage.removeItem('ejclaw-nickname');
}

function humanizeError(raw: string, t: Messages): string {
  const lower = raw.toLowerCase();
  if (/abort|timeout|timed out/.test(lower)) return t.error.timeout;
  if (/network|fetch failed|failed to fetch|networkerror|offline/.test(lower))
    return t.error.network;
  const statusMatch = lower.match(/\b(\d{3})\b/);
  if (statusMatch) {
    const code = Number(statusMatch[1]);
    if (code === 401 || code === 403) return t.error.auth;
    if (code === 404) return t.error.notFound;
    if (code >= 500) return t.error.server;
    if (code >= 400) return t.error.unknown;
  }
  return raw || t.error.unknown;
}

function senderRoleClass(value: string | null | undefined): string {
  const v = (value ?? '').toLowerCase();
  if (v.includes('오너') || v.includes('owner')) return 'role-owner';
  if (v.includes('리뷰어') || v.includes('reviewer')) return 'role-reviewer';
  if (v.includes('중재자') || v.includes('arbiter')) return 'role-arbiter';
  if (v.includes('cron') || v.includes('sentry') || v.includes('webhook'))
    return 'role-cron';
  return 'role-human';
}

function dashboardAgeMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return Math.max(0, Date.now() - date.getTime());
}

function dashboardFreshness(
  online: boolean,
  generatedAt: string | null | undefined,
): FreshnessLevel {
  if (!online) return 'offline';
  const age = dashboardAgeMs(generatedAt);
  if (age !== null && age > DASHBOARD_STALE_MS) return 'stale';
  return 'fresh';
}

function freshnessLabel(level: FreshnessLevel, t: Messages): string {
  if (level === 'offline') return t.pwa.offline;
  if (level === 'stale') return t.pwa.stale;
  return t.pwa.fresh;
}

function isStandaloneDisplay(): boolean {
  if (typeof window === 'undefined') return false;
  const standaloneNavigator = navigator as Navigator & { standalone?: boolean };
  return (
    standaloneNavigator.standalone === true ||
    (typeof window.matchMedia === 'function' &&
      window.matchMedia('(display-mode: standalone)').matches)
  );
}

function canUsePwaCore(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    'serviceWorker' in navigator
  );
}

function formatDuration(value: number | null, t: Messages): string {
  if (value === null) return '-';
  const seconds = Math.floor(value / 1000);
  if (seconds < 60) return `${seconds}${t.units.second}`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}${t.units.minute}`;
  const hours = Math.floor(minutes / 60);
  return `${hours}${t.units.hour} ${minutes % 60}${t.units.minute}`;
}

function formatLiveElapsed(value: number, t: Messages): string {
  const seconds = Math.max(0, Math.floor(value / 1000));
  if (seconds < 60) return `${seconds}${t.units.second}`;
  const minutes = Math.floor(seconds / 60);
  const remSec = seconds % 60;
  if (minutes < 60)
    return `${minutes}${t.units.minute} ${remSec}${t.units.second}`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return `${hours}${t.units.hour} ${remMin}${t.units.minute} ${remSec}${t.units.second}`;
}

const ROOM_BOARD_FORMATTERS = {
  formatDate,
  formatDuration,
  formatLiveElapsed,
  senderRoleClass,
  statusLabel,
};

function queueLabel(
  pendingTasks: number,
  pendingMessages: boolean,
  t: Messages,
) {
  const parts = [`${pendingTasks} ${t.units.task}`];
  if (pendingMessages) parts.push(t.units.messageShort);
  return parts.join(' · ');
}

function buildRoomOptions(snapshots: StatusSnapshot[]): RoomOption[] {
  const rooms = new Map<string, RoomOption>();
  for (const snapshot of snapshots) {
    for (const entry of snapshot.entries) {
      if (!rooms.has(entry.jid)) {
        rooms.set(entry.jid, {
          jid: entry.jid,
          name: entry.name || entry.folder || entry.jid,
          folder: entry.folder,
        });
      }
    }
  }
  return [...rooms.values()].sort((a, b) =>
    `${a.name} ${a.folder}`.localeCompare(`${b.name} ${b.folder}`),
  );
}

function LanguageSelector({
  locale,
  onLocaleChange,
  t,
}: {
  locale: Locale;
  onLocaleChange: (locale: Locale) => void;
  t: Messages;
}) {
  return (
    <label className="language-select">
      <span>{t.language.label}</span>
      <select
        aria-label={t.language.label}
        onChange={(event) => onLocaleChange(event.target.value as Locale)}
        value={locale}
      >
        {LOCALES.map((item) => (
          <option key={item} value={item}>
            {languageNames[item]}
          </option>
        ))}
      </select>
    </label>
  );
}

function SettingsPanel({
  locale,
  nickname,
  onLocaleChange,
  onNicknameChange,
  onRestartStack,
  t,
}: {
  locale: Locale;
  nickname: string;
  onLocaleChange: (locale: Locale) => void;
  onNicknameChange: (next: string) => void;
  onRestartStack: () => void;
  t: Messages;
}) {
  return (
    <div className="settings-panel">
      <section className="settings-section">
        <h3>일반</h3>
        <label className="settings-row">
          <span className="settings-label">{t.settings.nicknameLabel}</span>
          <input
            maxLength={32}
            onChange={(event) => onNicknameChange(event.target.value)}
            placeholder={t.settings.nicknamePlaceholder}
            type="text"
            value={nickname}
          />
          <small className="settings-hint">{t.settings.nicknameHelp}</small>
        </label>
        <label className="settings-row">
          <span className="settings-label">{t.settings.languageLabel}</span>
          <select
            aria-label={t.settings.languageLabel}
            onChange={(event) => onLocaleChange(event.target.value as Locale)}
            value={locale}
          >
            {LOCALES.map((item) => (
              <option key={item} value={item}>
                {languageNames[item]}
              </option>
            ))}
          </select>
        </label>
      </section>

      <ModelSettings onRestartStack={onRestartStack} />

      <FastModeSettings />

      <AccountSettings onRestartStack={onRestartStack} />
    </div>
  );
}

function ModelSettings({ onRestartStack }: { onRestartStack: () => void }) {
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
    <section className="settings-section">
      <h3>모델</h3>
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
              {busy ? '저장 중…' : '저장'}
            </button>
            {savedAt && !dirty ? (
              <small className="settings-hint">
                저장됨. 적용하려면 스택 재시작 필요.
              </small>
            ) : null}
            <button
              className="settings-restart"
              disabled={busy}
              onClick={() => {
                if (
                  window.confirm(
                    '스택을 재시작하면 진행 중인 모든 에이전트 작업이 중단됩니다. 진행할까요?',
                  )
                ) {
                  onRestartStack();
                }
              }}
              type="button"
            >
              스택 재시작
            </button>
          </div>
        </>
      )}
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
    <section className="settings-section">
      <h3>패스트 모드</h3>
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

function AccountSettings({ onRestartStack }: { onRestartStack: () => void }) {
  const [data, setData] = useState<{
    claude: ClaudeAccountSummary[];
    codex: CodexAccountSummary[];
    codexCurrentIndex?: number;
  } | null>(null);
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

  async function handleDelete(provider: 'claude' | 'codex', index: number) {
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
    <section className="settings-section">
      <h3>계정</h3>
      {error ? <p className="settings-error">{error}</p> : null}

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
                    onClick={() => void handleDelete('claude', acc.index)}
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
            onChange={(e) => setTokenInput(e.target.value)}
            placeholder="Claude OAuth 토큰 (claude CLI 로그인 후 ~/.claude/.credentials.json 에서 accessToken 값을 페이스트)"
            rows={2}
            value={tokenInput}
          />
          <button
            disabled={!tokenInput.trim() || busy}
            onClick={() => void handleAdd()}
            type="button"
          >
            추가
          </button>
        </div>
      </div>

      <div className="settings-account-group">
        <div className="settings-account-group-head">
          <h4>Codex</h4>
          <button
            className="settings-secondary"
            disabled={busy}
            onClick={() => void handleRefreshAllCodex()}
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
            {data.codex.map((acc) => {
              const expiry = formatExpiry(acc.subscriptionUntil);
              const isActive = data.codexCurrentIndex === acc.index;
              const refreshing = perRowBusy === `refresh:${acc.index}`;
              const switching = perRowBusy === `switch:${acc.index}`;
              return (
                <li
                  key={acc.index}
                  className={`settings-account-row${isActive ? ' is-active-account' : ''}`}
                >
                  <div className="settings-account-main">
                    <span className="settings-account-tag">
                      {isActive ? '●' : ''}#{acc.index}
                    </span>
                    {acc.email ? (
                      <span
                        className="settings-account-email"
                        title={acc.email}
                      >
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
                      onClick={() => void handleCodexRefresh(acc.index)}
                      title="OAuth 토큰을 다시 받아 구독 상태를 갱신합니다"
                      type="button"
                    >
                      {refreshing ? '갱신중…' : '갱신'}
                    </button>
                    {!isActive ? (
                      <button
                        className="settings-secondary"
                        disabled={busy || perRowBusy !== null}
                        onClick={() => void handleSwitchCodex(acc.index)}
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
                        onClick={() => void handleDelete('codex', acc.index)}
                        type="button"
                      >
                        삭제
                      </button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <p className="settings-hint">
          OAuth 토큰은 6시간마다 자동 갱신됩니다. plan 변경/해지가 즉시 반영되게
          하려면 수동으로 “전체 갱신”을 누르세요.
        </p>
      </div>

      <div className="settings-actions">
        <button
          className="settings-restart"
          disabled={busy}
          onClick={() => {
            if (
              window.confirm(
                '스택을 재시작하면 진행 중인 모든 에이전트 작업이 중단됩니다. 진행할까요?',
              )
            ) {
              onRestartStack();
            }
          }}
          type="button"
        >
          스택 재시작 (변경 적용)
        </button>
      </div>
    </section>
  );
}

function LoadingSkeleton({ t }: { t: Messages }) {
  return (
    <main className="shell shell-loading" aria-busy="true">
      <section className="section-nav skeleton-topbar">
        <span className="skeleton-button" />
        <span className="skeleton-line skeleton-copy" />
        <span className="skeleton-button" />
      </section>
      <section className="skeleton-grid" aria-label={t.app.loading}>
        {Array.from({ length: 4 }, (_, index) => (
          <div className="card skeleton-card" key={index}>
            <span className="skeleton-line skeleton-short" />
            <span className="skeleton-line skeleton-number" />
            <span className="skeleton-line skeleton-copy" />
          </div>
        ))}
      </section>
    </main>
  );
}

function ControlRail({
  canInstall,
  data,
  installed,
  locale,
  offlineReady,
  onInstall,
  online,
  secureContext,
  t,
}: {
  canInstall: boolean;
  data: DashboardState;
  installed: boolean;
  locale: Locale;
  offlineReady: boolean;
  onInstall: () => void;
  online: boolean;
  secureContext: boolean;
  t: Messages;
}) {
  const queue = data.snapshots.reduce(
    (acc, snapshot) => {
      for (const entry of snapshot.entries) {
        acc.pendingTasks += entry.pendingTasks;
        if (entry.pendingMessages) acc.pendingMessageRooms += 1;
      }
      return acc;
    },
    { pendingTasks: 0, pendingMessageRooms: 0 },
  );
  const freshness = dashboardFreshness(online, data.overview.generatedAt);
  const age = dashboardAgeMs(data.overview.generatedAt);

  return (
    <section className="ops-strip" id="overview" aria-label={t.control.aria}>
      <div className={`ops-tile-freshness ops-${freshness}`}>
        <span>{t.pwa.updated}</span>
        <strong>{freshnessLabel(freshness, t)}</strong>
        <small>
          {formatDate(data.overview.generatedAt, locale)}
          {age === null ? '' : ` · ${formatDuration(age, t)}`}
        </small>
      </div>
      <div className="ops-tile-pwa">
        <span>{t.pwa.app}</span>
        <strong>
          {!secureContext
            ? t.pwa.secureRequired
            : installed
              ? t.pwa.installed
              : offlineReady
                ? t.pwa.ready
                : t.pwa.app}
        </strong>
        {canInstall ? (
          <button onClick={onInstall} type="button">
            {t.pwa.install}
          </button>
        ) : (
          <small>
            {!secureContext
              ? t.pwa.secureRequired
              : offlineReady
                ? t.pwa.cached
                : t.pwa.online}
          </small>
        )}
      </div>
      <div>
        <span>{t.metrics.rooms}</span>
        <strong>
          {data.overview.rooms.active + data.overview.rooms.waiting}/
          {data.overview.rooms.total}
        </strong>
        <small>{t.control.activeRooms}</small>
      </div>
      <div>
        <span>{t.control.queue}</span>
        <strong>{queue.pendingTasks}</strong>
        <small>
          {queue.pendingMessageRooms} {t.control.pendingRooms}
        </small>
      </div>
      <div>
        <span>{t.metrics.agents}</span>
        <strong>{data.overview.services.length}</strong>
        <small>{t.panels.heartbeat}</small>
      </div>
      <div>
        <span>{t.metrics.ciWatchers}</span>
        <strong>{data.overview.tasks.watchers.active}</strong>
        <small>
          {data.overview.tasks.watchers.paused} {t.status.paused}
        </small>
      </div>
    </section>
  );
}

function DashboardErrorCard({
  error,
  onRetry,
  refreshing,
  t,
}: {
  error: string;
  onRetry: () => void;
  refreshing: boolean;
  t: Messages;
}) {
  return (
    <section className="error-card" role="alert" aria-live="polite">
      <span>
        <strong>{t.error.api}</strong>
        <small>{humanizeError(error, t)}</small>
      </span>
      <button disabled={refreshing} onClick={onRetry}>
        {t.actions.retry}
      </button>
    </section>
  );
}

function App() {
  const [data, setData] = useState<DashboardState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [activeView, setActiveView] = useState<DashboardView>(readViewFromHash);
  const [locale, setLocale] = useState<Locale>(readInitialLocale);
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );
  const [offlineReady, setOfflineReady] = useState(false);
  const [installPrompt, setInstallPrompt] =
    useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(isStandaloneDisplay);
  const [taskActionKey, setTaskActionKey] = useState<TaskActionKey | null>(
    null,
  );
  const [inboxActionKey, setInboxActionKey] = useState<InboxActionKey | null>(
    null,
  );
  const [serviceActionKey, setServiceActionKey] =
    useState<ServiceActionKey | null>(null);
  const [roomMessageKey, setRoomMessageKey] = useState<string | null>(null);
  const [selectedRoomJid, setSelectedRoomJid] = useState<string | null>(null);
  const {
    refreshRoom: refreshRoomActivity,
    roomActivity,
    roomActivityLoading,
  } = useSelectedRoomActivity({
    active: activeView === 'rooms',
    selectedRoomJid: selectedRoomJid,
  });
  const [pendingMessages, setPendingMessages] = useState<
    Record<string, Array<DashboardRoomActivity['messages'][number]>>
  >({});
  const [nickname, setNicknameState] = useState<string>(() => {
    if (typeof window === 'undefined') return '';
    return window.localStorage.getItem('ejclaw-nickname') ?? '';
  });
  function setNickname(next: string) {
    const trimmed = next.trim().slice(0, 32);
    setNicknameState(trimmed);
    persistNickname(trimmed);
  }
  const t = messages[locale];
  const secureContext =
    typeof window === 'undefined' ? true : window.isSecureContext;

  function setDashboardLocale(nextLocale: Locale) {
    setLocale(nextLocale);
    window.localStorage.setItem(LOCALE_STORAGE_KEY, nextLocale);
  }

  function navigateToView(view: DashboardView) {
    setActiveView(view);
    if (window.location.hash !== `#/${view}`) {
      window.location.hash = `/${view}`;
    }
  }

  async function refresh(showSpinner = false) {
    if (showSpinner) setRefreshing(true);
    try {
      const nextData = await fetchDashboardData();
      setData(nextData);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  async function handleTaskAction(
    task: DashboardTask,
    action: DashboardTaskAction,
  ) {
    if (action === 'cancel' && !window.confirm(t.tasks.actions.confirmCancel)) {
      return;
    }

    const actionKey: TaskActionKey = `${task.id}:${action}`;
    setTaskActionKey(actionKey);
    try {
      await runScheduledTaskAction(task.id, action);
      await refresh(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTaskActionKey(null);
    }
  }

  async function handleTaskCreate(input: CreateScheduledTaskInput) {
    setTaskActionKey('create');
    try {
      await createScheduledTask({ ...input, requestId: makeClientRequestId() });
      await refresh(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTaskActionKey(null);
    }
  }

  async function handleTaskUpdate(
    task: DashboardTask,
    input: UpdateScheduledTaskInput,
  ) {
    const actionKey: TaskActionKey = `${task.id}:edit`;
    setTaskActionKey(actionKey);
    try {
      await updateScheduledTask(task.id, input);
      await refresh(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTaskActionKey(null);
    }
  }

  async function handleInboxAction(
    item: InboxItem,
    action: DashboardInboxAction,
  ) {
    if (
      action === 'decline' &&
      typeof window !== 'undefined' &&
      !window.confirm(t.inbox.actions.confirmDecline)
    ) {
      return;
    }

    const actionKey: InboxActionKey = `${item.id}:${action}`;
    setInboxActionKey(actionKey);
    try {
      await runInboxAction(item.id, action, {
        lastOccurredAt: item.lastOccurredAt,
        requestId: makeClientRequestId(),
      });
      await refresh(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setInboxActionKey(null);
    }
  }

  async function handleServiceRestart() {
    if (
      typeof window !== 'undefined' &&
      !window.confirm(t.health.confirmRestart)
    ) {
      return;
    }

    setServiceActionKey('stack:restart');
    try {
      await runServiceAction('stack', 'restart', {
        requestId: makeClientRequestId(),
      });
      await refresh(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setServiceActionKey(null);
    }
  }

  async function handleRoomMessage(
    roomJid: string,
    text: string,
    requestId: string,
  ) {
    setRoomMessageKey(roomJid);
    const optimisticId = `opt:${requestId}`;
    const displayName = nickname || 'Web Dashboard';
    const optimisticMsg = {
      id: optimisticId,
      sender: 'me',
      senderName: displayName,
      content: text,
      timestamp: new Date().toISOString(),
      isFromMe: true,
      isBotMessage: false,
      sourceKind: 'human' as const,
    };
    setPendingMessages((prev) => ({
      ...prev,
      [roomJid]: [...(prev[roomJid] ?? []), optimisticMsg],
    }));
    try {
      await sendRoomMessage(roomJid, text, requestId, nickname || null);
      try {
        await refreshRoomActivity(roomJid);
      } catch {
        /* refresh will retry on next poll */
      }
      void refresh(false);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPendingMessages((prev) => {
        const list = prev[roomJid];
        if (!list) return prev;
        const next = list.filter((m) => m.id !== optimisticId);
        if (next.length === 0) {
          const { [roomJid]: _drop, ...rest } = prev;
          void _drop;
          return rest;
        }
        return { ...prev, [roomJid]: next };
      });
      return false;
    } finally {
      setRoomMessageKey(null);
    }
  }

  async function handleInstallApp() {
    if (!installPrompt) return;
    await installPrompt.prompt();
    await installPrompt.userChoice;
    setInstallPrompt(null);
    setInstalled(isStandaloneDisplay());
  }

  useEffect(() => {
    document.documentElement.lang = localeTags[locale];
  }, [locale]);

  useEffect(() => {
    const debug =
      typeof window !== 'undefined' &&
      /[?&]debug=1/.test(window.location.search);
    document.body.classList.toggle('debug-outlines', debug);
    if (
      typeof window !== 'undefined' &&
      /[?&]measure=1/.test(window.location.search)
    ) {
      const tick = () => {
        const sels = [
          '.rooms-detail .room-card-v2',
          '.room-card-head',
          '.room-thread-section',
          '.room-section.room-compose-section',
        ];
        const out = sels
          .map((s) => {
            const el = document.querySelector(s);
            if (!el) return `${s}: NOT FOUND`;
            const r = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            return `${s}:\n  x=${Math.round(r.x)} w=${Math.round(r.width)}\n  display=${cs.display} pl=${cs.paddingLeft} ml=${cs.marginLeft}`;
          })
          .join('\n');
        let pre = document.getElementById('__measure');
        if (!pre) {
          pre = document.createElement('pre');
          pre.id = '__measure';
          pre.style.cssText =
            'position:fixed;top:0;left:0;background:#fff;color:#000;font:11px monospace;padding:8px;z-index:99999;max-width:520px;white-space:pre;line-height:1.4;';
          document.body.appendChild(pre);
        }
        pre.textContent = out;
      };
      const id = window.setTimeout(tick, 1500);
      return () => window.clearTimeout(id);
    }
    return undefined;
  });

  useEffect(() => {
    function handleOnline() {
      setOnline(true);
    }

    function handleOffline() {
      setOnline(false);
    }

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  useEffect(() => {
    if (!import.meta.env.PROD || !canUsePwaCore()) {
      setOfflineReady(false);
      return;
    }

    let cancelled = false;
    void navigator.serviceWorker
      .register('/sw.js')
      .then((registration) => {
        if (!cancelled) {
          setOfflineReady(
            Boolean(
              registration.active ||
              registration.waiting ||
              registration.installing,
            ),
          );
        }
        return navigator.serviceWorker.ready;
      })
      .then(() => {
        if (!cancelled) setOfflineReady(true);
      })
      .catch(() => {
        if (!cancelled) setOfflineReady(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    function handleBeforeInstallPrompt(event: Event) {
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPromptEvent);
    }

    function handleInstalled() {
      setInstalled(true);
      setInstallPrompt(null);
    }

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleInstalled);
    return () => {
      window.removeEventListener(
        'beforeinstallprompt',
        handleBeforeInstallPrompt,
      );
      window.removeEventListener('appinstalled', handleInstalled);
    };
  }, []);

  useEffect(() => {
    function handleHashChange() {
      setActiveView(readViewFromHash());
    }

    handleHashChange();
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => {
      void refresh();
    }, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    setPendingMessages((prev) => {
      const next: typeof prev = {};
      let changed = false;
      for (const [jid, list] of Object.entries(prev)) {
        const fetched = roomActivity[jid]?.messages ?? [];
        const confirmedKeys = new Set(
          fetched.map((m) => `${m.senderName}${m.content}`),
        );
        const remaining = list.filter(
          (m) => !confirmedKeys.has(`${m.senderName}${m.content}`),
        );
        if (remaining.length !== list.length) changed = true;
        if (remaining.length > 0) next[jid] = remaining;
      }
      return changed ? next : prev;
    });
  }, [roomActivity]);

  useEffect(() => {
    if (!drawerOpen) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setDrawerOpen(false);
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [drawerOpen]);

  if (loading && !data) {
    return <LoadingSkeleton t={t} />;
  }

  const roomOptions = data ? buildRoomOptions(data.snapshots) : [];
  const freshness = dashboardFreshness(online, data?.overview.generatedAt);
  const canInstall = Boolean(secureContext && installPrompt && !installed);

  return (
    <div className="shell">
      <SideRail
        activeView={activeView}
        canInstall={canInstall}
        data={data}
        installed={installed}
        offlineReady={offlineReady}
        online={online}
        onInstall={() => void handleInstallApp()}
        onNavigate={navigateToView}
        onRefresh={() => void refresh(true)}
        refreshing={refreshing}
        secureContext={secureContext}
        t={t}
      />
      <main className="dashboard-content">
        <SectionNav
          activeView={activeView}
          canInstall={canInstall}
          data={data}
          drawerOpen={drawerOpen}
          freshness={freshness}
          freshnessText={freshnessLabel(freshness, t)}
          installed={installed}
          onCloseDrawer={() => setDrawerOpen(false)}
          onInstall={() => void handleInstallApp()}
          onNavigate={navigateToView}
          onOpenDrawer={() => setDrawerOpen(true)}
          offlineReady={offlineReady}
          onRefresh={() => void refresh(true)}
          online={online}
          refreshing={refreshing}
          secureContext={secureContext}
          t={t}
        />

        {error ? (
          <DashboardErrorCard
            error={error}
            onRetry={() => void refresh(true)}
            refreshing={refreshing}
            t={t}
          />
        ) : null}

        {data ? (
          <div className={`view-stack view-${activeView}`}>
            {activeView === 'usage' ? (
              <>
                <section className="panel usage-first" id="usage">
                  <div className="panel-title">
                    <h2>{t.panels.usage}</h2>
                    <span>{t.panels.usageWindow}</span>
                  </div>
                  <UsagePanel overview={data.overview} t={t} />
                </section>
                <ControlRail
                  canInstall={canInstall}
                  data={data}
                  installed={installed}
                  locale={locale}
                  offlineReady={offlineReady}
                  online={online}
                  onInstall={() => void handleInstallApp()}
                  secureContext={secureContext}
                  t={t}
                />
              </>
            ) : null}

            {activeView === 'inbox' ? (
              <section className="panel view-panel" id="inbox">
                <div className="panel-title">
                  <h2>{t.panels.inbox}</h2>
                  <span>{t.panels.inboxQueue}</span>
                </div>
                <InboxPanel
                  inboxActionKey={inboxActionKey}
                  locale={locale}
                  onInboxAction={(item, action) =>
                    void handleInboxAction(item, action)
                  }
                  onTaskAction={(task, action) =>
                    void handleTaskAction(task, action)
                  }
                  overview={data.overview}
                  taskActionKey={taskActionKey}
                  tasks={data.tasks}
                  t={t}
                />
              </section>
            ) : null}

            {activeView === 'health' ? (
              <section className="panel view-panel" id="health">
                <div className="panel-title">
                  <h2>{t.panels.health}</h2>
                  <span>{t.panels.healthSignals}</span>
                </div>
                <ServicePanel
                  formatDuration={formatDuration}
                  locale={locale}
                  onRestartStack={() => void handleServiceRestart()}
                  overview={data.overview}
                  serviceActionKey={serviceActionKey}
                  snapshots={data.snapshots}
                  t={t}
                />
              </section>
            ) : null}

            {activeView === 'rooms' ? (
              <section className="panel view-panel" id="rooms">
                <div className="panel-title">
                  <h2>{t.panels.rooms}</h2>
                  <span>{t.panels.queue}</span>
                </div>
                <RoomBoardV2
                  {...ROOM_BOARD_FORMATTERS}
                  createRequestId={makeClientRequestId}
                  inbox={data.overview.inbox}
                  locale={locale}
                  onSelectedJidChange={setSelectedRoomJid}
                  onSendRoomMessage={handleRoomMessage}
                  pendingMessages={pendingMessages}
                  roomActivity={roomActivity}
                  roomActivityLoading={roomActivityLoading}
                  roomMessageKey={roomMessageKey}
                  selectedJid={selectedRoomJid}
                  snapshots={data.snapshots}
                  t={t}
                />
              </section>
            ) : null}

            {activeView === 'scheduled' ? (
              <section className="panel view-panel" id="scheduled">
                <div className="panel-title">
                  <h2>{t.panels.scheduled}</h2>
                  <span>{t.panels.promptPreviews}</span>
                </div>
                <TaskPanel
                  locale={locale}
                  onTaskAction={(task, action) =>
                    void handleTaskAction(task, action)
                  }
                  onTaskCreate={(input) => void handleTaskCreate(input)}
                  onTaskUpdate={(task, input) =>
                    void handleTaskUpdate(task, input)
                  }
                  rooms={roomOptions}
                  taskActionKey={taskActionKey}
                  tasks={data.tasks}
                  t={t}
                />
              </section>
            ) : null}

            {activeView === 'settings' ? (
              <section className="panel view-panel" id="settings">
                <div className="panel-title">
                  <h2>{t.settings.title}</h2>
                </div>
                <SettingsPanel
                  locale={locale}
                  nickname={nickname}
                  onLocaleChange={setDashboardLocale}
                  onNicknameChange={setNickname}
                  onRestartStack={() => void handleServiceRestart()}
                  t={t}
                />
              </section>
            ) : null}
          </div>
        ) : null}
      </main>
    </div>
  );
}

export default App;
