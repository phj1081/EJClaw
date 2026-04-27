import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { Database } from 'bun:sqlite';

import {
  detectRoomRegistrationState,
  getRoomRegistrationGateFailure,
} from './room-registration-state.js';

describe('room registration state', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports no assigned rooms when the database does not exist', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ejclaw-room-reg-'));
    tempRoots.push(tempRoot);

    expect(
      detectRoomRegistrationState({
        projectRoot: tempRoot,
        dbPath: path.join(tempRoot, 'messages.db'),
      }),
    ).toEqual({
      assignedRooms: 0,
      roomsByOwnerAgent: {},
      legacyRegisteredGroupRows: 0,
      legacyRoomMigrationRequired: false,
      unexpectedDataStateFiles: [],
      unexpectedDataStateDetected: false,
    });
  });

  it('counts canonical room_settings rows and owner-agent breakdowns', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ejclaw-room-reg-'));
    tempRoots.push(tempRoot);
    const dbPath = path.join(tempRoot, 'messages.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE room_settings (
        chat_jid TEXT PRIMARY KEY,
        room_mode TEXT NOT NULL,
        owner_agent_type TEXT,
        updated_at TEXT NOT NULL
      );
    `);
    db.exec(`
      INSERT INTO room_settings (chat_jid, room_mode, owner_agent_type, updated_at) VALUES
        ('group-1', 'single', 'claude-code', '2024-01-01T00:00:00.000Z'),
        ('group-2', 'single', 'codex', '2024-01-01T00:00:00.000Z'),
        ('group-3', 'tribunal', 'codex', '2024-01-01T00:00:00.000Z');
    `);
    db.close();

    expect(
      detectRoomRegistrationState({ projectRoot: tempRoot, dbPath }),
    ).toEqual({
      assignedRooms: 3,
      roomsByOwnerAgent: {
        'claude-code': 1,
        codex: 2,
      },
      legacyRegisteredGroupRows: 0,
      legacyRoomMigrationRequired: false,
      unexpectedDataStateFiles: [],
      unexpectedDataStateDetected: false,
    });
  });

  it('marks legacy-only sqlite registrations as migration-required', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ejclaw-room-reg-'));
    tempRoots.push(tempRoot);
    const dbPath = path.join(tempRoot, 'messages.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE registered_groups (
        jid TEXT PRIMARY KEY,
        agent_type TEXT
      )
    `);
    db.exec(`
      INSERT INTO registered_groups (jid, agent_type) VALUES
        ('legacy-room', 'claude-code')
    `);
    db.close();

    expect(
      detectRoomRegistrationState({ dbPath, projectRoot: tempRoot }),
    ).toEqual({
      assignedRooms: 0,
      roomsByOwnerAgent: {},
      legacyRegisteredGroupRows: 1,
      legacyRoomMigrationRequired: true,
      unexpectedDataStateFiles: [],
      unexpectedDataStateDetected: false,
    });
  });

  it('ignores legacy projection rows when matching canonical room_settings already exist', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ejclaw-room-reg-'));
    tempRoots.push(tempRoot);
    const dbPath = path.join(tempRoot, 'messages.db');
    const db = new Database(dbPath);
    db.exec(`
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
      CREATE TABLE room_role_overrides (
        chat_jid TEXT NOT NULL,
        role TEXT NOT NULL,
        agent_type TEXT NOT NULL,
        agent_config_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (chat_jid, role)
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
        agent_type TEXT NOT NULL,
        work_dir TEXT,
        PRIMARY KEY (jid, agent_type)
      )
    `);
    db.exec(`
      INSERT INTO room_settings (
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
      ) VALUES (
        'same-room',
        'single',
        'explicit',
        'Same Room',
        'same-room',
        '@Andy',
        1,
        0,
        'codex',
        NULL,
        '2024-01-01T00:00:00.000Z'
      )
    `);
    db.exec(`
      INSERT INTO registered_groups (
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
      ) VALUES (
        'same-room',
        'Same Room',
        'same-room',
        '@Andy',
        '2024-01-01T00:00:00.000Z',
        NULL,
        1,
        0,
        'codex',
        NULL
      )
    `);
    db.exec(`
      INSERT INTO room_role_overrides (
        chat_jid,
        role,
        agent_type,
        agent_config_json,
        created_at,
        updated_at
      ) VALUES (
        'same-room',
        'owner',
        'codex',
        NULL,
        '2024-01-01T00:00:00.000Z',
        '2024-01-01T00:00:00.000Z'
      )
    `);
    db.close();

    expect(
      detectRoomRegistrationState({ dbPath, projectRoot: tempRoot }),
    ).toEqual({
      assignedRooms: 1,
      roomsByOwnerAgent: {
        codex: 1,
      },
      legacyRegisteredGroupRows: 0,
      legacyRoomMigrationRequired: false,
      unexpectedDataStateFiles: [],
      unexpectedDataStateDetected: false,
    });
  });

  it('marks unexpected data-state files as blockers', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ejclaw-room-reg-'));
    tempRoots.push(tempRoot);
    fs.mkdirSync(path.join(tempRoot, 'data'), { recursive: true });
    fs.writeFileSync(
      path.join(tempRoot, 'data', 'registered_groups.json'),
      '{"dc:legacy":{"name":"Legacy","folder":"legacy","trigger":"@Andy","added_at":"2024-01-01T00:00:00.000Z"}}',
    );
    fs.writeFileSync(
      path.join(tempRoot, 'data', 'router_state.json'),
      JSON.stringify({ last_timestamp: '1234' }),
    );

    expect(
      detectRoomRegistrationState({
        projectRoot: tempRoot,
        dbPath: path.join(tempRoot, 'messages.db'),
      }),
    ).toEqual({
      assignedRooms: 0,
      roomsByOwnerAgent: {},
      legacyRegisteredGroupRows: 0,
      legacyRoomMigrationRequired: false,
      unexpectedDataStateFiles: ['registered_groups.json', 'router_state.json'],
      unexpectedDataStateDetected: true,
    });
  });

  it('returns no gate failure when room-registration state is clean', () => {
    expect(
      getRoomRegistrationGateFailure(
        {
          legacyRoomMigrationRequired: false,
          unexpectedDataStateDetected: false,
        },
        'setup',
      ),
    ).toBeUndefined();
  });

  it('returns a targeted gate failure when legacy room migration is pending', () => {
    expect(
      getRoomRegistrationGateFailure(
        {
          legacyRoomMigrationRequired: true,
          unexpectedDataStateDetected: false,
        },
        'verification',
      ),
    ).toEqual({
      error: 'legacy_room_migration_required',
      nextStep:
        'Run `bun setup/index.ts --step migrate-room-registrations` before continuing with verification',
    });
  });

  it('returns a combined gate failure when legacy migration and unexpected data files are both present', () => {
    expect(
      getRoomRegistrationGateFailure(
        {
          legacyRoomMigrationRequired: true,
          unexpectedDataStateDetected: true,
        },
        'setup',
      ),
    ).toEqual({
      error: 'legacy_migration_and_unexpected_data_state_detected',
      nextStep:
        'Run `bun setup/index.ts --step migrate-room-registrations` and remove or archive unexpected data state files before continuing with setup',
    });
  });
});
