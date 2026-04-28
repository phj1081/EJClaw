import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { DashboardOverview } from './api';
import { messages } from './i18n';
import { UsagePanel, type UsagePanelProps } from './UsagePanel';

const t = messages.en;

function overview(rows: DashboardOverview['usage']['rows']): DashboardOverview {
  return {
    generatedAt: '2026-04-28T04:00:00.000Z',
    inbox: [],
    operations: { serviceRestarts: [] },
    rooms: { active: 0, inactive: 0, total: 0, waiting: 0 },
    services: [],
    tasks: {
      active: 0,
      completed: 0,
      paused: 0,
      total: 0,
      watchers: { active: 0, completed: 0, paused: 0 },
    },
    usage: { fetchedAt: '2026-04-28T04:00:00.000Z', rows },
  };
}

const baseProps: UsagePanelProps = {
  overview: overview([
    {
      d7pct: 88,
      d7reset: '2d',
      h5pct: 52,
      h5reset: '1h',
      name: '*Claude max',
    },
    {
      d7pct: 12,
      d7reset: '',
      h5pct: 45,
      h5reset: '3h',
      name: 'codex-pro mid',
    },
  ]),
  t,
};

describe('UsagePanel', () => {
  it('renders grouped usage rows, quota remaining, and risk labels', () => {
    const html = renderToStaticMarkup(createElement(UsagePanel, baseProps));

    expect(html).toContain(t.usage.groupPrimary);
    expect(html).toContain(t.usage.groupCodex);
    expect(html).toContain('Claude');
    expect(html).toContain('codex-pro');
    expect(html).toContain(t.usage.inUse);
    expect(html).toContain(t.usage.risk.critical);
    expect(html).toContain('12%');
    expect(html).toContain('48%');
    expect(html).toContain('10%/h');
  });

  it('renders an empty state without usage rows', () => {
    const html = renderToStaticMarkup(
      createElement(UsagePanel, { ...baseProps, overview: overview([]) }),
    );

    expect(html).toContain(t.usage.empty);
  });
});
