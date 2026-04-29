/**
 * Step: service — Generate and load service manager config.
 * Replaces 08-setup-service.sh
 *
 * Supports the unified EJClaw service:
 *   - ejclaw — always installed
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { logger } from '../src/logger.js';
import {
  ensureLinuxReadonlySandboxAppArmorSupport,
  getPlatform,
  getNodePath,
} from './platform.js';
import { getServiceDefs } from './service-defs.js';
import { setupLaunchd, setupLinux } from './service-installers.js';
import { emitStatus } from './status.js';

/* ------------------------------------------------------------------ */
/*  Entry point                                                        */
/* ------------------------------------------------------------------ */

export async function run(_args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const platform = getPlatform();
  const nodePath = getNodePath();
  const homeDir = os.homedir();

  logger.info({ platform, nodePath, projectRoot }, 'Setting up service');

  const readonlySandboxAppArmorSetup =
    ensureLinuxReadonlySandboxAppArmorSupport();
  if (readonlySandboxAppArmorSetup === 'configured') {
    logger.info(
      'Configured AppArmor user namespace sysctl for EJClaw readonly sandbox support',
    );
  } else if (readonlySandboxAppArmorSetup === 'failed') {
    logger.warn(
      'Failed to apply AppArmor user namespace sysctl for EJClaw readonly sandbox support',
    );
  } else if (readonlySandboxAppArmorSetup === 'requires-root') {
    logger.warn(
      'Readonly sandbox strict mode requires root setup to disable AppArmor unprivileged userns restriction',
    );
  }

  // Build first
  logger.info('Building TypeScript');
  try {
    execSync('bun run build', {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    logger.info('Build succeeded');
  } catch {
    logger.error('Build failed');
    emitStatus('SETUP_SERVICE', {
      SERVICE_TYPE: 'unknown',
      NODE_PATH: nodePath,
      PROJECT_PATH: projectRoot,
      STATUS: 'failed',
      ERROR: 'build_failed',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  fs.mkdirSync(path.join(projectRoot, 'logs'), { recursive: true });

  const serviceDefs = getServiceDefs(projectRoot);

  if (platform === 'macos') {
    for (const def of serviceDefs) {
      setupLaunchd(def, projectRoot, nodePath, homeDir);
    }
  } else if (platform === 'linux') {
    setupLinux(serviceDefs, projectRoot, nodePath, homeDir);
  } else {
    emitStatus('SETUP_SERVICE', {
      SERVICE_TYPE: 'unknown',
      NODE_PATH: nodePath,
      PROJECT_PATH: projectRoot,
      STATUS: 'failed',
      ERROR: 'unsupported_platform',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }
}
