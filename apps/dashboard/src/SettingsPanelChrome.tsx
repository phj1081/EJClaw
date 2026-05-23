import { useState, type ReactNode } from 'react';

import { LOCALES, languageNames, type Locale, type Messages } from './i18n';

export const SETTINGS_NAV_ITEMS = [
  { targetId: 'settings-general', navKey: 'general' },
  { targetId: 'settings-models', navKey: 'models' },
  { targetId: 'settings-runtime', navKey: 'runtime' },
  { targetId: 'settings-moa', navKey: 'moa' },
  { targetId: 'settings-codex', navKey: 'codex' },
  { targetId: 'settings-accounts', navKey: 'accounts' },
] as const;

export type SettingsSectionId = (typeof SETTINGS_NAV_ITEMS)[number]['targetId'];

type SettingsNavKey = (typeof SETTINGS_NAV_ITEMS)[number]['navKey'];

function navItem(t: Messages, navKey: SettingsNavKey) {
  return t.settings.nav[navKey];
}

export function SettingsNav({
  activeSection,
  onSelect,
  t,
}: {
  activeSection: SettingsSectionId;
  onSelect: (section: SettingsSectionId) => void;
  t: Messages;
}) {
  return (
    <div className="settings-nav-scroll">
      <div
        className="settings-nav"
        aria-label={t.settings.navAria}
        role="tablist"
      >
        {SETTINGS_NAV_ITEMS.map((item) => {
          const copy = navItem(t, item.navKey);
          return (
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
              <strong>{copy.title}</strong>
              <small>{copy.detail}</small>
            </button>
          );
        })}
      </div>
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
  const section = t.settings.sections.general;

  return (
    <section
      aria-labelledby="settings-general-tab"
      className="settings-section"
      id="settings-general"
      role="tabpanel"
    >
      <SettingsSectionHeading
        description={section.description}
        detail={section.kicker}
        title={section.title}
      />
      <div className="settings-card">
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

export function SettingsCard({
  title,
  description,
  actions,
  children,
}: {
  title?: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="settings-card">
      {title || description || actions ? (
        <header className="settings-card-head">
          <div>
            {title ? <h4>{title}</h4> : null}
            {description ? (
              <p className="settings-hint">{description}</p>
            ) : null}
          </div>
          {actions ? (
            <div className="settings-card-actions">{actions}</div>
          ) : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}

export function SettingsCollapsible({
  title,
  description,
  defaultOpen = false,
  children,
}: {
  title: string;
  description?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section className={`settings-collapsible${open ? ' is-open' : ''}`}>
      <button
        aria-expanded={open}
        className="settings-collapsible-trigger"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <span className="settings-collapsible-text">
          <strong>{title}</strong>
          {description ? <small>{description}</small> : null}
        </span>
        <span aria-hidden="true" className="settings-collapsible-chevron">
          {open ? '▾' : '▸'}
        </span>
      </button>
      {open ? (
        <div className="settings-collapsible-body">{children}</div>
      ) : null}
    </section>
  );
}

export function SettingsSaveBar({
  busy,
  dirty,
  label,
  savingLabel,
  onSave,
  savedHint,
  showSavedHint,
  saveDisabled = false,
}: {
  busy: boolean;
  dirty: boolean;
  label: string;
  savingLabel: string;
  onSave: () => void;
  savedHint?: string;
  showSavedHint?: boolean;
  saveDisabled?: boolean;
}) {
  return (
    <div className="settings-actions">
      <button
        className="settings-save"
        disabled={!dirty || busy || saveDisabled}
        onClick={onSave}
        type="button"
      >
        {busy ? savingLabel : label}
      </button>
      {showSavedHint && savedHint ? (
        <small className="settings-hint">{savedHint}</small>
      ) : null}
    </div>
  );
}

export function SettingsApplyCard({
  onRestartStack,
  t,
}: {
  onRestartStack: () => void;
  t: Messages;
}) {
  const apply = t.settings.apply;

  return (
    <section aria-label={apply.aria} className="settings-apply-card">
      <div>
        <span className="settings-kicker">{apply.kicker}</span>
        <strong>{apply.title}</strong>
        <small>{apply.hint}</small>
      </div>
      <button
        className="settings-restart"
        onClick={onRestartStack}
        type="button"
      >
        {apply.restart}
      </button>
    </section>
  );
}
