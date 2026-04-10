import fs from 'fs';
import path from 'path';

import { DATA_DIR, STORE_DIR } from '../src/config.js';
import {
  initializeDatabaseSchema,
  openPersistentDatabase,
} from '../src/db/bootstrap.js';
import { setRouterStateInDatabase } from '../src/db/router-state.js';
import { setSessionInDatabase } from '../src/db/sessions.js';
import { readJsonFile } from '../src/utils.js';
import { emitStatus } from './status.js';

interface JsonMigrationReport {
  migratedRouterStateKeys: number;
  migratedSessions: number;
  renamedRouterStateJson: boolean;
  renamedSessionsJson: boolean;
}

function renameMigratedFile(filePath: string): void {
  fs.renameSync(filePath, `${filePath}.migrated`);
}

function migrateRouterStateJson(
  database: ReturnType<typeof openPersistentDatabase>,
): {
  migratedKeys: number;
  renamed: boolean;
} {
  const routerStatePath = path.join(DATA_DIR, 'router_state.json');
  const routerState = readJsonFile(routerStatePath) as {
    last_seq?: string;
    last_timestamp?: string;
    last_agent_seq?: Record<string, string>;
    last_agent_timestamp?: Record<string, string>;
  } | null;
  if (!routerState) {
    return { migratedKeys: 0, renamed: false };
  }

  const lastSeq = routerState.last_seq ?? routerState.last_timestamp;
  const lastAgentSeq =
    routerState.last_agent_seq ?? routerState.last_agent_timestamp;
  let migratedKeys = 0;
  if (lastSeq) {
    setRouterStateInDatabase(database, 'last_seq', lastSeq);
    migratedKeys += 1;
  }
  if (lastAgentSeq) {
    setRouterStateInDatabase(
      database,
      'last_agent_seq',
      JSON.stringify(lastAgentSeq),
    );
    migratedKeys += 1;
  }
  renameMigratedFile(routerStatePath);
  return { migratedKeys, renamed: true };
}

function migrateSessionsJson(
  database: ReturnType<typeof openPersistentDatabase>,
): {
  migratedSessions: number;
  renamed: boolean;
} {
  const sessionsPath = path.join(DATA_DIR, 'sessions.json');
  const sessions = readJsonFile(sessionsPath) as Record<string, string> | null;
  if (!sessions) {
    return { migratedSessions: 0, renamed: false };
  }

  for (const [groupFolder, sessionId] of Object.entries(sessions)) {
    setSessionInDatabase(database, groupFolder, 'claude-code', sessionId);
  }
  renameMigratedFile(sessionsPath);
  return {
    migratedSessions: Object.keys(sessions).length,
    renamed: true,
  };
}

export async function run(_args: string[]): Promise<void> {
  fs.mkdirSync(STORE_DIR, { recursive: true });
  const database = openPersistentDatabase();
  initializeDatabaseSchema(database);

  const report: JsonMigrationReport = {
    migratedRouterStateKeys: 0,
    migratedSessions: 0,
    renamedRouterStateJson: false,
    renamedSessionsJson: false,
  };

  database.transaction(() => {
    const routerStateResult = migrateRouterStateJson(database);
    report.migratedRouterStateKeys = routerStateResult.migratedKeys;
    report.renamedRouterStateJson = routerStateResult.renamed;

    const sessionsResult = migrateSessionsJson(database);
    report.migratedSessions = sessionsResult.migratedSessions;
    report.renamedSessionsJson = sessionsResult.renamed;
  })();

  database.close();

  emitStatus('MIGRATE_JSON_STATE', {
    MIGRATED_ROUTER_STATE_KEYS: report.migratedRouterStateKeys,
    MIGRATED_SESSIONS: report.migratedSessions,
    RENAMED_ROUTER_STATE_JSON: report.renamedRouterStateJson,
    RENAMED_SESSIONS_JSON: report.renamedSessionsJson,
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}
