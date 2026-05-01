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
    expect(html).toContain(t.settings.nicknameLabel);
    expect(html).toContain('value="Night Owl"');
    expect(html).toContain(t.settings.languageLabel);
    expect(html).toContain('한국어');
    expect(html).toContain('English');
  });

  it('renders model, MoA, fast mode, and account controls', () => {
    const html = renderToStaticMarkup(createElement(SettingsPanel, baseProps));

    expect(html).toContain('모델');
    expect(html).toContain('MoA 참조 모델');
    expect(html).toContain('패스트 모드');
    expect(html).toContain('Codex 실험 기능');
    expect(html).toContain('변경 적용');
    expect(html).toContain('불러오는 중');
    expect(html).toContain('Claude');
    expect(html).toContain('계정');
    expect(html).toContain('전체 갱신');
    expect(html).toContain('스택 재시작');
    expect(html.match(/class="settings-restart"/g)).toHaveLength(1);
  });
});
