import { AxeBuilder } from '@axe-core/playwright';
import { chromium, type Browser, type Page, type Route } from 'playwright';
import assert from 'node:assert/strict';
import path from 'node:path';
import process from 'node:process';
import { createServer, type ViteDevServer } from 'vite';

interface MockApiState {
  codexFeatures: { goals: boolean };
  codexFeatureUpdates: number;
  ciWatcherFailures: number;
  restartRequests: number;
}

const seriousImpacts = new Set(['serious', 'critical']);

async function main() {
  const server = await startDashboardServer();
  const browser = await chromium.launch();

  try {
    const baseUrl = server.resolvedUrls?.local[0] ?? 'http://127.0.0.1:5175/';

    await runScenario(
      'settings nav keeps hash route stable',
      browser,
      baseUrl,
      async (page) => {
        await openSettings(page, baseUrl);

        const originalUrl = page.url();
        assert.equal(originalUrl.endsWith('/#/settings'), true);
        assert.equal(
          await page.locator('.settings-nav a[href^="#settings-"]').count(),
          0,
        );

        await page
          .locator(
            '.settings-nav button[data-settings-target="settings-codex"]',
          )
          .click();
        await page.waitForTimeout(150);
        assert.equal(page.url(), originalUrl);
        await assertVisible(page.locator('.settings-panel'));
        await assertVisible(page.locator('#settings-codex'));

        await page
          .locator(
            '.settings-nav button[data-settings-target="settings-accounts"]',
          )
          .click();
        await page.waitForTimeout(150);
        assert.equal(page.url(), originalUrl);
        await assertVisible(page.locator('.settings-panel'));
        await assertVisible(page.locator('#settings-accounts'));

        await assertNoSeriousA11yViolations(page);
      },
    );

    await runScenario(
      'codex goal toggle persists and explains restart',
      browser,
      baseUrl,
      async (page, state) => {
        await openSettings(page, baseUrl);

        const goalToggle = page.getByRole('checkbox', { name: /\/goal/ });
        await assertVisible(goalToggle);
        assert.equal(await goalToggle.isChecked(), false);

        await goalToggle.click();
        await page
          .getByText('저장됨. 적용하려면 상단의 스택 재시작을 눌러 주세요.')
          .waitFor();

        assert.equal(await goalToggle.isChecked(), true);
        assert.equal(state.codexFeatures.goals, true);
        assert.equal(state.codexFeatureUpdates, 1);

        await assertNoSeriousA11yViolations(page);
      },
    );

    await runScenario(
      'restart action is singular and guarded',
      browser,
      baseUrl,
      async (page, state) => {
        const dialogMessages: string[] = [];
        page.on('dialog', async (dialog) => {
          dialogMessages.push(dialog.message());
          await dialog.accept();
        });

        await openSettings(page, baseUrl);

        const restartButtons = page.getByRole('button', {
          name: '스택 재시작',
        });
        assert.equal(await restartButtons.count(), 1);

        await restartButtons.first().click();
        await page.waitForTimeout(250);

        assert.equal(dialogMessages.length, 1);
        assert.equal(state.restartRequests, 1);

        await assertNoSeriousA11yViolations(page);
      },
    );

    await runScenario(
      'inbox stays focused on actionable work',
      browser,
      baseUrl,
      async (page, state) => {
        state.ciWatcherFailures = 2;

        await page.goto(new URL('/#/inbox', baseUrl).toString(), {
          waitUntil: 'networkidle',
        });

        await assertVisible(page.locator('#inbox .empty-state'));
        assert.equal(await page.getByText(/CI 실패|CI failure/).count(), 0);
        assert.equal(
          await page.getByRole('button', { name: 'Dismiss' }).count(),
          0,
        );

        // This scenario protects the Inbox information architecture. The
        // accessibility scan stays scoped to Settings, where this UX suite
        // currently has stable interactive coverage.
      },
    );

    console.log('dashboard:ux passed');
  } finally {
    await browser.close();
    await server.close();
  }
}

async function startDashboardServer(): Promise<ViteDevServer> {
  const port = Number(process.env.DASHBOARD_UX_PORT ?? 5175);
  const server = await createServer({
    configFile: path.resolve('apps/dashboard/vite.config.ts'),
    server: {
      host: '127.0.0.1',
      port,
      strictPort: true,
    },
  });
  await server.listen();
  return server;
}

async function runScenario(
  name: string,
  browser: Browser,
  baseUrl: string,
  run: (page: Page, state: MockApiState) => Promise<void>,
) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });
  const state = createMockApiState();
  await context.route('**/api/**', (route) => handleMockApi(route, state));
  const page = await context.newPage();

  try {
    await run(page, state);
    console.log(`✓ ${name}`);
  } finally {
    await context.close();
  }
}

function createMockApiState(): MockApiState {
  return {
    codexFeatures: { goals: false },
    codexFeatureUpdates: 0,
    ciWatcherFailures: 0,
    restartRequests: 0,
  };
}

