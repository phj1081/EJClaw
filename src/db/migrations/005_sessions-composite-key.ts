import { inferAgentTypeFromServiceShadow } from '../../role-service-shadow.js';
import {
  backfillLegacyServiceSessions,
  dropLegacyServiceSessionsTable,
  migrateSessionsTableToCompositePk,
} from '../sessions.js';
import type { SchemaMigrationDefinition } from './types.js';

export const SESSIONS_COMPOSITE_KEY_MIGRATION = {
  version: 5,
  name: 'sessions_composite_key',
  apply(database) {
    migrateSessionsTableToCompositePk(database, 'claude-code');
    backfillLegacyServiceSessions(database, inferAgentTypeFromServiceShadow);
    dropLegacyServiceSessionsTable(database);
  },
} satisfies SchemaMigrationDefinition;
