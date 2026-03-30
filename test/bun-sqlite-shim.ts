/**
 * Vitest shim: resolves `bun:sqlite` to better-sqlite3 for Node.js test runtime.
 * Production runs on Bun and uses native bun:sqlite.
 */
import BetterSqlite from 'better-sqlite3';

export const Database = BetterSqlite;
