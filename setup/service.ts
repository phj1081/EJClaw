/**
 * Step: service — Generate and load service manager config.
 * Replaces 08-setup-service.sh
 *
 * Supports the EJClaw service stack:
 *   - ejclaw (Claude Code) — always installed
 *   - ejclaw-codex (Codex) — installed when .env.codex exists
 *   - ejclaw-review (Codex Review) — installed when .env.codex-review exists
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { logger } from '../src/logger.js';
import { getPlatform, getNodePath } from './platform.js';
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
  for (const def of serviceDefs) {
    if (def.kind === 'primary' || !def.environmentFile) {
      continue;
    }
    logger.info(
      `Detected ${path.basename(def.environmentFile)} — will also install ${def.name} service`,
    );
  }

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
