import { useEffect, useState } from 'react';

import {
  type MoaModelSettingsSnapshot,
  type MoaReferenceStatus,
  type MoaSettingsSnapshot,
  checkMoaModel,
  fetchMoaSettings,
  updateMoaSettings,
} from './api';
import { type Messages } from './i18n';
import { SettingsSaveBar, SettingsSectionHeading } from './SettingsPanelChrome';

export function MoaSettingsPanel({ t }: { t: Messages }) {
  const [config, setConfig] = useState<MoaSettingsSnapshot | null>(null);
  const [draft, setDraft] = useState<MoaSettingsSnapshot | null>(null);
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const section = t.settings.sections.moa;

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    fetchMoaSettings()
      .then((next) => {
        if (cancelled) return;
        setConfig(next);
        setDraft(next);
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

  function setModel(name: string, patch: Partial<MoaModelSettingsSnapshot>) {
    setDraft((prev) =>
      prev
        ? {
            ...prev,
            models: prev.models.map((model) =>
              model.name === name ? { ...model, ...patch } : model,
            ),
          }
        : prev,
    );
  }

  function updateStatus(name: string, status: MoaReferenceStatus) {
    const update = (prev: MoaSettingsSnapshot | null) =>
      prev
        ? {
            ...prev,
            models: prev.models.map((model) =>
              model.name === name ? { ...model, lastStatus: status } : model,
            ),
          }
        : prev;
    setConfig(update);
    setDraft(update);
  }

  async function save() {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      const next = await updateMoaSettings({
        enabled: draft.enabled,
        models: draft.models.map((model) => ({
          name: model.name,
          enabled: model.enabled,
          model: model.model,
          baseUrl: model.baseUrl,
          apiFormat: model.apiFormat,
          apiKey: apiKeys[model.name]?.trim() || undefined,
        })),
      });
      setConfig(next);
      setDraft(next);
      setApiKeys({});
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function testModel(name: string) {
    setChecking(name);
    setError(null);
    try {
      updateStatus(name, await checkMoaModel(name));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setChecking(null);
    }
  }

  const dirty =
    draft !== null &&
    config !== null &&
    (JSON.stringify(draft) !== JSON.stringify(config) ||
      Object.values(apiKeys).some((value) => value.trim()));

  return (
    <section
      aria-labelledby="settings-moa-tab"
      className="settings-section"
      id="settings-moa"
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
          {busy ? t.settings.common.loading : t.settings.moa.empty}
        </p>
      ) : (
        <MoaSettingsContent
          apiKeys={apiKeys}
          busy={busy}
          checking={checking}
          dirty={dirty}
          draft={draft}
          onApiKeyChange={(name, value) =>
            setApiKeys((prev) => ({ ...prev, [name]: value }))
          }
          onModelChange={setModel}
          onSave={save}
          onTest={testModel}
          onToggle={() =>
            setDraft((prev) =>
              prev ? { ...prev, enabled: !prev.enabled } : prev,
            )
          }
          savedAt={savedAt}
          t={t}
        />
      )}
    </section>
  );
}

function MoaSettingsContent({
  apiKeys,
  busy,
  checking,
  dirty,
  draft,
  onApiKeyChange,
  onModelChange,
  onSave,
  onTest,
  onToggle,
  savedAt,
  t,
}: {
  apiKeys: Record<string, string>;
  busy: boolean;
  checking: string | null;
  dirty: boolean;
  draft: MoaSettingsSnapshot;
  onApiKeyChange: (name: string, value: string) => void;
  onModelChange: (
    name: string,
    patch: Partial<MoaModelSettingsSnapshot>,
  ) => void;
  onSave: () => Promise<void>;
  onTest: (name: string) => Promise<void>;
  onToggle: () => void;
  savedAt: number | null;
  t: Messages;
}) {
  return (
    <>
      <MoaMasterToggle
        busy={busy}
        enabled={draft.enabled}
        onToggle={onToggle}
        t={t}
      />
      <ul className="settings-moa-list">
        {draft.models.map((model) => (
          <MoaModelRow
            apiKeyValue={apiKeys[model.name] ?? ''}
            busy={busy}
            checking={checking}
            dirty={dirty}
            key={model.name}
            model={model}
            onApiKeyChange={onApiKeyChange}
            onModelChange={onModelChange}
            onTest={onTest}
            t={t}
          />
        ))}
      </ul>
      <SettingsSaveBar
        busy={busy || checking !== null}
        dirty={dirty}
        label={t.settings.moa.save}
        onSave={() => void onSave()}
        savedHint={t.settings.common.savedRestartHint}
        savingLabel={t.settings.common.saving}
        showSavedHint={savedAt !== null && !dirty}
      />
    </>
  );
}

function formatMoaStatus(
  status: MoaReferenceStatus | null,
  t: Messages,
): string {
  if (!status) return t.settings.moa.notTested;
  const at = new Date(status.checkedAt);
  const checkedAt = Number.isNaN(at.getTime())
    ? status.checkedAt
    : at.toLocaleString('ko-KR');
  if (status.ok) {
    return `${t.settings.moa.statusOk} · ${checkedAt}`;
  }
  return `${t.settings.moa.statusFail} · ${checkedAt} · ${status.error ?? 'unknown error'}`;
}

function MoaMasterToggle({
  busy,
  enabled,
  onToggle,
  t,
}: {
  busy: boolean;
  enabled: boolean;
  onToggle: () => void;
  t: Messages;
}) {
  return (
    <label className="settings-toggle-row">
      <span className="settings-toggle-label">
        <span className="settings-toggle-title">{t.settings.moa.master}</span>
        <small className="settings-hint">{t.settings.moa.masterHint}</small>
      </span>
      <input
        checked={enabled}
        disabled={busy}
        onChange={onToggle}
        type="checkbox"
      />
    </label>
  );
}

function MoaModelRow({
  apiKeyValue,
  busy,
  checking,
  dirty,
  model,
  onApiKeyChange,
  onModelChange,
  onTest,
  t,
}: {
  apiKeyValue: string;
  busy: boolean;
  checking: string | null;
  dirty: boolean;
  model: MoaModelSettingsSnapshot;
  onApiKeyChange: (name: string, value: string) => void;
  onModelChange: (
    name: string,
    patch: Partial<MoaModelSettingsSnapshot>,
  ) => void;
  onTest: (name: string) => Promise<void>;
  t: Messages;
}) {
  return (
    <li className="settings-moa-card">
      <header className="settings-moa-card-head">
        <label className="settings-moa-name">
          <input
            checked={model.enabled}
            disabled={busy}
            onChange={() =>
              onModelChange(model.name, { enabled: !model.enabled })
            }
            type="checkbox"
          />
          <span className="settings-account-tag">{model.name}</span>
        </label>
        <span
          className={`settings-account-badge ${
            model.lastStatus?.ok === false ? 'is-expired' : 'is-active'
          }`}
          title={model.lastStatus?.error ?? undefined}
        >
          {formatMoaStatus(model.lastStatus, t)}
        </span>
      </header>
      <div className="settings-moa-fields">
        <label className="settings-row">
          <span className="settings-label">{t.settings.moa.modelLabel}</span>
          <input
            aria-label={`${model.name} MoA model`}
            onChange={(e) =>
              onModelChange(model.name, { model: e.target.value })
            }
            placeholder="model"
            type="text"
            value={model.model}
          />
        </label>
        <label className="settings-row">
          <span className="settings-label">{t.settings.moa.baseUrlLabel}</span>
          <input
            aria-label={`${model.name} MoA base URL`}
            onChange={(e) =>
              onModelChange(model.name, { baseUrl: e.target.value })
            }
            placeholder="https://…"
            type="text"
            value={model.baseUrl}
          />
        </label>
        <label className="settings-row">
          <span className="settings-label">{t.settings.moa.formatLabel}</span>
          <select
            aria-label={`${model.name} MoA API format`}
            onChange={(e) =>
              onModelChange(model.name, {
                apiFormat: e.target.value as 'openai' | 'anthropic',
              })
            }
            value={model.apiFormat}
          >
            <option value="anthropic">anthropic</option>
            <option value="openai">openai</option>
          </select>
        </label>
        <label className="settings-row">
          <span className="settings-label">API key</span>
          <input
            aria-label={`${model.name} MoA API key`}
            onChange={(e) => onApiKeyChange(model.name, e.target.value)}
            placeholder={
              model.apiKeyConfigured
                ? t.settings.moa.apiKeySet
                : t.settings.moa.apiKeyPlaceholder
            }
            type="password"
            value={apiKeyValue}
          />
        </label>
      </div>
      <div className="settings-account-actions">
        <button
          className="settings-secondary"
          disabled={
            busy || checking !== null || dirty || !model.apiKeyConfigured
          }
          onClick={() => void onTest(model.name)}
          type="button"
        >
          {checking === model.name
            ? t.settings.moa.testing
            : dirty
              ? t.settings.moa.testAfterSave
              : t.settings.moa.test}
        </button>
      </div>
    </li>
  );
}
