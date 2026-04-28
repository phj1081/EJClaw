import type { StatusSnapshot } from './status-dashboard.js';
import type { PairedTask, ScheduledTask } from './types.js';
import { buildWebDashboardOverview } from './web-dashboard-data.js';
import type { ServiceRestartRecord } from './web-dashboard-service-routes.js';

type JsonResponse = (
  value: unknown,
  init?: ResponseInit,
  request?: Request,
) => Response;

type DismissableInboxItem = {
  id: string;
  lastOccurredAt: string;
};

export interface OverviewRouteDependencies {
  isInboxItemDismissed?: (item: DismissableInboxItem) => boolean;
  loadPairedTasks: () => PairedTask[];
  loadTasks: () => ScheduledTask[];
  readSnapshots: (maxAgeMs: number) => StatusSnapshot[];
  recentServiceRestarts: ServiceRestartRecord[];
  statusMaxAgeMs: number;
  now?: () => string;
}

interface OverviewRouteContext extends OverviewRouteDependencies {
  url: URL;
  jsonResponse: JsonResponse;
}

export function handleOverviewRoute({
  isInboxItemDismissed,
  jsonResponse,
  loadPairedTasks,
  loadTasks,
  now,
  readSnapshots,
  recentServiceRestarts,
  statusMaxAgeMs,
  url,
}: OverviewRouteContext): Response | null {
  if (url.pathname !== '/api/overview') return null;

  const snapshots = readSnapshots(statusMaxAgeMs);
  const tasks = loadTasks();
  const pairedTasks = loadPairedTasks();
  const overview = buildWebDashboardOverview({
    now: now?.(),
    snapshots,
    tasks,
    pairedTasks,
  });
  return jsonResponse({
    ...overview,
    operations: {
      serviceRestarts: recentServiceRestarts,
    },
    inbox: isInboxItemDismissed
      ? overview.inbox.filter((item) => !isInboxItemDismissed(item))
      : overview.inbox,
  });
}
