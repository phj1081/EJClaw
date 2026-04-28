type JsonResponse = (
  value: unknown,
  init?: ResponseInit,
  request?: Request,
) => Response;

type ServiceAction = 'restart';

interface ServiceActionRequest {
  action: ServiceAction;
  requestId: string | null;
}

export interface ServiceRestartRecord {
  id: string;
  target: 'stack';
  requestedAt: string;
  completedAt: string | null;
  status: 'running' | 'success' | 'failed';
  services: string[];
  error?: string;
}

interface ServiceRouteContext {
  url: URL;
  request: Request;
  jsonResponse: JsonResponse;
  recentServiceRestarts: ServiceRestartRecord[];
  activeServiceRestartTargets: Set<string>;
  restartServiceStack: () => string[];
  now?: () => string;
}

const SERVICE_RESTART_LOG_LIMIT = 20;

function parseServiceActionPath(pathname: string): string | null {
  const match = pathname.match(/^\/api\/services\/([^/]+)\/actions$/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

function isServiceAction(value: unknown): value is ServiceAction {
  return value === 'restart';
}

function sanitizeServiceActionRequestId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const safe = trimmed.replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 120);
  return safe || null;
}

function makeServiceRestartId(requestId: string | null): string {
  return requestId
    ? `web-restart-${requestId}`
    : `web-restart-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function readServiceAction(
  request: Request,
): Promise<ServiceActionRequest | null> {
  try {
    const body = (await request.json()) as {
      action?: unknown;
      requestId?: unknown;
    };
    if (!isServiceAction(body.action)) return null;
    return {
      action: body.action,
      requestId: sanitizeServiceActionRequestId(body.requestId),
    };
  } catch {
    return null;
  }
}

function rememberServiceRestart(
  records: ServiceRestartRecord[],
  record: ServiceRestartRecord,
): void {
  records.unshift(record);
  if (records.length > SERVICE_RESTART_LOG_LIMIT) {
    records.length = SERVICE_RESTART_LOG_LIMIT;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function handleServiceRoute({
  url,
  request,
  jsonResponse,
  recentServiceRestarts,
  activeServiceRestartTargets,
  restartServiceStack,
  now,
}: ServiceRouteContext): Promise<Response | null> {
  const actionServiceId = parseServiceActionPath(url.pathname);
  if (!actionServiceId) return null;

  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, { status: 405 });
  }
  if (actionServiceId !== 'stack') {
    return jsonResponse(
      { error: 'Unsupported service restart target' },
      { status: 400 },
    );
  }

  const serviceRequest = await readServiceAction(request);
  if (!serviceRequest) {
    return jsonResponse({ error: 'Invalid service action' }, { status: 400 });
  }

  const id = makeServiceRestartId(serviceRequest.requestId);
  const previous = recentServiceRestarts.find((record) => record.id === id);
  if (serviceRequest.requestId && previous) {
    if (previous.status === 'failed') {
      return jsonResponse(
        {
          error: previous.error ?? 'Service restart failed',
          duplicate: true,
          restart: previous,
        },
        { status: 500 },
      );
    }
    return jsonResponse({ ok: true, duplicate: true, restart: previous });
  }

  if (activeServiceRestartTargets.has(actionServiceId)) {
    return jsonResponse(
      { error: 'Service restart is already running' },
      { status: 409 },
    );
  }

  const requestedAt = now?.() ?? new Date().toISOString();
  const record: ServiceRestartRecord = {
    id,
    target: 'stack',
    requestedAt,
    completedAt: null,
    status: 'running',
    services: [],
  };
  rememberServiceRestart(recentServiceRestarts, record);
  activeServiceRestartTargets.add(actionServiceId);

  try {
    const services = restartServiceStack();
    record.completedAt = now?.() ?? new Date().toISOString();
    record.status = 'success';
    record.services = services;
    return jsonResponse({ ok: true, restart: record });
  } catch (err) {
    record.completedAt = now?.() ?? new Date().toISOString();
    record.status = 'failed';
    record.error = errorMessage(err);
    return jsonResponse(
      { error: record.error, restart: record },
      { status: 500 },
    );
  } finally {
    activeServiceRestartTargets.delete(actionServiceId);
  }
}
