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
import {
  formatDateTime,
  formatJwtCacheExpiry,
  formatLiveStatusBadge,
  formatUsageBadge,
} from './codexAccountBadges';
import { type Locale, type Messages } from './i18n';
import { MoaSettingsPanel } from './MoaSettingsPanel';
import { RuntimeInventorySettings } from './RuntimeInventorySettings';
import {
  ModelRoleFields,
  hasUnsupportedModelEffort,
  type ModelRole,
} from './SettingsModelFields';
import {
  GeneralSettings,
  SettingsApplyCard,
  SettingsCard,
  SettingsNav,
  SettingsSaveBar,
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
        <aside className="settings-sidebar" aria-label={t.settings.sidebarAria}>
          <SettingsNav
            activeSection={activeSection}
            onSelect={setActiveSection}
            t={t}
          />
          <SettingsApplyCard onRestartStack={onRestartStack} t={t} />
        </aside>
        <main className="settings-content" aria-label={t.settings.contentAria}>
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
            <ModelSettings t={t} />
          </div>

          <div hidden={activeSection !== 'settings-runtime'}>
            <RuntimeInventorySettings t={t} />
          </div>

          <div hidden={activeSection !== 'settings-moa'}>
            <MoaSettingsPanel t={t} />
          </div>

          <div hidden={activeSection !== 'settings-codex'}>
            <CodexRuntimeSettings t={t} />
          </div>

          <div hidden={activeSection !== 'settings-accounts'}>
            <AccountSettings t={t} />
          </div>
        </main>
      </div>
    </div>
  );
}

function ModelSettings({ t }: { t: Messages }) {
  const [config, setConfig] = useState<ModelConfigSnapshot | null>(null);
  const [draft, setDraft] = useState<ModelConfigSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const section = t.settings.sections.models;

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
    if (hasUnsupportedModelEffort(draft)) {
      setError(t.settings.models.effortSaveBlocked);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const next = await updateModels({
        owner: draft.owner,
        reviewer: draft.reviewer,
        arbiter: draft.arbiter,
      });
      setConfig(next);
      setDraft(next);
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function setRole(role: ModelRole, patch: Partial<ModelRoleConfig>) {
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
  const effortBlocked = draft !== null && hasUnsupportedModelEffort(draft);

  return (
    <section
      aria-labelledby="settings-models-tab"
      className="settings-section"
      id="settings-models"
      role="tabpanel"
    >
      <SettingsSectionHeading
        description={section.description}
        detail={section.kicker}
        title={section.title}
      />
      {error ? <p className="settings-error">{error}</p> : null}
      {!draft ? (
        <p className="settings-hint">
          {busy ? t.settings.common.loading : t.settings.models.empty}
        </p>
      ) : (
        <>
          <ModelRoleFields
            draft={draft}
            onChange={(role, patch) => setRole(role, patch)}
            t={t}
          />
          <SettingsSaveBar
            busy={busy}
            dirty={dirty}
            label={t.settings.models.save}
            onSave={() => void save()}
            saveDisabled={effortBlocked}
            savedHint={t.settings.common.savedRestartHint}
            savingLabel={t.settings.common.saving}
            showSavedHint={savedAt !== null && !dirty}
          />
        </>
      )}
    </section>
  );
}

function CodexRuntimeSettings({ t }: { t: Messages }) {
  const section = t.settings.sections.codex;

  return (
    <section
      aria-labelledby="settings-codex-tab"
      className="settings-section"
      id="settings-codex"
      role="tabpanel"
    >
      <SettingsSectionHeading
        description={section.description}
        detail={section.kicker}
        title={section.title}
      />
      <div className="settings-section-stack">
        <FastModeSettings t={t} />
        <CodexFeatureSettings t={t} />
      </div>
    </section>
  );
}

function FastModeSettings({ t }: { t: Messages }) {
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
    <SettingsCard title={t.settings.codex.fastMode}>
      {error ? <p className="settings-error">{error}</p> : null}
      {!state ? (
        <p className="settings-hint">{t.settings.common.loading}</p>
      ) : (
        <div className="settings-toggle-stack">
          <label className="settings-toggle-row">
            <span className="settings-toggle-label">
              <span className="settings-toggle-title">
                {t.settings.codex.codexFast}
              </span>
              <small className="settings-hint">
                {t.settings.codex.codexFastHint}
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
              <span className="settings-toggle-title">
                {t.settings.codex.claudeFast}
              </span>
              <small className="settings-hint">
                {t.settings.codex.claudeFastHint}
              </small>
            </span>
            <input
              checked={state.claude}
              disabled={busy}
              onChange={() => void toggle('claude')}
              type="checkbox"
            />
          </label>
          <small className="settings-hint">
            {t.settings.codex.fastModeApplyHint}
          </small>
        </div>
      )}
    </SettingsCard>
  );
}

function CodexFeatureSettings({ t }: { t: Messages }) {
  const [state, setState] = useState<CodexFeatureSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    } catch (err) {
      setState(previous);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsCard title={t.settings.codex.features}>
      {error ? <p className="settings-error">{error}</p> : null}
      {!state ? (
        <p className="settings-hint">{t.settings.common.loading}</p>
      ) : (
        <>
          <label className="settings-toggle-row">
            <span className="settings-toggle-label">
              <span className="settings-toggle-title">
                {t.settings.codex.goal}
              </span>
              <small className="settings-hint">
                {t.settings.codex.goalHint}
              </small>
            </span>
            <input
              checked={state.goals}
              disabled={busy}
              onChange={() => void toggleGoals()}
              type="checkbox"
            />
          </label>
          <small className="settings-hint">
            {t.settings.codex.goalApplyHint}
          </small>
        </>
      )}
    </SettingsCard>
  );
}

