import { describe, expect, it } from 'vitest';

import {
  handleSettingsRoute,
  type SettingsRouteDependencies,
} from './web-dashboard-settings-routes.js';
import type {
  ClaudeAccountSummary,
  CodexAccountSummary,
  FastModeSnapshot,
  ModelConfigSnapshot,
} from './settings-store.js';
import type { MoaSettingsSnapshot } from './settings-store-moa.js';

function jsonResponse(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
}

function request(
  pathname: string,
  method = 'GET',
  body?: Record<string, unknown>,
): Request {
  return new Request(`http://localhost${pathname}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers:
      body === undefined ? undefined : { 'content-type': 'application/json' },
  });
}

const modelConfig: ModelConfigSnapshot = {
  owner: { model: 'gpt-5.4', effort: 'medium' },
  reviewer: { model: 'claude-sonnet', effort: 'high' },
  arbiter: { model: 'gpt-5.4', effort: 'high' },
};

const fastMode: FastModeSnapshot = { codex: true, claude: false };

const moaSettings: MoaSettingsSnapshot = {
  enabled: true,
  referenceModels: ['kimi', 'glm'],
  models: [
    {
      name: 'kimi',
      enabled: true,
      model: 'kimi-k2.6',
      baseUrl: 'https://api.kimi.com/coding',
      apiFormat: 'anthropic',
      apiKeyConfigured: true,
      lastStatus: {
        model: 'kimi',
        checkedAt: '2026-04-30T00:00:00.000Z',
        ok: false,
        error: '402 Payment Required',
      },
    },
    {
      name: 'glm',
      enabled: true,
      model: 'glm-5.1',
      baseUrl: 'https://open.bigmodel.cn/api/anthropic',
      apiFormat: 'anthropic',
      apiKeyConfigured: true,
      lastStatus: null,
    },
  ],
};

function makeClaudeAccount(): ClaudeAccountSummary {
  return {
    index: 0,
    expiresAt: 1777348544000,
    scopes: ['openid'],
    exists: true,
  };
}

function makeCodexAccount(): CodexAccountSummary {
  return {
    index: 1,
    accountId: 'acct_1',
    email: 'codex@example.com',
    planType: 'pro',
    subscriptionUntil: null,
    subscriptionLastChecked: '2026-04-28T08:00:00.000Z',
    exists: true,
  };
}

function makeDeps(
  overrides: Partial<SettingsRouteDependencies> = {},
): SettingsRouteDependencies {
  return {
    addClaudeAccountFromToken: () => ({ index: 2, accountId: null }),
    checkMoaModel: async (name) => ({
      model: name,
      checkedAt: '2026-04-30T00:01:00.000Z',
      ok: true,
      error: null,
      responseLength: 2,
    }),
    getActiveCodexSettingsIndex: () => 1,
    getFastMode: () => fastMode,
    getModelConfig: () => modelConfig,
    getMoaSettings: () => moaSettings,
    listClaudeAccounts: () => [makeClaudeAccount()],
    listCodexAccounts: () => [makeCodexAccount()],
    refreshAllCodexAccounts: async () => ({ refreshed: [1], failed: [] }),
    refreshCodexAccount: async () => makeCodexAccount(),
    removeAccountDirectory: () => undefined,
    setActiveCodexSettingsIndex: () => undefined,
    updateFastMode: () => fastMode,
    updateModelConfig: () => modelConfig,
    updateMoaSettings: () => moaSettings,
    ...overrides,
  };
}

async function route(
  pathname: string,
  method = 'GET',
  body?: Record<string, unknown>,
  deps: SettingsRouteDependencies = makeDeps(),
): Promise<Response | null> {
  return handleSettingsRoute({
    url: new URL(`http://localhost${pathname}`),
    request: request(pathname, method, body),
    jsonResponse,
    deps,
  });
}

describe('web dashboard settings routes', () => {
  it('serves settings snapshots without touching the server router', async () => {
    const accounts = await route('/api/settings/accounts');
    expect(accounts?.status).toBe(200);
    await expect(accounts?.json()).resolves.toMatchObject({
      claude: [{ index: 0, exists: true }],
      codex: [{ index: 1, email: 'codex@example.com' }],
      codexCurrentIndex: 1,
    });

    const models = await route('/api/settings/models');
    expect(models?.status).toBe(200);
    await expect(models?.json()).resolves.toEqual(modelConfig);

    const mode = await route('/api/settings/fast-mode');
    expect(mode?.status).toBe(200);
    await expect(mode?.json()).resolves.toEqual(fastMode);

    const moa = await route('/api/settings/moa');
    expect(moa?.status).toBe(200);
    const moaJson = (await moa?.json()) as MoaSettingsSnapshot;
    expect(moaJson.enabled).toBe(true);
    expect(moaJson.models.find((model) => model.name === 'kimi')).toMatchObject(
      {
        enabled: true,
        lastStatus: { ok: false, error: '402 Payment Required' },
      },
    );

    const unmatched = await route('/api/overview');
    expect(unmatched).toBeNull();
  });

  it('handles settings mutations through injected dependencies', async () => {
    const calls: string[] = [];
    const deps = makeDeps({
      addClaudeAccountFromToken: (token) => {
        calls.push(`add:${token}`);
        return { index: 3, accountId: null };
      },
      removeAccountDirectory: (provider, index) => {
        calls.push(`delete:${provider}:${index}`);
      },
      setActiveCodexSettingsIndex: (index) => {
        calls.push(`current:${index}`);
      },
      updateModelConfig: (input) => {
        calls.push(`models:${JSON.stringify(input)}`);
        return modelConfig;
      },
      updateMoaSettings: (input) => {
        calls.push(`moa:${JSON.stringify(input)}`);
        return moaSettings;
      },
    });

    const modelUpdate = await route(
      '/api/settings/models',
      'PATCH',
      { owner: { model: 'gpt-5.5' } },
      deps,
    );
    expect(modelUpdate?.status).toBe(200);

    const add = await route(
      '/api/settings/accounts/claude',
      'POST',
      { token: '  claude-token  ' },
      deps,
    );
    expect(add?.status).toBe(200);
    await expect(add?.json()).resolves.toMatchObject({ ok: true, index: 3 });

    const del = await route(
      '/api/settings/accounts/codex/4',
      'DELETE',
      undefined,
      deps,
    );
    expect(del?.status).toBe(200);

    const current = await route(
      '/api/settings/accounts/codex/current',
      'PUT',
      { index: 4 },
      deps,
    );
    expect(current?.status).toBe(200);
    await expect(current?.json()).resolves.toMatchObject({
      ok: true,
      codexCurrentIndex: 1,
    });

    const moa = await route(
      '/api/settings/moa',
      'PATCH',
      { enabled: false, models: [{ name: 'kimi', enabled: false }] },
      deps,
    );
    expect(moa?.status).toBe(200);

    const check = await route(
      '/api/settings/moa/check',
      'POST',
      { name: 'glm' },
      deps,
    );
    expect(check?.status).toBe(200);
    await expect(check?.json()).resolves.toMatchObject({
      ok: true,
      status: { model: 'glm', ok: true },
    });

    expect(calls).toEqual([
      'models:{"owner":{"model":"gpt-5.5"}}',
      'add:claude-token',
      'delete:codex:4',
      'current:4',
      'moa:{"enabled":false,"models":[{"name":"kimi","enabled":false}]}',
    ]);
  });
});
