/**
 * Step: groups — List known Discord groups from the local chat metadata store.
 * Discord channel names are discovered at runtime, so the sync path is a no-op.
 */
import fs from 'fs';
import path from 'path';

import { Database } from 'bun:sqlite';

import { STORE_DIR } from '../src/config.js';
import { logger } from '../src/logger.js';
import { emitStatus } from './status.js';

function parseArgs(args: string[]): { list: boolean; limit: number } {
  let list = false;
  let limit = 30;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--list') list = true;
    if (args[i] === '--limit' && args[i + 1]) {
      limit = parseInt(args[i + 1], 10);
      i++;
    }
  }
  return { list, limit };
}

export async function run(args: string[]): Promise<void> {
  const { list, limit } = parseArgs(args);

  if (list) {
    await listGroups(limit);
    return;
  }

  await syncGroups();
}

async function listGroups(limit: number): Promise<void> {
  const dbPath = path.join(STORE_DIR, 'messages.db');

  if (!fs.existsSync(dbPath)) {
    console.error('ERROR: database not found');
    process.exit(1);
  }

  const db = new Database(dbPath, { readonly: true });
  const rows = db
    .prepare(
      `SELECT jid, name FROM chats
       WHERE jid LIKE 'dc:%' AND is_group = 1 AND jid <> '__group_sync__' AND name <> jid
       ORDER BY last_message_time DESC
       LIMIT ?`,
    )
    .all(limit) as Array<{ jid: string; name: string }>;
  db.close();

  for (const row of rows) {
    console.log(`${row.jid}|${row.name}`);
  }
}

async function syncGroups(): Promise<void> {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  let groupsInDb = 0;

  if (fs.existsSync(dbPath)) {
    try {
      const db = new Database(dbPath, { readonly: true });
      const row = db
        .prepare(
          `SELECT COUNT(*) as count FROM chats
           WHERE jid LIKE 'dc:%' AND is_group = 1 AND jid <> '__group_sync__' AND name <> jid`,
        )
        .get() as { count: number };
      groupsInDb = row.count;
      db.close();
    } catch (err) {
      logger.warn({ err }, 'Failed to count Discord groups during setup');
    }
  }

  logger.info({ groupsInDb }, 'Discord groups are discovered at runtime');
  emitStatus('SYNC_GROUPS', {
    BUILD: 'skipped',
    SYNC: 'skipped',
    GROUPS_IN_DB: groupsInDb,
    REASON: 'discord_runtime_sync',
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}