function AccountSettings({ t }: { t: Messages }) {
  const [data, setData] = useState<AccountData | null>(null);
  const [busy, setBusy] = useState(false);
  const [perRowBusy, setPerRowBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tokenInput, setTokenInput] = useState('');
  const section = t.settings.sections.accounts;

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
        t.settings.accounts.deleteConfirm
          .replace('{provider}', provider)
          .replace('{index}', String(index)),
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
          t.settings.accounts.refreshFailed.replace(
            '{indexes}',
            result.failed.map((f) => `#${f.index}`).join(', '),
          ),
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
        description={section.description}
        detail={section.kicker}
        title={section.title}
      />
      {error ? <p className="settings-error">{error}</p> : null}
      <div className="settings-section-stack">
        <ClaudeAccounts
          busy={busy}
          data={data}
          onAdd={() => void handleAdd()}
          onDelete={(index) => void handleDelete('claude', index)}
          onTokenInputChange={setTokenInput}
          t={t}
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
          t={t}
        />
      </div>
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
  t,
}: {
  busy: boolean;
  data: AccountData | null;
  onAdd: () => void;
  onDelete: (index: number) => void;
  onTokenInputChange: (value: string) => void;
  tokenInput: string;
  t: Messages;
}) {
  return (
    <SettingsCard title={t.settings.accounts.claude}>
      {!data ? (
        <p className="settings-hint">
          {busy ? t.settings.common.loading : t.settings.common.none}
        </p>
      ) : data.claude.length === 0 ? (
        <p className="settings-hint">{t.settings.accounts.noAccounts}</p>
      ) : (
        <ul className="settings-account-list">
          {data.claude.map((acc) => (
            <li key={acc.index}>
              <article
                className={`settings-account-row${acc.index === 0 ? ' is-primary' : ''}`}
              >
                <div className="settings-account-row-main">
                  <span className="settings-account-index">#{acc.index}</span>
                  <div className="settings-account-row-copy">
                    <strong>{acc.subscriptionType ?? 'unknown'}</strong>
                    <span className="settings-hint">
                      {acc.rateLimitTier ?? 'claude-code'}
                      {' · '}
                      {t.settings.accounts.autoRefresh}
                    </span>
                  </div>
                  {acc.index === 0 ? (
                    <span className="settings-pill is-primary is-compact">
                      {t.settings.accounts.primaryAccount}
                    </span>
                  ) : null}
                </div>
                {acc.index > 0 ? (
                  <div className="settings-account-actions">
                    <button
                      className="settings-delete"
                      disabled={busy}
                      onClick={() => onDelete(acc.index)}
                      type="button"
                    >
                      {t.settings.common.delete}
                    </button>
                  </div>
                ) : null}
              </article>
            </li>
          ))}
        </ul>
      )}
      <div className="settings-add-token">
        <label className="settings-row">
          <span className="settings-label">
            {t.settings.accounts.addTokenLabel}
          </span>
          <textarea
            onChange={(e) => onTokenInputChange(e.target.value)}
            placeholder={t.settings.accounts.tokenPlaceholder}
            rows={2}
            value={tokenInput}
          />
        </label>
        <button
          className="settings-save"
          disabled={!tokenInput.trim() || busy}
          onClick={onAdd}
          type="button"
        >
          {t.settings.common.add}
        </button>
      </div>
    </SettingsCard>
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
  t,
}: {
  busy: boolean;
  data: AccountData | null;
  onDelete: (index: number) => void;
  onRefresh: (index: number) => void;
  onRefreshAll: () => void;
  onSwitch: (index: number) => void;
  perRowBusy: string | null;
  t: Messages;
}) {
  return (
    <SettingsCard
      actions={
        <button
          className="settings-secondary"
          disabled={busy}
          onClick={onRefreshAll}
          type="button"
        >
          {t.settings.common.refreshAll}
        </button>
      }
      description={t.settings.accounts.codexRefreshHint}
      title={t.settings.accounts.codex}
    >
      {!data ? (
        <p className="settings-hint">
          {busy ? t.settings.common.loading : t.settings.common.none}
        </p>
      ) : data.codex.length === 0 ? (
        <p className="settings-hint">{t.settings.accounts.noAccounts}</p>
      ) : (
        <ul className="settings-account-list">
          {data.codex.map((acc) => (
            <li key={acc.index}>
              <CodexAccountRow
                acc={acc}
                busy={busy}
                isActive={data.codexCurrentIndex === acc.index}
                onDelete={onDelete}
                onRefresh={onRefresh}
                onSwitch={onSwitch}
                perRowBusy={perRowBusy}
                t={t}
              />
            </li>
          ))}
        </ul>
      )}
    </SettingsCard>
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
  t,
}: {
  acc: CodexAccountSummary;
  busy: boolean;
  isActive: boolean;
  onDelete: (index: number) => void;
  onRefresh: (index: number) => void;
  onSwitch: (index: number) => void;
  perRowBusy: string | null;
  t: Messages;
}) {
  const liveBadge = formatLiveStatusBadge(acc.liveStatus);
  const usageBadge = formatUsageBadge(acc.liveStatus);
  const cachedExpiry = acc.liveStatus
    ? null
    : formatJwtCacheExpiry(acc.subscriptionUntil);
  const checkedAt = acc.subscriptionLastChecked
    ? formatDateTime(acc.subscriptionLastChecked)
    : null;
  const refreshing = perRowBusy === `refresh:${acc.index}`;
  const switching = perRowBusy === `switch:${acc.index}`;

  return (
    <article
      className={`settings-account-row${isActive ? ' is-active-account' : ''}`}
    >
      <div className="settings-account-row-main">
        <span className="settings-account-index">#{acc.index}</span>
        <div className="settings-account-row-copy">
          <strong>{acc.email ?? acc.planType ?? 'Codex account'}</strong>
          <span className="settings-account-row-meta">
            <span className="settings-account-plan">
              {acc.planType ?? 'unknown'}
            </span>
            {liveBadge ? (
              <span
                className={`settings-account-badge ${liveBadge.cls}`}
                title={liveBadge.title}
              >
                {liveBadge.label}
              </span>
            ) : cachedExpiry ? (
              <span
                className={`settings-account-badge ${cachedExpiry.cls}`}
                title={cachedExpiry.title}
              >
                {cachedExpiry.label}
              </span>
            ) : null}
            {usageBadge ? (
              <span
                className="settings-account-badge is-muted"
                title={usageBadge.title}
              >
                {usageBadge.label}
              </span>
            ) : null}
            {checkedAt ? (
              <span
                className="settings-account-badge is-muted"
                title={
                  acc.liveStatus
                    ? 'wham/usage live checked_at'
                    : 'JWT subscription_last_checked cache'
                }
              >
                {t.settings.common.refresh} {checkedAt}
              </span>
            ) : null}
          </span>
        </div>
        {isActive ? (
          <span className="settings-pill is-active is-compact">
            {t.settings.accounts.activeAccount}
          </span>
        ) : null}
      </div>
      <div className="settings-account-actions">
        <button
          className="settings-secondary"
          disabled={busy || perRowBusy !== null}
          onClick={() => onRefresh(acc.index)}
          title={t.settings.accounts.refreshTitle}
          type="button"
        >
          {refreshing
            ? t.settings.common.refreshing
            : t.settings.common.refresh}
        </button>
        {!isActive ? (
          <button
            className="settings-secondary"
            disabled={busy || perRowBusy !== null}
            onClick={() => onSwitch(acc.index)}
            title={t.settings.accounts.switchTitle}
            type="button"
          >
            {switching ? t.settings.common.switching : t.settings.common.switch}
          </button>
        ) : null}
        {acc.index > 0 ? (
          <button
            className="settings-delete"
            disabled={busy || perRowBusy !== null}
            onClick={() => onDelete(acc.index)}
            type="button"
          >
            {t.settings.common.delete}
          </button>
        ) : null}
      </div>
    </article>
  );
}
