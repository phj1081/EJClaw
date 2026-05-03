import { useEffect, useState } from 'react';

import {
  type MoaModelSettingsSnapshot,
  type MoaReferenceStatus,
  type MoaSettingsSnapshot,
  checkMoaModel,
  fetchMoaSettings,
  updateMoaSettings,
} from './api';

export function MoaSettingsPanel() {
  const [config, setConfig] = useState<MoaSettingsSnapshot | null>(null);
  const [draft, setDraft] = useState<MoaSettingsSnapshot | null>(null);
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

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
      <header className="settings-section-head">
        <span>Arbiter references</span>
        <h3>MoA 참조 모델</h3>
        <p>Kimi, GLM 같은 외부 참조 모델을 켜고 연결 상태를 바로 확인합니다.</p>
      </header>
      {error ? <p className="settings-error">{error}</p> : null}
      {!draft ? (
        <p className="settings-hint">
          {busy ? '불러오는 중…' : 'MoA 설정 없음'}
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
}) {
  return (
    <>
      <MoaMasterToggle
        busy={busy}
        enabled={draft.enabled}
        onToggle={onToggle}
      />
      <ul className="settings-account-list">
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
          />
        ))}
      </ul>
      <MoaSettingsActions
        busy={busy}
        checking={checking}
        dirty={dirty}
        onSave={onSave}
        savedAt={savedAt}
      />
    </>
  );
}

function formatMoaStatus(status: MoaReferenceStatus | null): string {
  if (!status) return '연결 테스트 전';
  const at = new Date(status.checkedAt);
  const checkedAt = Number.isNaN(at.getTime())
    ? status.checkedAt
    : at.toLocaleString('ko-KR');
  if (status.ok) return `정상 · ${checkedAt}`;
  return `실패 · ${checkedAt} · ${status.error ?? 'unknown error'}`;
}

function MoaMasterToggle({
  busy,
  enabled,
  onToggle,
}: {
  busy: boolean;
  enabled: boolean;
  onToggle: () => void;
}) {
  return (
    <label className="settings-toggle-row">
      <span className="settings-toggle-label">
        <span className="settings-toggle-title">MoA 사용</span>
        <small className="settings-hint">
          Arbiter 호출 전에 외부 참조 모델 의견을 수집합니다. 저장 후 스택
          재시작이 필요합니다.
        </small>
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

function MoaSettingsActions({
  busy,
  checking,
  dirty,
  onSave,
  savedAt,
}: {
  busy: boolean;
  checking: string | null;
  dirty: boolean;
  onSave: () => Promise<void>;
  savedAt: number | null;
}) {
  return (
    <div className="settings-actions">
      <button
        className="settings-save"
        disabled={!dirty || busy || checking !== null}
        onClick={() => void onSave()}
        type="button"
      >
        {busy ? '저장 중…' : 'MoA 저장'}
      </button>
      {savedAt && !dirty ? (
        <small className="settings-hint">
          저장됨. 적용하려면 상단의 스택 재시작을 눌러 주세요.
        </small>
      ) : null}
    </div>
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
}) {
  return (
    <li className="settings-account-row settings-moa-row">
      <div className="settings-moa-grid">
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
        <input
          aria-label={`${model.name} MoA model`}
          onChange={(e) => onModelChange(model.name, { model: e.target.value })}
          placeholder="model"
          type="text"
          value={model.model}
        />
        <input
          aria-label={`${model.name} MoA base URL`}
          onChange={(e) =>
            onModelChange(model.name, { baseUrl: e.target.value })
          }
          placeholder="base URL"
          type="text"
          value={model.baseUrl}
        />
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
        <input
          aria-label={`${model.name} MoA API key`}
          onChange={(e) => onApiKeyChange(model.name, e.target.value)}
          placeholder={model.apiKeyConfigured ? 'API key set' : 'new API key'}
          type="password"
          value={apiKeyValue}
        />
        <span
          className={`settings-account-badge ${
            model.lastStatus?.ok === false ? 'is-expired' : 'is-active'
          }`}
          title={model.lastStatus?.error ?? undefined}
        >
          {formatMoaStatus(model.lastStatus)}
        </span>
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
            ? '테스트중…'
            : dirty
              ? '저장 후 테스트'
              : '연결 테스트'}
        </button>
      </div>
    </li>
  );
}
