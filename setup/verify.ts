/**
 * Step: verify — End-to-end health check of the full installation.
 * Replaces 09-verify.sh
 *
 * Supports the unified EJClaw service:
 *   - ejclaw — always checked
 *
 * Uses better-sqlite3 directly (no sqlite3 CLI), platform-aware service checks.
 */
import os from 'os';

import { logger } from '../src/logger.js';
import {
  detectLegacyServiceIssues,
  formatLegacyServiceFailureMessage,
} from './legacy-service-guard.js';
import { getServiceManager } from './platform.js';
import { getServiceDefs } from './service-defs.js';
import { emitStatus } from './status.js';
import {
  buildVerifySummary,
  detectChannelAuth,
  detectCredentials,
  loadRegisteredGroupsSummary,
  loadRoleRoutingRequirementsSummary,
} from './verify-state.js';
import { getServiceChecks } from './verify-services.js';

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

export async function run(_args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const mgr = getServiceManager();

  logger.info('Starting verification');

  // 1. Check service statuses
  const serviceDefs = getServiceDefs(projectRoot);
  const services = getServiceChecks(serviceDefs, projectRoot, mgr);
  const legacyServiceIssues = detectLegacyServiceIssues(
    projectRoot,
    mgr,
    os.homedir(),
  );

  for (const svc of services) {
    logger.info({ service: svc.name, status: svc.status }, 'Service status');
  }
  for (const svc of legacyServiceIssues) {
    logger.error(
      { service: svc.name, status: svc.status },
      'Legacy service detected during verification',
    );
  }

  const credentials = detectCredentials(projectRoot);
  const channelAuth = detectChannelAuth();
  const { registeredGroups, groupsByAgent } = loadRegisteredGroupsSummary();
  const { tribunalRooms, activeArbiterTasks } =
    loadRoleRoutingRequirementsSummary();
  const {
    status: baseStatus,
    servicesSummary,
    configuredChannels,
    tribunalRooms: detectedTribunalRooms,
    activeArbiterTasks: detectedActiveArbiterTasks,
    codexConfigured,
    reviewConfigured,
  } = buildVerifySummary(
    services,
    serviceDefs,
    credentials,
    channelAuth,
    registeredGroups,
    groupsByAgent,
    {
      tribunalRooms,
      activeArbiterTasks,
    },
  );
  const legacyServicesSummary = Object.fromEntries(
    legacyServiceIssues.map((service) => [service.name, service.status]),
  );
  const status = legacyServiceIssues.length > 0 ? 'failed' : baseStatus;

  logger.info(
    {
      status,
      channelAuth,
      tribunalRooms: detectedTribunalRooms,
      activeArbiterTasks: detectedActiveArbiterTasks,
      servicesSummary,
      legacyServicesSummary,
    },
    'Verification complete',
  );
  if (legacyServiceIssues.length > 0) {
    logger.error(
      {
        cleanup: formatLegacyServiceFailureMessage({
          projectRoot,
          serviceManager: mgr,
          homeDir: os.homedir(),
          services: legacyServiceIssues,
        }),
      },
      'Verification failed due to legacy multi-service install',
    );
  }

  emitStatus('VERIFY', {
    SERVICES: JSON.stringify(servicesSummary),
    LEGACY_SERVICES: JSON.stringify(legacyServicesSummary),
    // Legacy field (keep for backward compatibility)
    SERVICE: services[0].status,
    CREDENTIALS: credentials,
    CONFIGURED_CHANNELS: configuredChannels.join(','),
    CHANNEL_AUTH: JSON.stringify(channelAuth),
    TRIBUNAL_ROOMS: detectedTribunalRooms,
    ACTIVE_ARBITER_TASKS: detectedActiveArbiterTasks,
    REGISTERED_GROUPS: registeredGroups,
    GROUPS_BY_AGENT: JSON.stringify(groupsByAgent),
    CODEX_CONFIGURED: codexConfigured,
    REVIEW_CONFIGURED: reviewConfigured,
    STATUS: status,
    LOG: 'logs/setup.log',
  });

  if (status === 'failed') process.exit(1);
}
