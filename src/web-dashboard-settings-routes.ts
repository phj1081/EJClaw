import {
  addClaudeAccountFromToken,
  getActiveCodexSettingsIndex,
  getFastMode,
  getModelConfig,
  listClaudeAccounts,
  listCodexAccounts,
  refreshAllCodexAccounts,
  refreshCodexAccount,
  removeAccountDirectory,
  setActiveCodexSettingsIndex,
  updateFastMode,
  updateModelConfig,
  type ClaudeAccountSummary,
  type CodexAccountSummary,
  type FastModeSnapshot,
  type ModelConfigSnapshot,
} from './settings-store.js';

type JsonResponse = (
  value: unknown,
  init?: ResponseInit,
  request?: Request,
) => Response;

export interface SettingsRouteDependencies {
  addClaudeAccountFromToken: typeof addClaudeAccountFromToken;
  getActiveCodexSettingsIndex: typeof getActiveCodexSettingsIndex;
  getFastMode: typeof getFastMode;
  getModelConfig: typeof getModelConfig;
  listClaudeAccounts: typeof listClaudeAccounts;
  listCodexAccounts: typeof listCodexAccounts;
  refreshAllCodexAccounts: typeof refreshAllCodexAccounts;
  refreshCodexAccount: typeof refreshCodexAccount;
  removeAccountDirectory: typeof removeAccountDirectory;
  setActiveCodexSettingsIndex: typeof setActiveCodexSettingsIndex;
  updateFastMode: typeof updateFastMode;
  updateModelConfig: typeof updateModelConfig;
}

interface SettingsRouteContext {
  url: URL;
  request: Request;
  jsonResponse: JsonResponse;
  deps?: SettingsRouteDependencies;
}

const defaultSettingsRouteDependencies: SettingsRouteDependencies = {
  addClaudeAccountFromToken,
  getActiveCodexSettingsIndex,
  getFastMode,
  getModelConfig,
  listClaudeAccounts,
  listCodexAccounts,
  refreshAllCodexAccounts,
  refreshCodexAccount,
  removeAccountDirectory,
  setActiveCodexSettingsIndex,
  updateFastMode,
  updateModelConfig,
};

function readMethod(method: string): boolean {
  return method === 'GET' || method === 'HEAD';
}

async function readJsonObject(
  request: Request,
  jsonResponse: JsonResponse,
): Promise<Record<string, unknown> | Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return jsonResponse(
      { error: 'Body must be a JSON object' },
      { status: 400 },
    );
  }
  return body as Record<string, unknown>;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function handleModelSettingsRoute(
  request: Request,
  jsonResponse: JsonResponse,
  deps: SettingsRouteDependencies,
): Promise<Response | null> {
  if (readMethod(request.method)) return jsonResponse(deps.getModelConfig());
  if (request.method !== 'PUT' && request.method !== 'PATCH') return null;

  const body = await readJsonObject(request, jsonResponse);
  if (body instanceof Response) return body;
  try {
    return jsonResponse(deps.updateModelConfig(body));
  } catch (err) {
    return jsonResponse({ error: errorMessage(err) }, { status: 500 });
  }
}

async function handleFastModeRoute(
  request: Request,
  jsonResponse: JsonResponse,
  deps: SettingsRouteDependencies,
): Promise<Response | null> {
  if (readMethod(request.method)) return jsonResponse(deps.getFastMode());
  if (request.method !== 'PUT' && request.method !== 'PATCH') return null;

  const body = await readJsonObject(request, jsonResponse);
  if (body instanceof Response) return body;
  try {
    return jsonResponse(deps.updateFastMode(body));
  } catch (err) {
    return jsonResponse({ error: errorMessage(err) }, { status: 500 });
  }
}

function handleAccountsRoute(
  request: Request,
  jsonResponse: JsonResponse,
  deps: SettingsRouteDependencies,
): Response | null {
  if (!readMethod(request.method)) return null;
  return jsonResponse({
    claude: deps.listClaudeAccounts(),
    codex: deps.listCodexAccounts(),
    codexCurrentIndex: deps.getActiveCodexSettingsIndex(),
  });
}

