/**
 * Step: environment — Detect OS, Node, existing config.
 * Replaces 01-check-environment.sh
 */
import fs from 'fs';
import path from 'path';

import { Database } from 'bun:sqlite';

import { STORE_DIR } from '../src/config.js';
import { logger } from '../src/logger.js';
import {
  canUseLinuxBubblewrapReadonlySandbox,
  commandExists,
  getAppArmorRestrictUnprivilegedUsernsValue,
  getPlatform,
  isHeadless,
  isWSL,
} from './platform.js';
import { emitStatus } from './status.js';

export async function run(_args: string[]): Promise<void> {
  const projectRoot = process.cwd();

  logger.info('Starting environment check');

  const platform = getPlatform();
  const wsl = isWSL();
  const headless = isHeadless();
  const hasBubblewrap = platform === 'linux' && commandExists('bwrap');
  const hasSocat = platform === 'linux' && commandExists('socat');
  const apparmorRestrictUnprivilegedUserns =
    platform === 'linux'
      ? getAppArmorRestrictUnprivilegedUsernsValue()
      : null;
  const hasBubblewrapReadonlySandboxCapability =
    platform === 'linux' && canUseLinuxBubblewrapReadonlySandbox();

  // Check existing config
  const hasEnv = fs.existsSync(path.join(projectRoot, '.env'));

  const authDir = path.join(projectRoot, 'store', 'auth');
  const hasAuth = fs.existsSync(authDir) && fs.readdirSync(authDir).length > 0;

  let hasRegisteredGroups = false;
  // Check JSON file first (pre-migration)
  if (fs.existsSync(path.join(projectRoot, 'data', 'registered_groups.json'))) {
    hasRegisteredGroups = true;
  } else {
    // Check SQLite directly using better-sqlite3 (no sqlite3 CLI needed)
    const dbPath = path.join(STORE_DIR, 'messages.db');
    if (fs.existsSync(dbPath)) {
      try {
        const db = new Database(dbPath, { readonly: true });
        const row = db
          .prepare('SELECT COUNT(*) as count FROM registered_groups')
          .get() as { count: number };
        if (row.count > 0) hasRegisteredGroups = true;
        db.close();
      } catch {
        // Table might not exist yet
      }
    }
  }

  logger.info(
    {
      platform,
      wsl,
      hasEnv,
      hasAuth,
      hasRegisteredGroups,
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
    HAS_REGISTERED_GROUPS: hasRegisteredGroups,
    HAS_BWRAP: hasBubblewrap,
    HAS_SOCAT: hasSocat,
    APPARMOR_RESTRICT_UNPRIVILEGED_USERNS:
      apparmorRestrictUnprivilegedUserns ?? 'n/a',
    HAS_BWRAP_READONLY_SANDBOX_CAPABILITY:
      hasBubblewrapReadonlySandboxCapability,
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}
