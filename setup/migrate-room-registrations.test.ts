import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Database } from 'bun:sqlite';

describe('migrate room registrations step', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('migrates pending legacy rows into canonical room tables idempotently', async () => {
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'ejclaw-migrate-rooms-'),
    );
    tempRoots.push(tempRoot);
    const storeDir = path.join(tempRoot, 'store');
    const dataDir = path.join(tempRoot, 'data');
    fs.mkdirSync(storeDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    vi.stubEnv('EJCLAW_STORE_DIR', storeDir);
    vi.stubEnv('EJCLAW_DATA_DIR', dataDir);

    const dbPath = path.join(storeDir, 'messages.db');
    const legacyDb = new Database(dbPath);
    legacyDb.exec(`
      CREATE TABLE registered_groups (
        jid TEXT NOT NULL,
        name TEXT NOT NULL,
        folder TEXT NOT NULL,
        trigger_pattern TEXT NOT NULL,
        added_at TEXT NOT NULL,
        agent_config TEXT,
        requires_trigger INTEGER DEFAULT 1,
        is_main INTEGER DEFAULT 0,
        agent_type TEXT NOT NULL DEFAULT 'claude-code',
        work_dir TEXT,
        PRIMARY KEY (jid, agent_type),
        UNIQUE (folder, agent_type)
      )
    `);
    legacyDb
      .prepare(
        `INSERT INTO registered_groups (
          jid,
          name,
          folder,
          trigger_pattern,
          added_at,
          agent_config,
          requires_trigger,
          is_main,
          agent_type,
          work_dir
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'dc:legacy-room',
        'Legacy Room',
        'legacy-room',
        '@Claude',
        '2024-01-01T00:00:00.000Z',
        '{"provider":"anthropic"}',
        1,
        0,
        'claude-code',
        null,
      );
    legacyDb
      .prepare(
        `INSERT INTO registered_groups (
          jid,
          name,
          folder,
          trigger_pattern,
          added_at,
          agent_config,
          requires_trigger,
          is_main,
          agent_type,
          work_dir
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'dc:legacy-room',
        'Legacy Room',
        'legacy-room',
        '@Codex',
        '2024-01-02T00:00:00.000Z',
        '{"provider":"openai"}',
        1,
        0,
        'codex',
        null,
      );
    legacyDb.close();

    const emitStatusMock = vi.fn();
    vi.doMock('./status.js', () => ({
      emitStatus: emitStatusMock,
    }));

    const { run } = await import('./migrate-room-registrations.js');

    await run([]);

    const migratedDb = new Database(dbPath, { readonly: true });
    expect(
      migratedDb
        .prepare(
          `SELECT chat_jid, room_mode, mode_source, owner_agent_type
             FROM room_settings
            ORDER BY chat_jid`,
        )
        .all(),
    ).toEqual([
      {
        chat_jid: 'dc:legacy-room',
        room_mode: 'tribunal',
        mode_source: 'inferred',
        owner_agent_type: 'codex',
      },
    ]);
    expect(
      migratedDb
        .prepare(
          `SELECT chat_jid, role, agent_type
             FROM room_role_overrides
            ORDER BY chat_jid, role`,
        )
        .all(),
    ).toEqual([
      {
        chat_jid: 'dc:legacy-room',
        role: 'owner',
        agent_type: 'codex',
      },
      {
        chat_jid: 'dc:legacy-room',
        role: 'reviewer',
        agent_type: 'claude-code',
      },
    ]);
    expect(
      migratedDb
        .prepare(
          `SELECT name
             FROM sqlite_master
            WHERE type = 'table'
              AND name = 'registered_groups'`,
        )
        .get(),
    ).toBeUndefined();
    expect(
      migratedDb
        .prepare(
          `SELECT jid, agent_type
             FROM registered_groups_legacy_backup
            ORDER BY jid, agent_type`,
        )
        .all(),
    ).toEqual([
      {
        jid: 'dc:legacy-room',
        agent_type: 'claude-code',
      },
      {
        jid: 'dc:legacy-room',
        agent_type: 'codex',
      },
    ]);
    migratedDb.close();

    expect(emitStatusMock).toHaveBeenLastCalledWith(
      'MIGRATE_ROOM_REGISTRATIONS',
      expect.objectContaining({
        MIGRATED_ROOMS: 1,
        MIGRATED_ROLE_OVERRIDES: 2,
        SKIPPED_ROOMS: 0,
        BACKED_UP_LEGACY_ROWS: 2,
        STATUS: 'success',
      }),
    );

    emitStatusMock.mockClear();
    await run([]);
    expect(emitStatusMock).toHaveBeenLastCalledWith(
      'MIGRATE_ROOM_REGISTRATIONS',
      expect.objectContaining({
        MIGRATED_ROOMS: 0,
        MIGRATED_ROLE_OVERRIDES: 0,
        SKIPPED_ROOMS: 0,
        BACKED_UP_LEGACY_ROWS: 0,
        STATUS: 'success',
      }),
    );
  });

  it('backfills room_role_overrides for rooms that already have room_settings', async () => {
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'ejclaw-migrate-rooms-mixed-'),
    );
    tempRoots.push(tempRoot);
    const storeDir = path.join(tempRoot, 'store');
    const dataDir = path.join(tempRoot, 'data');
    fs.mkdirSync(storeDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    vi.stubEnv('EJCLAW_STORE_DIR', storeDir);
    vi.stubEnv('EJCLAW_DATA_DIR', dataDir);

    const dbPath = path.join(storeDir, 'messages.db');
    const legacyDb = new Database(dbPath);
    legacyDb.exec(`
      CREATE TABLE room_settings (
        chat_jid TEXT PRIMARY KEY,
        room_mode TEXT NOT NULL,
        mode_source TEXT NOT NULL DEFAULT 'explicit',
        name TEXT,
        folder TEXT,
        trigger_pattern TEXT,
        requires_trigger INTEGER DEFAULT 1,
        is_main INTEGER DEFAULT 0,
        owner_agent_type TEXT,
        work_dir TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE registered_groups (
        jid TEXT NOT NULL,
        name TEXT NOT NULL,
        folder TEXT NOT NULL,
        trigger_pattern TEXT NOT NULL,
        added_at TEXT NOT NULL,
        agent_config TEXT,
        requires_trigger INTEGER DEFAULT 1,
        is_main INTEGER DEFAULT 0,
        agent_type TEXT NOT NULL DEFAULT 'claude-code',
        work_dir TEXT,
        PRIMARY KEY (jid, agent_type),
        UNIQUE (folder, agent_type)
      )
    `);
    legacyDb
      .prepare(
        `INSERT INTO room_settings (
          chat_jid,
          room_mode,
          mode_source,
          name,
          folder,
          trigger_pattern,
          requires_trigger,
          is_main,
          owner_agent_type,
          work_dir,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'dc:mixed-room',
        'tribunal',
        'explicit',
        'Mixed Room',
        'mixed-room',
        '@Andy',
        1,
        0,
        'codex',
        null,
        '2026-04-10T00:00:00.000Z',
      );
    legacyDb
      .prepare(
        `INSERT INTO registered_groups (
          jid,
          name,
          folder,
          trigger_pattern,
          added_at,
          agent_config,
          requires_trigger,
          is_main,
          agent_type,
          work_dir
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'dc:mixed-room',
        'Mixed Room',
        'mixed-room',
        '@Andy',
        '2026-04-08T00:00:00.000Z',
        '{"provider":"openai"}',
        1,
        0,
        'codex',
        null,
      );
    legacyDb
      .prepare(
        `INSERT INTO registered_groups (
          jid,
          name,
          folder,
          trigger_pattern,
          added_at,
          agent_config,
          requires_trigger,
          is_main,
          agent_type,
          work_dir
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'dc:mixed-room',
        'Mixed Room',
        'mixed-room',
        '@Andy',
        '2026-04-09T00:00:00.000Z',
        '{"provider":"anthropic"}',
        1,
        0,
        'claude-code',
        null,
      );
    legacyDb.close();

    const emitStatusMock = vi.fn();
    vi.doMock('./status.js', () => ({
      emitStatus: emitStatusMock,
    }));

    const { run } = await import('./migrate-room-registrations.js');

    await run([]);

    const migratedDb = new Database(dbPath, { readonly: true });
    expect(
      migratedDb
        .prepare(
          `SELECT chat_jid, role, agent_type, agent_config_json
             FROM room_role_overrides
            ORDER BY role`,
        )
        .all(),
    ).toEqual([
      {
        chat_jid: 'dc:mixed-room',
        role: 'owner',
        agent_type: 'codex',
        agent_config_json: '{"provider":"openai"}',
      },
      {
        chat_jid: 'dc:mixed-room',
        role: 'reviewer',
        agent_type: 'claude-code',
        agent_config_json: '{"provider":"anthropic"}',
      },
    ]);
    migratedDb.close();

    expect(emitStatusMock).toHaveBeenLastCalledWith(
      'MIGRATE_ROOM_REGISTRATIONS',
      expect.objectContaining({
        MIGRATED_ROOMS: 0,
        MIGRATED_ROLE_OVERRIDES: 2,
        BACKED_UP_LEGACY_ROWS: 2,
        STATUS: 'success',
      }),
    );
  });

  it('fails when unexpected data state files are still present', async () => {
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'ejclaw-migrate-rooms-legacy-files-'),
    );
    tempRoots.push(tempRoot);
    const storeDir = path.join(tempRoot, 'store');
    const dataDir = path.join(tempRoot, 'data');
    fs.mkdirSync(storeDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    vi.stubEnv('EJCLAW_STORE_DIR', storeDir);
    vi.stubEnv('EJCLAW_DATA_DIR', dataDir);

    fs.writeFileSync(path.join(dataDir, 'registered_groups.json'), '{}');

    const { run } = await import('./migrate-room-registrations.js');

    await expect(run([])).rejects.toThrow(
      /Unexpected data state files detected before room migration/,
    );
  });
});