async function handleClaudeAccountAddRoute(
  request: Request,
  jsonResponse: JsonResponse,
  deps: SettingsRouteDependencies,
): Promise<Response | null> {
  if (request.method !== 'POST') return null;

  let body: { token?: unknown };
  try {
    body = (await request.json()) as { token?: unknown };
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const token = typeof body?.token === 'string' ? body.token.trim() : '';
  if (!token)
    return jsonResponse({ error: 'token is required' }, { status: 400 });

  try {
    const result = deps.addClaudeAccountFromToken(token);
    return jsonResponse({ ok: true, ...result });
  } catch (err) {
    return jsonResponse({ error: errorMessage(err) }, { status: 400 });
  }
}

function handleAccountDeleteRoute(
  request: Request,
  accountMatch: RegExpMatchArray,
  jsonResponse: JsonResponse,
  deps: SettingsRouteDependencies,
): Response | null {
  if (request.method !== 'DELETE') return null;
  const provider = accountMatch[1] as 'claude' | 'codex';
  const index = Number.parseInt(accountMatch[2], 10);
  try {
    deps.removeAccountDirectory(provider, index);
    return jsonResponse({ ok: true, provider, index });
  } catch (err) {
    return jsonResponse({ error: errorMessage(err) }, { status: 400 });
  }
}

async function handleCodexRefreshRoute(
  request: Request,
  refreshMatch: RegExpMatchArray,
  jsonResponse: JsonResponse,
  deps: SettingsRouteDependencies,
): Promise<Response | null> {
  if (request.method !== 'POST') return null;
  const index = Number.parseInt(refreshMatch[1], 10);
  try {
    const updated = await deps.refreshCodexAccount(index);
    return jsonResponse({ ok: true, account: updated });
  } catch (err) {
    return jsonResponse({ error: errorMessage(err) }, { status: 400 });
  }
}

async function handleCodexRefreshAllRoute(
  request: Request,
  jsonResponse: JsonResponse,
  deps: SettingsRouteDependencies,
): Promise<Response | null> {
  if (request.method !== 'POST') return null;
  try {
    const result = await deps.refreshAllCodexAccounts();
    return jsonResponse({ ok: true, ...result });
  } catch (err) {
    return jsonResponse({ error: errorMessage(err) }, { status: 500 });
  }
}

async function handleCodexCurrentRoute(
  request: Request,
  jsonResponse: JsonResponse,
  deps: SettingsRouteDependencies,
): Promise<Response | null> {
  if (request.method !== 'PUT') return null;

  let body: { index?: unknown };
  try {
    body = (await request.json()) as { index?: unknown };
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const idx = typeof body?.index === 'number' ? body.index : Number.NaN;
  if (!Number.isInteger(idx)) {
    return jsonResponse({ error: 'index must be an integer' }, { status: 400 });
  }

  try {
    deps.setActiveCodexSettingsIndex(idx);
    return jsonResponse({
      ok: true,
      codexCurrentIndex: deps.getActiveCodexSettingsIndex(),
    });
  } catch (err) {
    return jsonResponse({ error: errorMessage(err) }, { status: 400 });
  }
}

export async function handleSettingsRoute({
  url,
  request,
  jsonResponse,
  deps = defaultSettingsRouteDependencies,
}: SettingsRouteContext): Promise<Response | null> {
  if (url.pathname === '/api/settings/accounts') {
    return handleAccountsRoute(request, jsonResponse, deps);
  }
  if (url.pathname === '/api/settings/models') {
    return handleModelSettingsRoute(request, jsonResponse, deps);
  }
  if (url.pathname === '/api/settings/fast-mode') {
    return handleFastModeRoute(request, jsonResponse, deps);
  }
  if (url.pathname === '/api/settings/accounts/claude') {
    return handleClaudeAccountAddRoute(request, jsonResponse, deps);
  }
  if (url.pathname === '/api/settings/accounts/codex/refresh-all') {
    return handleCodexRefreshAllRoute(request, jsonResponse, deps);
  }
  if (url.pathname === '/api/settings/accounts/codex/current') {
    return handleCodexCurrentRoute(request, jsonResponse, deps);
  }

  const accountMatch = url.pathname.match(
    /^\/api\/settings\/accounts\/(claude|codex)\/(\d+)$/,
  );
  if (accountMatch) {
    return handleAccountDeleteRoute(request, accountMatch, jsonResponse, deps);
  }

  const refreshMatch = url.pathname.match(
    /^\/api\/settings\/accounts\/codex\/(\d+)\/refresh$/,
  );
  if (refreshMatch) {
    return handleCodexRefreshRoute(request, refreshMatch, jsonResponse, deps);
  }

  return null;
}

export type {
  ClaudeAccountSummary,
  CodexAccountSummary,
  FastModeSnapshot,
  ModelConfigSnapshot,
};
