import type { Database } from 'bun:sqlite';

export interface SchemaMigrationArgs {
  assistantName: string;
}

export interface SchemaMigrationDefinition {
  version: number;
  name: string;
  alwaysRun?: boolean;
  apply: (database: Database, args: SchemaMigrationArgs) => void;
}
