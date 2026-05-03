import { LOCALES, languageNames, type Locale, type Messages } from './i18n';

export const SETTINGS_NAV_ITEMS = [
  { targetId: 'settings-general', title: '일반', detail: '표시 · 언어' },
  {
    targetId: 'settings-models',
    title: '모델',
    detail: 'owner · reviewer · arbiter',
  },
  {
    targetId: 'settings-runtime',
    title: '런타임',
    detail: 'skills · MCP · config',
  },
  { targetId: 'settings-moa', title: 'MoA', detail: '참조 모델 · 연결 테스트' },
  { targetId: 'settings-codex', title: 'Codex', detail: 'fast mode · /goal' },
  { targetId: 'settings-accounts', title: '계정', detail: 'Claude · Codex' },
] as const;

export type SettingsSectionId = (typeof SETTINGS_NAV_ITEMS)[number]['targetId'];

export function SettingsNav({
  activeSection,
  onSelect,
}: {
  activeSection: SettingsSectionId;
  onSelect: (section: SettingsSectionId) => void;
}) {
  return (
    <div className="settings-nav" aria-label="설정 섹션" role="tablist">
      {SETTINGS_NAV_ITEMS.map((item) => (
        <button
          aria-controls={item.targetId}
          aria-selected={activeSection === item.targetId}
          data-settings-target={item.targetId}
          id={`${item.targetId}-tab`}
          key={item.targetId}
          onClick={() => onSelect(item.targetId)}
          role="tab"
          type="button"
        >
          <strong>{item.title}</strong>
          <small>{item.detail}</small>
        </button>
      ))}
    </div>
  );
}

export function GeneralSettings({
  locale,
  nickname,
  onLocaleChange,
  onNicknameChange,
  t,
}: {
  locale: Locale;
  nickname: string;
  onLocaleChange: (locale: Locale) => void;
  onNicknameChange: (next: string) => void;
  t: Messages;
}) {
  return (
    <section
      aria-labelledby="settings-general-tab"
      className="settings-section"
      id="settings-general"
      role="tabpanel"
    >
      <SettingsSectionHeading
        detail="Dashboard identity"
        title="일반"
        description="브라우저에서 보이는 이름과 언어만 즉시 바뀝니다."
      />
      <div className="settings-form-grid">
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
      </div>
    </section>
  );
}

export function SettingsSectionHeading({
  detail,
  title,
  description,
}: {
  detail: string;
  title: string;
  description: string;
}) {
  return (
    <header className="settings-section-head">
      <span>{detail}</span>
      <h3>{title}</h3>
      <p>{description}</p>
    </header>
  );
}

export function SettingsApplyCard({
  onRestartStack,
}: {
  onRestartStack: () => void;
}) {
  return (
    <section className="settings-apply-card" aria-label="변경 적용">
      <div>
        <span className="settings-kicker">Apply</span>
        <strong>저장 후 재시작</strong>
        <small>모델, MoA, Codex, 계정 변경은 스택 재시작 후 반영됩니다.</small>
      </div>
      <button
        className="settings-restart"
        onClick={onRestartStack}
        type="button"
      >
        스택 재시작
      </button>
    </section>
  );
}
