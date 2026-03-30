/**
 * Step: verify — End-to-end health check of the full installation.
 * Replaces 09-verify.sh
 *
 * Supports the EJClaw service stack:
 *   - ejclaw (Claude Code) — always checked
 *   - ejclaw-codex (Codex) — checked when .env.codex exists
 *   - ejclaw-review (Codex Review) — checked when .env.codex-review exists
 *
 * Uses better-sqlite3 directly (no sqlite3 CLI), platform-aware service checks.
 */
import fs from 'fs';
import path from 'path';

import { Database } from 'bun:sqlite';

import { STORE_DIR } from '../src/config.js';
import { readEnvFile } from '../src/env.js';
import { logger } from '../src/logger.js';
import { getServiceManager } from './platform.js';
import { getServiceDefs } from './service-defs.js';
import { emitStatus } from './status.js';
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

  // 2. Check credentials
  let credentials = 'missing';
  const envFile = path.join(projectRoot, '.env');
  if (fs.existsSync(envFile)) {
    const envContent = fs.readFileSync(envFile, 'utf-8');
    if (/^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)=/m.test(envContent)) {
      credentials = 'configured';
    }
  }

  // 3. Check channel auth (detect configured channels by credentials)
  const envVars = readEnvFile(['DISCORD_BOT_TOKEN']);

  const channelAuth: Record<string, string> = {};

  if (process.env.DISCORD_BOT_TOKEN || envVars.DISCORD_BOT_TOKEN) {
    channelAuth.discord = 'configured';
  }

  const configuredChannels = Object.keys(channelAuth);
  const anyChannelConfigured = configuredChannels.length > 0;

  // 4. Check registered groups (using better-sqlite3, not sqlite3 CLI)
  let registeredGroups = 0;
  let groupsByAgent: Record<string, number> = {};
  const dbPath = path.join(STORE_DIR, 'messages.db');
  if (fs.existsSync(dbPath)) {
    try {
      const db = new Database(dbPath, { readonly: true });
      const row = db
        .prepare('SELECT COUNT(*) as count FROM registered_groups')
        .get() as { count: number };
      registeredGroups = row.count;

      // Count by agent type
      try {
        const rows = db
          .prepare(
            'SELECT agent_type, COUNT(*) as count FROM registered_groups GROUP BY agent_type',
          )
          .all() as { agent_type: string; count: number }[];
        for (const r of rows) {
          groupsByAgent[r.agent_type || 'unknown'] = r.count;
        }
      } catch {
        // agent_type column might not exist in older schema
      }

      db.close();
    } catch {
      // Table might not exist
    }
  }

  // Determine overall status
  const allConfiguredServicesRunning = services.every(
    (service) => service.status === 'running',
  );
  const codexConfigured = serviceDefs.some(
    (service) => service.kind === 'codex',
  );
  const reviewConfigured = serviceDefs.some(
    (service) => service.kind === 'review',
  );

  const status =
    allConfiguredServicesRunning &&
    credentials !== 'missing' &&
    anyChannelConfigured &&
    registeredGroups > 0
      ? 'success'
      : 'failed';

  // Build service status summary
  const servicesSummary: Record<string, string> = {};
  for (const svc of services) {
    servicesSummary[svc.name] = svc.status;
  }

  logger.info({ status, channelAuth, servicesSummary }, 'Verification complete');

  emitStatus('VERIFY', {
    SERVICES: JSON.stringify(servicesSummary),
    // Legacy field (keep for backward compatibility)
    SERVICE: services[0].status,
    CREDENTIALS: credentials,
    CONFIGURED_CHANNELS: configuredChannels.join(','),
    CHANNEL_AUTH: JSON.stringify(channelAuth),
    REGISTERED_GROUPS: registeredGroups,
    GROUPS_BY_AGENT: JSON.stringify(groupsByAgent),
    CODEX_CONFIGURED: codexConfigured,
    REVIEW_CONFIGURED: reviewConfigured,
    STATUS: status,
    LOG: 'logs/setup.log',
  });

  if (status === 'failed') process.exit(1);
}
