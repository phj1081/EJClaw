import type { StatusSnapshot } from './status-dashboard.js';
import type { ScheduledTask } from './types.js';
import { sanitizeScheduledTask } from './web-dashboard-data.js';
import { serveValidatedAttachment } from './web-dashboard-attachments.js';

type JsonResponse = (
  value: unknown,
  init?: ResponseInit,
  request?: Request,
) => Response;

interface SimpleGetRouteContext {
  url: URL;
  statusMaxAgeMs: number;
  readSnapshots: (maxAgeMs: number) => StatusSnapshot[];
  loadTasks: () => ScheduledTask[];
  jsonResponse: JsonResponse;
}

export function handleSimpleGetRoute({
  url,
  statusMaxAgeMs,
  readSnapshots,
  loadTasks,
  jsonResponse,
}: SimpleGetRouteContext): Response | null {
  const simpleGetRoutes: Record<string, () => Response> = {
    '/api/health': () => jsonResponse({ ok: true }),
    '/api/status-snapshots': () => jsonResponse(readSnapshots(statusMaxAgeMs)),
    '/api/tasks': () => jsonResponse(loadTasks().map(sanitizeScheduledTask)),
    '/api/attachments': () => serveValidatedAttachment(url),
  };
  const route = simpleGetRoutes[url.pathname];
  return route ? route() : null;
}
