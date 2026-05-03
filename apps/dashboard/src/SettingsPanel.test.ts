import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { messages } from './i18n';
import { SettingsPanel, type SettingsPanelProps } from './SettingsPanel';

const t = messages.en;

const baseProps: SettingsPanelProps = {
  locale: 'en',
  nickname: 'Night Owl',
  onLocaleChange: () => {},
  onNicknameChange: () => {},
  onRestartStack: () => {},
  t,
};

describe('SettingsPanel', () => {
  it('renders general nickname and language settings', () => {
    const html = renderToStaticMarkup(createElement(SettingsPanel, baseProps));

    expect(html).toContain('settings-panel');
    expect(html).not.toContain('settings-hero');
    expect(html).toContain('settings-sidebar');
    expect(html).toContain('settings-nav');
    expect(html).toContain(t.settings.nicknameLabel);
    expect(html).toContain('value="Night Owl"');
    expect(html).toContain(t.settings.languageLabel);
    expect(html).toContain('한국어');
    expect(html).toContain('English');
  });

  it('renders model, runtime, MoA, fast mode, and account controls', () => {
    const html = renderToStaticMarkup(createElement(SettingsPanel, baseProps));

    expect(html).toContain('role="tablist"');
    expect(html).toContain('role="tabpanel"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('data-settings-target="settings-models"');
    expect(html).toContain('data-settings-target="settings-runtime"');
    expect(html).toContain('data-settings-target="settings-moa"');
    expect(html).toContain('data-settings-target="settings-codex"');
    expect(html).toContain('data-settings-target="settings-accounts"');
    expect(html).toContain('aria-controls="settings-runtime"');
    expect(html).toContain('aria-controls="settings-codex"');
    expect(html).not.toContain('href="#settings-codex"');
    expect(html).toContain('settings-apply-card');
    expect(html).not.toContain('settings-apply-bar');
    expect(html).toContain('저장 후 재시작');
    expect(html).toContain('런타임');
    expect(html).toContain('Claude');
    expect(html).toContain('계정');
    expect(html).toContain('스택 재시작');
    expect(html.match(/class="settings-restart"/g)).toHaveLength(1);
  });
});
