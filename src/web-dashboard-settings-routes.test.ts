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
    getActiveCodexSettingsIndex: () => 1,
    getFastMode: () => fastMode,
    getModelConfig: () => modelConfig,
    listClaudeAccounts: () => [makeClaudeAccount()],
    listCodexAccounts: () => [makeCodexAccount()],
    refreshAllCodexAccounts: async () => ({ refreshed: [1], failed: [] }),
    refreshCodexAccount: async () => makeCodexAccount(),
    removeAccountDirectory: () => undefined,
    setActiveCodexSettingsIndex: () => undefined,
    updateFastMode: () => fastMode,
    updateModelConfig: () => modelConfig,
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
    expect(calls).toEqual([
      'models:{"owner":{"model":"gpt-5.5"}}',
      'add:claude-token',
      'delete:codex:4',
      'current:4',
    ]);
  });
});
