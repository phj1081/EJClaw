/**
 * Step: environment — Detect OS, Node, existing config.
 * Replaces 01-check-environment.sh
 */
import fs from 'fs';
import path from 'path';

import { logger } from '../src/logger.js';
import {
  canUseLinuxBubblewrapReadonlySandbox,
  commandExists,
  getAppArmorRestrictUnprivilegedUsernsValue,
  getPlatform,
  isHeadless,
  isWSL,
} from './platform.js';
import {
  detectRoomRegistrationState,
  getRoomRegistrationGateFailure,
} from './room-registration-state.js';
import { emitStatus } from './status.js';

export function detectAssignedRooms(
  options?: Parameters<typeof detectRoomRegistrationState>[0],
): boolean {
  return detectRoomRegistrationState(options).assignedRooms > 0;
}

export async function run(_args: string[]): Promise<void> {
  const projectRoot = process.cwd();

  logger.info('Starting environment check');

  const platform = getPlatform();
  const wsl = isWSL();
  const headless = isHeadless();
  const hasBubblewrap = platform === 'linux' && commandExists('bwrap');
  const hasSocat = platform === 'linux' && commandExists('socat');
  const apparmorRestrictUnprivilegedUserns =
    platform === 'linux' ? getAppArmorRestrictUnprivilegedUsernsValue() : null;
  const hasBubblewrapReadonlySandboxCapability =
    platform === 'linux' && canUseLinuxBubblewrapReadonlySandbox();

  // Check existing config
  const hasEnv = fs.existsSync(path.join(projectRoot, '.env'));

  const authDir = path.join(projectRoot, 'store', 'auth');
  const hasAuth = fs.existsSync(authDir) && fs.readdirSync(authDir).length > 0;

  const roomState = detectRoomRegistrationState({
    projectRoot,
    dbPath: path.join(projectRoot, 'store', 'messages.db'),
  });
  const roomRegistrationGateFailure = getRoomRegistrationGateFailure(
    roomState,
    'setup',
  );
  const status = roomRegistrationGateFailure ? 'failed' : 'success';

  logger.info(
    {
      platform,
      wsl,
      hasEnv,
      hasAuth,
      assignedRooms: roomState.assignedRooms,
      legacyRegisteredGroupRows: roomState.legacyRegisteredGroupRows,
      legacyRoomMigrationRequired: roomState.legacyRoomMigrationRequired,
      unexpectedDataStateFiles: roomState.unexpectedDataStateFiles,
      unexpectedDataStateDetected: roomState.unexpectedDataStateDetected,
      hasBubblewrap,
      hasSocat,
      apparmorRestrictUnprivilegedUserns,
      hasBubblewrapReadonlySandboxCapability,
    },
    'Environment check complete',
  );

  emitStatus('CHECK_ENVIRONMENT', {
    PLATFORM: platform,
    IS_WSL: wsl,
    IS_HEADLESS: headless,
    HAS_ENV: hasEnv,
    HAS_AUTH: hasAuth,
    HAS_ASSIGNED_ROOMS: roomState.assignedRooms > 0,
    ASSIGNED_ROOMS: roomState.assignedRooms,
    LEGACY_REGISTERED_GROUP_ROWS: roomState.legacyRegisteredGroupRows,
    LEGACY_ROOM_MIGRATION_REQUIRED: roomState.legacyRoomMigrationRequired,
    UNEXPECTED_DATA_STATE_FILES: roomState.unexpectedDataStateFiles.join(','),
    UNEXPECTED_DATA_STATE_DETECTED: roomState.unexpectedDataStateDetected,
    HAS_BWRAP: hasBubblewrap,
    HAS_SOCAT: hasSocat,
    APPARMOR_RESTRICT_UNPRIVILEGED_USERNS:
      apparmorRestrictUnprivilegedUserns ?? 'n/a',
    HAS_BWRAP_READONLY_SANDBOX_CAPABILITY:
      hasBubblewrapReadonlySandboxCapability,
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