async function openSettings(page: Page, baseUrl: string) {
  await page.goto(new URL('/#/settings', baseUrl).toString(), {
    waitUntil: 'networkidle',
  });
  await assertVisible(page.locator('.settings-panel'));
  assert.equal(await page.locator('.settings-hero').count(), 0);
  await assertVisible(page.locator('.settings-sidebar'));
  await assertVisible(page.locator('.settings-nav'));
  await assertVisible(page.locator('.settings-apply-card'));
  assert.equal(
    await page.getByRole('button', { name: '스택 재시작' }).count(),
    1,
  );
}

async function assertVisible(locator: ReturnType<Page['locator']>) {
  await locator.waitFor({ state: 'visible', timeout: 5_000 });
}

async function assertNoSeriousA11yViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .include('.settings-panel')
    .analyze();
  const serious = results.violations.filter((violation) =>
    seriousImpacts.has(violation.impact ?? ''),
  );

  assert.deepEqual(
    serious.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      nodes: violation.nodes.map((node) => node.target),
    })),
    [],
  );
}

async function handleMockApi(route: Route, state: MockApiState) {
  const request = route.request();
  const url = new URL(request.url());
  const method = request.method();

  if (method === 'GET' && url.pathname === '/api/overview') {
    await fulfillJson(route, {
      generatedAt: new Date(0).toISOString(),
      services: [],
      rooms: { total: 0, active: 0, waiting: 0, inactive: 0 },
      tasks: {
        total: 0,
        active: 0,
        paused: state.ciWatcherFailures,
        completed: 0,
        watchers: { active: 0, paused: state.ciWatcherFailures, completed: 0 },
      },
      usage: { rows: [], fetchedAt: null },
      operations: { serviceRestarts: [] },
      inbox: [],
    });
    return;
  }

  if (method === 'GET' && url.pathname === '/api/status-snapshots') {
    await fulfillJson(route, []);
    return;
  }

  if (method === 'GET' && url.pathname === '/api/tasks') {
    await fulfillJson(route, []);
    return;
  }

  if (method === 'GET' && url.pathname === '/api/rooms-timeline') {
    await fulfillJson(route, {});
    return;
  }

  if (method === 'GET' && url.pathname === '/api/settings/models') {
    await fulfillJson(route, {
      owner: { model: 'codex', effort: 'high' },
      reviewer: { model: 'claude', effort: 'medium' },
      arbiter: { model: 'claude', effort: 'medium' },
    });
    return;
  }

  if (method === 'GET' && url.pathname === '/api/settings/fast-mode') {
    await fulfillJson(route, { codex: false, claude: false });
    return;
  }

  if (url.pathname === '/api/settings/codex-features') {
    if (method === 'GET') {
      await fulfillJson(route, state.codexFeatures);
      return;
    }
    if (method === 'PUT' || method === 'PATCH') {
      const body = parseJsonBody(request.postData());
      if (typeof body.goals === 'boolean') {
        state.codexFeatures = { goals: body.goals };
        state.codexFeatureUpdates += 1;
      }
      await fulfillJson(route, state.codexFeatures);
      return;
    }
  }

  if (method === 'GET' && url.pathname === '/api/settings/moa') {
    await fulfillJson(route, {
      enabled: true,
      referenceModels: ['kimi', 'glm'],
      models: [
        {
          name: 'kimi',
          enabled: true,
          model: 'kimi-k2',
          baseUrl: 'https://api.moonshot.ai',
          apiFormat: 'anthropic',
          apiKeyConfigured: true,
          lastStatus: null,
        },
        {
          name: 'glm',
          enabled: true,
          model: 'glm-4.6',
          baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
          apiFormat: 'anthropic',
          apiKeyConfigured: true,
          lastStatus: null,
        },
      ],
    });
    return;
  }

  if (method === 'GET' && url.pathname === '/api/settings/accounts') {
    await fulfillJson(route, {
      claude: [
        {
          index: 0,
          expiresAt: null,
          scopes: [],
          subscriptionType: 'pro',
          rateLimitTier: 'default',
          exists: true,
        },
      ],
      codex: [
        {
          index: 0,
          accountId: 'acct_test',
          email: 'codex@example.com',
          planType: 'plus',
          subscriptionUntil: '2099-01-01T00:00:00.000Z',
          subscriptionLastChecked: '2026-01-01T00:00:00.000Z',
          exists: true,
        },
      ],
      codexCurrentIndex: 0,
    });
    return;
  }

  if (method === 'POST' && url.pathname === '/api/services/stack/actions') {
    state.restartRequests += 1;
    await fulfillJson(route, {
      ok: true,
      restart: {
        id: 'restart-test',
        target: 'stack',
        requestedAt: new Date(0).toISOString(),
        completedAt: null,
        status: 'running',
        services: ['ejclaw'],
      },
    });
    return;
  }

  await fulfillJson(
    route,
    { error: `Unhandled mock route ${method} ${url.pathname}` },
    404,
  );
}

function parseJsonBody(body: string | null): Record<string, unknown> {
  if (!body) return {};
  const parsed = JSON.parse(body) as unknown;
  return parsed && typeof parsed === 'object'
    ? (parsed as Record<string, unknown>)
    : {};
}

async function fulfillJson(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

await main();
