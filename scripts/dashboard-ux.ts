import { AxeBuilder } from '@axe-core/playwright';
import { chromium, type Browser, type Page, type Route } from 'playwright';
import assert from 'node:assert/strict';
import path from 'node:path';
import process from 'node:process';
import { createServer, type ViteDevServer } from 'vite';

interface MockApiState {
  approvalAction: boolean;
  codexFeatures: { goals: boolean };
  codexFeatureUpdates: number;
  ciWatcherFailures: number;
  restartRequests: number;
  roomSkillUpdates: number;
  roomSkillsDisableCodexBrowser: boolean;
}

const seriousImpacts = new Set(['serious', 'critical']);
const MOCK_TIME = new Date(0).toISOString();

async function main() {
  const server = await startDashboardServer();
  const browser = await chromium.launch();

  try {
    const baseUrl = server.resolvedUrls?.local[0] ?? 'http://127.0.0.1:5175/';

    await runScenario(
      'settings nav keeps hash route stable',
      browser,
      baseUrl,
      async (page, state) => {
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

        await openSettingsSection(page, 'settings-runtime');
        assert.equal(page.url(), originalUrl);
        await assertVisible(page.locator('#settings-runtime'));
        await page.getByText('Runtime inventory').waitFor();
        await page.getByText('EJClaw bridge').waitFor();
        const codexPolicy = page
          .locator('.runtime-room-agent-policy')
          .filter({ hasText: 'Codex' })
          .first();
        const codexBrowserToggle = codexPolicy
          .locator('input[type="checkbox"]')
          .first();
        assert.equal(await codexBrowserToggle.isChecked(), true);
        await codexBrowserToggle.click();
        await codexPolicy.getByText('1개 OFF').waitFor();
        assert.equal(state.roomSkillUpdates, 1);

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
        await openSettingsSection(page, 'settings-codex');

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
      'rooms surface user action badges without inbox navigation',
      browser,
      baseUrl,
      async (page, state) => {
        state.approvalAction = true;
        state.ciWatcherFailures = 2;

        await page.goto(new URL('/#/inbox', baseUrl).toString(), {
          waitUntil: 'networkidle',
        });

        await page.waitForURL(/#\/rooms$/);
        await assertVisible(page.locator('#rooms .rooms-v2'));
        assert.equal(await page.locator('a[href="#/inbox"]').count(), 0);
        assert.equal(await page.locator('a[href="#/health"]').count(), 0);
        await assertVisible(page.getByText(/승인|Approval/).first());
        await assertVisible(page.locator('.system-status-strip'));
        assert.equal(
          await page.getByRole('button', { name: 'Dismiss' }).count(),
          0,
        );

        // This scenario protects the Inbox information architecture. The
        // accessibility scan stays scoped to Settings, where this UX suite
        // currently has stable interactive coverage.
      },
    );

    await runScheduledBoardScenario(browser, baseUrl);

    await runScenario(
      'health route redirects to rooms and degraded state is conditional',
      browser,
      baseUrl,
      async (page, state) => {
        state.approvalAction = true;

        await page.goto(new URL('/#/rooms', baseUrl).toString(), {
          waitUntil: 'networkidle',
        });
        await assertVisible(page.locator('#rooms .rooms-v2'));
        assert.equal(await page.locator('.system-status-strip').count(), 0);

        state.ciWatcherFailures = 2;
        await page.goto(new URL('/?degraded=1#/health', baseUrl).toString(), {
          waitUntil: 'networkidle',
        });

        await page.waitForURL(/#\/rooms$/);
        await assertVisible(page.locator('#rooms .rooms-v2'));
        await assertVisible(page.locator('.system-status-strip'));
        assert.equal(await page.locator('#health').count(), 0);
        assert.equal(await page.locator('a[href="#/health"]').count(), 0);
        await assertVisible(page.getByText(/CI 실패|CI failure/).first());
      },
    );

    console.log('dashboard:ux passed');
  } finally {
    await browser.close();
    await server.close();
  }
}

async function runScheduledBoardScenario(browser: Browser, baseUrl: string) {
  await runScenario(
    'scheduled board surfaces next task without empty lanes',
    browser,
    baseUrl,
    async (page) => {
      await page.goto(new URL('/#/scheduled', baseUrl).toString(), {
        waitUntil: 'networkidle',
      });

      await assertVisible(page.locator('#scheduled .task-command-center'));
      await assertVisible(page.locator('#scheduled .task-create-form'));
      await assertVisible(page.getByText('Nightly cleanup').first());
      await assertVisible(page.getByText('*/15 * * * *').first());
      assert.equal(await page.locator('#scheduled .task-card').count(), 3);
      assert.equal(
        await page.locator('#scheduled .task-group-empty').count(),
        0,
      );
    },
  );
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
    approvalAction: false,
    codexFeatures: { goals: false },
    codexFeatureUpdates: 0,
    ciWatcherFailures: 0,
    restartRequests: 0,
    roomSkillUpdates: 0,
    roomSkillsDisableCodexBrowser: false,
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

async function openSettingsSection(page: Page, targetId: string) {
  await page
    .locator(`.settings-nav button[data-settings-target="${targetId}"]`)
    .click();
  await assertVisible(page.locator(`#${targetId}`));
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
    await fulfillJson(route, mockOverview(state));
    return;
  }

  if (method === 'GET' && url.pathname === '/api/status-snapshots') {
    await fulfillJson(
      route,
      state.approvalAction ? [mockStatusSnapshot()] : [],
    );
    return;
  }

  if (method === 'GET' && url.pathname === '/api/tasks') {
    await fulfillJson(route, mockTasks());
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

  if (method === 'GET' && url.pathname === '/api/settings/runtime-inventory') {
    await fulfillJson(route, runtimeInventoryFixture());
    return;
  }

  if (await handleMockRoomSkillRoute(route, state, url, method)) {
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

async function handleMockRoomSkillRoute(
  route: Route,
  state: MockApiState,
  url: URL,
  method: string,
): Promise<boolean> {
  if (url.pathname !== '/api/settings/room-skills') return false;
  if (method === 'GET') {
    await fulfillJson(route, roomSkillSettingsFixture(state));
    return true;
  }
  if (method !== 'PATCH' && method !== 'PUT') return false;

  const body = parseJsonBody(route.request().postData());
  if (
    body.roomJid === 'room@example' &&
    body.agentType === 'codex' &&
    body.skillId === 'codex-user:agent-browser' &&
    body.enabled === false
  ) {
    state.roomSkillUpdates += 1;
    state.roomSkillsDisableCodexBrowser = true;
  }
  await fulfillJson(route, roomSkillSettingsFixture(state));
  return true;
}

function mockOverview(state: MockApiState) {
  return {
    generatedAt: MOCK_TIME,
    services: [
      {
        serviceId: 'codex-main',
        assistantName: 'Codex',
        agentType: 'codex',
        updatedAt: MOCK_TIME,
        totalRooms: state.approvalAction ? 1 : 0,
        activeRooms: 0,
      },
    ],
    rooms: state.approvalAction
      ? { total: 1, active: 0, waiting: 0, inactive: 1 }
      : { total: 0, active: 0, waiting: 0, inactive: 0 },
    tasks: {
      total: 0,
      active: 0,
      paused: state.ciWatcherFailures,
      completed: 0,
      watchers: { active: 0, paused: state.ciWatcherFailures, completed: 0 },
    },
    usage: { rows: [], fetchedAt: null },
    operations: { serviceRestarts: [] },
    inbox: state.approvalAction ? [mockApprovalInboxItem()] : [],
  };
}

function mockApprovalInboxItem() {
  return {
    id: 'paired:merge-1:merge_ready',
    groupKey: 'paired:merge-1:merge_ready',
    kind: 'approval',
    severity: 'warn',
    title: 'Ready to merge',
    summary: 'merge_ready',
    occurredAt: MOCK_TIME,
    lastOccurredAt: MOCK_TIME,
    createdAt: MOCK_TIME,
    occurrences: 1,
    source: 'paired-task',
    roomJid: 'dc:ops',
    roomName: '#ops',
    groupFolder: 'ops',
    serviceId: 'codex-main',
    taskId: 'merge-1',
    taskStatus: 'merge_ready',
  };
}

function mockStatusSnapshot() {
  return {
    serviceId: 'codex-main',
    assistantName: 'Codex',
    agentType: 'codex',
    updatedAt: MOCK_TIME,
    entries: [
      {
        jid: 'dc:ops',
        name: '#ops',
        folder: 'ops',
        agentType: 'codex',
        status: 'inactive',
        elapsedMs: null,
        pendingMessages: false,
        pendingTasks: 0,
      },
    ],
  };
}

function mockTask(overrides: Record<string, unknown>) {
  return {
    agentType: 'codex',
    chatJid: 'room@example',
    ciMetadata: null,
    ciProvider: null,
    contextMode: 'group',
    createdAt: MOCK_TIME,
    groupFolder: 'ejclaw',
    id: 'task-fixture',
    isWatcher: false,
    lastResult: 'ok',
    lastRun: MOCK_TIME,
    nextRun: new Date(Date.now() + 30 * 60_000).toISOString(),
    promptLength: 28,
    promptPreview: 'Nightly cleanup',
    scheduleType: 'cron',
    scheduleValue: '*/15 * * * *',
    status: 'active',
    suspendedUntil: null,
    ...overrides,
  };
}

function mockTasks() {
  return [
    mockTask({ id: 'task-nightly-cleanup' }),
    mockTask({
      ciProvider: 'github',
      id: 'task-ci-watch',
      isWatcher: true,
      promptPreview: 'Watch PR #133',
      scheduleType: 'interval',
      scheduleValue: '5m',
    }),
    mockTask({
      id: 'task-paused-report',
      nextRun: null,
      promptPreview: 'Weekly report',
      scheduleValue: '0 9 * * 1',
      status: 'paused',
      suspendedUntil: new Date(Date.now() + 2 * 3_600_000).toISOString(),
    }),
  ];
}

function runtimeSkill(name: string, description: string, skillPath: string) {
  return { name, description, path: skillPath };
}

function runtimeInventoryFixture() {
  const codexConfig = {
    label: 'Codex config.toml',
    path: '/home/.codex/config.toml',
    exists: true,
  };
  const claudeSettings = {
    label: 'Claude settings.json',
    path: '/home/.claude/settings.json',
    exists: true,
  };

  return {
    generatedAt: '2026-05-04T00:00:00.000Z',
    projectRoot: '/repo',
    dataDir: '/repo/data',
    service: {
      id: 'codex-main',
      sessionScope: 'codex-main',
      agentType: 'codex',
    },
    codex: {
      configFiles: [
        codexConfig,
        {
          label: 'Codex auth.json',
          path: '/home/.codex/auth.json',
          exists: true,
        },
      ],
      skillDirs: [
        {
          label: 'Codex user skills',
          path: '/home/.agents/skills',
          exists: true,
          count: 1,
          skills: [
            runtimeSkill(
              'agent-browser',
              'Browser automation',
              '/home/.agents/skills/agent-browser',
            ),
          ],
        },
      ],
      mcp: { configPath: codexConfig, ejclawConfigured: true, serverCount: 1 },
    },
    claude: {
      configFiles: [claudeSettings],
      skillDirs: [
        {
          label: 'Claude user skills',
          path: '/home/.claude/skills',
          exists: true,
          count: 1,
          skills: [
            runtimeSkill(
              'review-helper',
              'Review workflow',
              '/home/.claude/skills/review-helper',
            ),
          ],
        },
      ],
      mcp: {
        configPath: claudeSettings,
        ejclawConfigured: false,
        serverCount: 0,
      },
    },
    ejclaw: {
      runnerSkillDir: {
        label: 'EJClaw runner skills',
        path: '/repo/runners/skills',
        exists: true,
        count: 1,
        skills: [
          runtimeSkill(
            'agent-browser',
            'Browser automation',
            '/repo/runners/skills/agent-browser',
          ),
        ],
      },
      mcpServer: {
        label: 'EJClaw IPC MCP server',
        path: '/repo/runners/agent-runner/dist/ipc-mcp-stdio.js',
        exists: true,
      },
    },
  };
}

function roomSkillSettingsFixture(state?: MockApiState) {
  const codexDisabled = state?.roomSkillsDisableCodexBrowser === true;
  return {
    generatedAt: '2026-05-04T00:00:00.000Z',
    catalog: [
      {
        id: 'codex-user:agent-browser',
        scope: 'codex-user',
        name: 'agent-browser',
        displayName: 'agent-browser',
        description: 'Browser automation',
        path: '/home/.agents/skills/agent-browser',
        agentTypes: ['codex'],
      },
      {
        id: 'claude-user:review-helper',
        scope: 'claude-user',
        name: 'review-helper',
        displayName: 'review-helper',
        description: 'Review workflow',
        path: '/home/.claude/skills/review-helper',
        agentTypes: ['claude-code'],
      },
      {
        id: 'runner:agent-browser',
        scope: 'runner',
        name: 'agent-browser',
        displayName: 'agent-browser',
        description: 'Browser automation',
        path: '/repo/runners/skills/agent-browser',
        agentTypes: ['claude-code', 'codex'],
      },
    ],
    rooms: [
      {
        jid: 'room@example',
        name: 'EJClaw',
        folder: 'ejclaw',
        roomMode: 'tribunal',
        agents: [
          {
            agentType: 'codex',
            mode: codexDisabled ? 'custom' : 'all-enabled',
            availableSkillIds: [
              'codex-user:agent-browser',
              'runner:agent-browser',
            ],
            disabledSkillIds: codexDisabled ? ['codex-user:agent-browser'] : [],
            explicitEnabledSkillIds: [],
            effectiveEnabledSkillIds: codexDisabled
              ? ['runner:agent-browser']
              : ['codex-user:agent-browser', 'runner:agent-browser'],
          },
          {
            agentType: 'claude-code',
            mode: 'custom',
            availableSkillIds: [
              'claude-user:review-helper',
              'runner:agent-browser',
            ],
            disabledSkillIds: ['claude-user:review-helper'],
            explicitEnabledSkillIds: [],
            effectiveEnabledSkillIds: ['runner:agent-browser'],
          },
        ],
      },
    ],
  };
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
