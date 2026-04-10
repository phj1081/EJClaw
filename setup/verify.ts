/**
 * Step: verify — End-to-end health check of the full installation.
 * Replaces 09-verify.sh
 *
 * Supports the unified EJClaw service:
 *   - ejclaw — always checked
 *
 * Uses better-sqlite3 directly (no sqlite3 CLI), platform-aware service checks.
 */
import path from 'path';

import { logger } from '../src/logger.js';
import { getServiceManager } from './platform.js';
import { getRoomRegistrationGateFailure } from './room-registration-state.js';
import { getServiceDefs } from './service-defs.js';
import { emitStatus } from './status.js';
import {
  buildVerifySummary,
  detectChannelAuth,
  detectCredentials,
  loadAssignedRoomsSummary,
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

  for (const svc of services) {
    logger.info({ service: svc.name, status: svc.status }, 'Service status');
  }

  const credentials = detectCredentials(projectRoot);
  const channelAuth = detectChannelAuth();
  const dbPath = path.join(projectRoot, 'store', 'messages.db');
  const roomSummary = loadAssignedRoomsSummary({ projectRoot, dbPath });
  const { tribunalRooms, activeArbiterTasks } =
    loadRoleRoutingRequirementsSummary({ dbPath });
  const {
    status: baseStatus,
    servicesSummary,
    configuredChannels,
    tribunalRooms: detectedTribunalRooms,
    activeArbiterTasks: detectedActiveArbiterTasks,
    reviewerChannelConfigured,
    arbiterChannelConfigured,
  } = buildVerifySummary(
    services,
    serviceDefs,
    credentials,
    channelAuth,
    roomSummary,
    {
      tribunalRooms,
      activeArbiterTasks,
    },
  );
  const roomRegistrationGateFailure = getRoomRegistrationGateFailure(
    roomSummary,
    'verification',
  );
  const status = baseStatus;

  logger.info(
    {
      status,
      channelAuth,
      tribunalRooms: detectedTribunalRooms,
      activeArbiterTasks: detectedActiveArbiterTasks,
      servicesSummary,
    },
    'Verification complete',
  );

  emitStatus('VERIFY', {
    SERVICES: JSON.stringify(servicesSummary),
    // Legacy field (keep for backward compatibility)
    SERVICE: services[0].status,
    CREDENTIALS: credentials,
    CONFIGURED_CHANNELS: configuredChannels.join(','),
    CHANNEL_AUTH: JSON.stringify(channelAuth),
    TRIBUNAL_ROOMS: detectedTribunalRooms,
    ACTIVE_ARBITER_TASKS: detectedActiveArbiterTasks,
    ASSIGNED_ROOMS: roomSummary.assignedRooms,
    ROOMS_BY_OWNER_AGENT: JSON.stringify(roomSummary.roomsByOwnerAgent),
    LEGACY_REGISTERED_GROUP_ROWS: roomSummary.legacyRegisteredGroupRows,
    LEGACY_ROOM_MIGRATION_REQUIRED: roomSummary.legacyRoomMigrationRequired,
    UNEXPECTED_DATA_STATE_FILES: roomSummary.unexpectedDataStateFiles.join(','),
    UNEXPECTED_DATA_STATE_DETECTED: roomSummary.unexpectedDataStateDetected,
    REVIEWER_CHANNEL_CONFIGURED: reviewerChannelConfigured,
    ARBITER_CHANNEL_CONFIGURED: arbiterChannelConfigured,
    ...(roomRegistrationGateFailure
      ? {
          ERROR: roomRegistrationGateFailure.error,
          NEXT_STEP: roomRegistrationGateFailure.nextStep,
        }
      : {}),
    STATUS: status,
    LOG: 'logs/setup.log',
  });

  if (status === 'failed') process.exit(1);
}
