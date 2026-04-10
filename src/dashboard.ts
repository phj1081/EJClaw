import {
  buildStatusContent,
  type DashboardOptions,
} from './dashboard-status-content.js';
import {
  purgeDashboardChannel,
  startUnifiedDashboard,
} from './unified-dashboard.js';

export { buildStatusContent, purgeDashboardChannel };
export type { DashboardOptions };

export async function startStatusDashboard(
  opts: DashboardOptions,
): Promise<void> {
  await startUnifiedDashboard({
    assistantName: opts.assistantName,
    serviceId: opts.serviceAgentType === 'codex' ? 'codex-main' : 'claude',
    serviceAgentType: opts.serviceAgentType || 'claude-code',
    statusChannelId: opts.statusChannelId,
    statusUpdateInterval: opts.statusUpdateInterval,
    usageUpdateInterval: opts.usageUpdateInterval,
    channels: opts.channels,
    queue: opts.queue,
    roomBindings: opts.roomBindings,
  });
}

export async function startUsageDashboard(): Promise<void> {
  // Usage dashboard is integrated into startStatusDashboard via unified dashboard.
}
