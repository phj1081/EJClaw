import { Database } from 'bun:sqlite';

import { AgentType } from '../types.js';

export type ServiceShadowAgentTypeResolver = (
  serviceId: string,
) => AgentType | undefined;

function hasLegacyServiceSessionsTable(database: Database): boolean {
  return Boolean(
    database
      .prepare(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'service_sessions'`,
      )
      .get(),
  );
}

export function migrateSessionsTableToCompositePk(
  database: Database,
  defaultAgentType: AgentType,
): void {
  const sessionCols = database
    .prepare('PRAGMA table_info(sessions)')
    .all() as Array<{ name: string }>;
  if (sessionCols.some((col) => col.name === 'agent_type')) {
    return;
  }

  database.exec(`
    CREATE TABLE sessions_new (
      group_folder TEXT NOT NULL,
      agent_type TEXT NOT NULL DEFAULT '${defaultAgentType}',
      session_id TEXT NOT NULL,
      PRIMARY KEY (group_folder, agent_type)
    );
  `);
  database
    .prepare(
      `INSERT INTO sessions_new (group_folder, agent_type, session_id)
       SELECT group_folder, ?, session_id FROM sessions`,
    )
    .run(defaultAgentType);
  database.exec(`
    DROP TABLE sessions;
    ALTER TABLE sessions_new RENAME TO sessions;
  `);
}

export function backfillLegacyServiceSessions(
  database: Database,
  resolveAgentTypeFromServiceId: ServiceShadowAgentTypeResolver,
): void {
  if (!hasLegacyServiceSessionsTable(database)) {
    return;
  }

  const rows = database
    .prepare(
      `SELECT group_folder, service_id, session_id
       FROM service_sessions`,
    )
    .all() as Array<{
    group_folder: string;
    service_id: string;
    session_id: string;
  }>;

  const upsert = database.prepare(
    `INSERT OR IGNORE INTO sessions (group_folder, agent_type, session_id)
     VALUES (?, ?, ?)`,
  );

  const tx = database.transaction(
    (
      sessionRows: Array<{
        group_folder: string;
        service_id: string;
        session_id: string;
      }>,
    ) => {
      for (const row of sessionRows) {
        const agentType = resolveAgentTypeFromServiceId(row.service_id);
        if (!agentType) {
          continue;
        }
        upsert.run(row.group_folder, agentType, row.session_id);
      }
    },
  );

  tx(rows);
}

export function dropLegacyServiceSessionsTable(database: Database): void {
  if (!hasLegacyServiceSessionsTable(database)) {
    return;
  }

  database.exec(`DROP TABLE service_sessions`);
}

export function getSessionFromDatabase(
  database: Database,
  groupFolder: string,
  agentType: string,
): string | undefined {
  const row = database
    .prepare(
      'SELECT session_id FROM sessions WHERE group_folder = ? AND agent_type = ?',
    )
    .get(groupFolder, agentType) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSessionInDatabase(
  database: Database,
  groupFolder: string,
  agentType: string,
  sessionId: string,
): void {
  database
    .prepare(
      'INSERT OR REPLACE INTO sessions (group_folder, agent_type, session_id) VALUES (?, ?, ?)',
    )
    .run(groupFolder, agentType, sessionId);
}

export function deleteSessionFromDatabase(
  database: Database,
  groupFolder: string,
  agentType: string,
): void {
  database
    .prepare('DELETE FROM sessions WHERE group_folder = ? AND agent_type = ?')
    .run(groupFolder, agentType);
}

export function deleteAllSessionsForGroupFromDatabase(
  database: Database,
  groupFolder: string,
): void {
  database
    .prepare('DELETE FROM sessions WHERE group_folder = ?')
    .run(groupFolder);
}

export function getAllSessionsForAgentTypeFromDatabase(
  database: Database,
  agentType: string,
): Record<string, string> {
  const rows = database
    .prepare(
      'SELECT group_folder, session_id FROM sessions WHERE agent_type = ?',
    )
    .all(agentType) as Array<{
    group_folder: string;
    session_id: string;
  }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.group_folder] = row.session_id;
  }
  return result;
}
