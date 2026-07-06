import { Database } from 'bun:sqlite';
import fs from 'fs';
import path from 'path';

import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  _initTestDatabaseFromFile,
  _deleteStoredRoomSettingsForTests,
  _setRegisteredGroupForTests,
  assignRoom,
  clearExplicitRoomMode,
  getAllRoomBindings,
  getEffectiveRoomMode,
  getEffectiveRuntimeRoomMode,
  getExplicitRoomMode,
  getRegisteredGroup,
  getRegisteredAgentTypesForJid,
  getRoomRoleAgentConfig,
  getStoredRoomSettings,
  updateRegisteredGroupName,
  updateRoomRoleAgentConfig,
} from './db.js';
import { initializeDatabaseSchema } from './db/bootstrap.js';
import {
  getPendingLegacyRegisteredGroupJidsForTests,
  migrateLegacyRoomRegistrationsInFile,
} from '../test/helpers/db-test-utils.js';

beforeEach(() => {
  _initTestDatabase();
});

describe('room assignment writes', () => {
  it('assigns a single room with an auto-generated folder', () => {
    const group = assignRoom('tg:-1001', {
      name: 'Telegram Dev Team',
      roomMode: 'single',
      ownerAgentType: 'claude-code',
    });

    expect(group).toBeDefined();
    expect(group!.folder).toMatch(/^grp_telegram_/);
    expect(group!.agentType).toBe('claude-code');
    expect(getStoredRoomSettings('tg:-1001')).toMatchObject({
      chatJid: 'tg:-1001',
      roomMode: 'single',
      modeSource: 'explicit',
      name: 'Telegram Dev Team',
      ownerAgentType: 'claude-code',
    });
    expect(getRegisteredAgentTypesForJid('tg:-1001')).toEqual(['claude-code']);
  });

  it('serves tribunal capability views from room_settings without legacy projection rows', () => {
    assignRoom('dc:assigned-room', {
      name: 'Assigned Room',
      roomMode: 'tribunal',
      ownerAgentType: 'codex',
      folder: 'assigned-room',
    });

    const allGroups = getAllRoomBindings();
    const claudeGroups = getAllRoomBindings('claude-code');
    const codexGroups = getAllRoomBindings('codex');

    expect(allGroups['dc:assigned-room']).toMatchObject({
      name: 'Assigned Room',
      folder: 'assigned-room',
      agentType: 'codex',
    });
    expect(claudeGroups['dc:assigned-room']).toMatchObject({
      name: 'Assigned Room',
      folder: 'assigned-room',
      agentType: 'claude-code',
    });
    expect(codexGroups['dc:assigned-room']).toMatchObject({
      name: 'Assigned Room',
      folder: 'assigned-room',
      agentType: 'codex',
    });
  });

  it('includes arbiter-only room agent overrides in capability views', () => {
    assignRoom('dc:arbiter-only-capability', {
      name: 'Arbiter Only Capability',
      roomMode: 'tribunal',
      ownerAgentType: 'claude-code',
      reviewerAgentType: 'claude-code',
      arbiterAgentType: 'codex',
      folder: 'arbiter-only-capability',
    });

    expect(
      getRegisteredAgentTypesForJid('dc:arbiter-only-capability').sort(),
    ).toEqual(['claude-code', 'codex']);
    expect(
      getAllRoomBindings('codex')['dc:arbiter-only-capability'],
    ).toMatchObject({
      name: 'Arbiter Only Capability',
      folder: 'arbiter-only-capability',
      agentType: 'codex',
    });
  });

  it('updates room_settings-backed metadata across tribunal capability views', () => {
    assignRoom('dc:projection-room', {
      name: 'Projection Room',
      roomMode: 'tribunal',
      ownerAgentType: 'codex',
      folder: 'projection-room',
    });

    updateRegisteredGroupName('dc:projection-room', 'Projection Room Renamed');

    expect(getStoredRoomSettings('dc:projection-room')).toMatchObject({
      chatJid: 'dc:projection-room',
      name: 'Projection Room Renamed',
      roomMode: 'tribunal',
      ownerAgentType: 'codex',
    });
    expect(
      getAllRoomBindings('claude-code')['dc:projection-room'],
    ).toMatchObject({
      name: 'Projection Room Renamed',
      folder: 'projection-room',
      agentType: 'claude-code',
    });
    expect(getAllRoomBindings('codex')['dc:projection-room']).toMatchObject({
      name: 'Projection Room Renamed',
      folder: 'projection-room',
      agentType: 'codex',
    });
  });

  it('does not carry an owner override config onto a different owner agent type', () => {
    assignRoom('dc:owner-switch', {
      name: 'Owner Switch',
      roomMode: 'tribunal',
      ownerAgentType: 'codex',
      folder: 'owner-switch',
      ownerAgentConfig: {
        codexModel: 'gpt-5-codex',
      },
    });

    assignRoom('dc:owner-switch', {
      name: 'Owner Switch',
      roomMode: 'tribunal',
      ownerAgentType: 'claude-code',
      folder: 'owner-switch',
    });

    expect(getAllRoomBindings('claude-code')['dc:owner-switch']).toMatchObject({
      agentType: 'claude-code',
    });
    expect(
      getAllRoomBindings('claude-code')['dc:owner-switch']?.agentConfig,
    ).toBeUndefined();
    expect(getAllRoomBindings('codex')['dc:owner-switch']).toMatchObject({
      agentType: 'codex',
    });
    expect(
      getAllRoomBindings('codex')['dc:owner-switch']?.agentConfig,
    ).toBeUndefined();
  });

  it('does not create a legacy room projection table when assigning a canonical room', () => {
    const tempDir = fs.mkdtempSync('/tmp/ejclaw-room-assign-canonical-');
    const dbPath = path.join(tempDir, 'messages.db');

    _initTestDatabaseFromFile(dbPath);
    assignRoom('dc:assign-no-projection', {
      name: 'Assign No Projection',
      roomMode: 'tribunal',
      ownerAgentType: 'codex',
      folder: 'assign-no-projection',
    });

    const rawDb = new Database(dbPath, { readonly: true });
    const legacyTable = rawDb
      .prepare(
        `SELECT name
           FROM sqlite_master
          WHERE type = 'table'
            AND name = 'registered_groups'`,
      )
      .get();
    rawDb.close();

    expect(legacyTable).toBeUndefined();
    expect(
      getAllRoomBindings('claude-code')['dc:assign-no-projection'],
    ).toMatchObject({
      name: 'Assign No Projection',
      folder: 'assign-no-projection',
      agentType: 'claude-code',
    });
    expect(
      getAllRoomBindings('codex')['dc:assign-no-projection'],
    ).toMatchObject({
      name: 'Assign No Projection',
      folder: 'assign-no-projection',
      agentType: 'codex',
    });
  });

  it('does not recreate inferred room_settings when renaming a legacy projection-only room', () => {
    _setRegisteredGroupForTests('dc:legacy-rename', {
      name: 'Legacy Rename',
      folder: 'legacy-rename',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      agentType: 'claude-code',
    });
    _setRegisteredGroupForTests('dc:legacy-rename', {
      name: 'Legacy Rename',
      folder: 'legacy-rename',
      trigger: '@Codex',
      added_at: '2024-01-01T00:00:00.000Z',
      agentType: 'codex',
    });

    _deleteStoredRoomSettingsForTests('dc:legacy-rename');
    expect(getStoredRoomSettings('dc:legacy-rename')).toBeUndefined();

    updateRegisteredGroupName('dc:legacy-rename', 'Legacy Rename Updated');

    expect(getStoredRoomSettings('dc:legacy-rename')).toBeUndefined();
    expect(getRegisteredGroup('dc:legacy-rename')).toBeUndefined();
    expect(
      getAllRoomBindings('claude-code')['dc:legacy-rename'],
    ).toBeUndefined();
    expect(getAllRoomBindings('codex')['dc:legacy-rename']).toBeUndefined();
  });
});

describe('room role model overrides', () => {
  it('stores per-role model selections in role override agent configs', () => {
    assignRoom('dc:role-models', {
      name: 'Role Models',
      roomMode: 'tribunal',
      ownerAgentType: 'claude-code',
      reviewerAgentType: 'codex',
      arbiterAgentType: 'codex',
      folder: 'role-models',
      ownerModelSelection: { model: 'claude-opus-4-8', effort: 'max' },
      reviewerModelSelection: { model: 'gpt-5.5', effort: 'xhigh' },
      arbiterModelSelection: { model: 'gpt-5.5-pro' },
    });

    expect(getRoomRoleAgentConfig('dc:role-models', 'owner')).toEqual({
      claudeModel: 'claude-opus-4-8',
      claudeEffort: 'max',
    });
    expect(getRoomRoleAgentConfig('dc:role-models', 'reviewer')).toEqual({
      codexModel: 'gpt-5.5',
      codexEffort: 'xhigh',
    });
    expect(getRoomRoleAgentConfig('dc:role-models', 'arbiter')).toEqual({
      codexModel: 'gpt-5.5-pro',
    });
  });

  it('keeps stored role models on re-assign and clears them via empty selections', () => {
    assignRoom('dc:role-model-clear', {
      name: 'Role Model Clear',
      roomMode: 'tribunal',
      ownerAgentType: 'claude-code',
      reviewerAgentType: 'codex',
      folder: 'role-model-clear',
      ownerModelSelection: { model: 'claude-opus-4-8', effort: 'high' },
    });

    // Re-assign without selections keeps stored values.
    assignRoom('dc:role-model-clear', {
      name: 'Role Model Clear',
      roomMode: 'tribunal',
      ownerAgentType: 'claude-code',
      reviewerAgentType: 'codex',
    });
    expect(getRoomRoleAgentConfig('dc:role-model-clear', 'owner')).toEqual({
      claudeModel: 'claude-opus-4-8',
      claudeEffort: 'high',
    });

    // A null model clears just the model and keeps the effort.
    assignRoom('dc:role-model-clear', {
      name: 'Role Model Clear',
      roomMode: 'tribunal',
      ownerAgentType: 'claude-code',
      reviewerAgentType: 'codex',
      ownerModelSelection: { model: null },
    });
    expect(getRoomRoleAgentConfig('dc:role-model-clear', 'owner')).toEqual({
      claudeEffort: 'high',
    });

    // Clearing the last key removes the config entirely.
    assignRoom('dc:role-model-clear', {
      name: 'Role Model Clear',
      roomMode: 'tribunal',
      ownerAgentType: 'claude-code',
      reviewerAgentType: 'codex',
      ownerModelSelection: { effort: null },
    });
    expect(
      getRoomRoleAgentConfig('dc:role-model-clear', 'owner'),
    ).toBeUndefined();
  });

  it('updates a single role agent config in place', () => {
    assignRoom('dc:role-model-update', {
      name: 'Role Model Update',
      roomMode: 'tribunal',
      ownerAgentType: 'claude-code',
      reviewerAgentType: 'codex',
      folder: 'role-model-update',
    });

    expect(
      updateRoomRoleAgentConfig('dc:role-model-update', 'reviewer', {
        codexModel: 'gpt-5.4',
      }),
    ).toBe(true);
    expect(getRoomRoleAgentConfig('dc:role-model-update', 'reviewer')).toEqual({
      codexModel: 'gpt-5.4',
    });

    // Unknown role rows are reported as not updated.
    expect(
      updateRoomRoleAgentConfig('dc:missing-room', 'owner', {
        claudeModel: 'claude-opus-4-8',
      }),
    ).toBe(false);
  });
});

describe('legacy room registration migration', () => {
  it('requires explicit migration before init when only legacy registered_groups rows exist', () => {
    const tempDir = fs.mkdtempSync('/tmp/ejclaw-legacy-room-settings-init-');
    const dbPath = path.join(tempDir, 'messages.db');
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
      );
    `);

    const insertGroup = legacyDb.prepare(
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
      ) VALUES (?, ?, ?, ?, ?, NULL, 1, 0, ?, NULL)`,
    );
    insertGroup.run(
      'dc:legacy-sql',
      'Legacy SQL Room',
      'legacy-sql-room',
      '@Claude',
      '2024-01-01T00:00:00.000Z',
      'claude-code',
    );
    insertGroup.run(
      'dc:legacy-sql',
      'Legacy SQL Room',
      'legacy-sql-room',
      '@Codex',
      '2024-01-01T00:00:00.000Z',
      'codex',
    );
    legacyDb.close();

    expect(() => _initTestDatabaseFromFile(dbPath)).toThrow(
      /Legacy room migration required before startup/,
    );
    const rawDbBeforeMigration = new Database(dbPath, { readonly: true });
    expect(
      rawDbBeforeMigration
        .prepare(
          `SELECT COUNT(*) as count
             FROM room_settings`,
        )
        .get(),
    ).toEqual({ count: 0 });
    expect(
      rawDbBeforeMigration
        .prepare(
          `SELECT COUNT(*) as count
             FROM room_role_overrides`,
        )
        .get(),
    ).toEqual({ count: 0 });
    expect(
      rawDbBeforeMigration
        .prepare(
          `SELECT jid, agent_type
             FROM registered_groups
            ORDER BY jid, agent_type`,
        )
        .all(),
    ).toEqual([
      { jid: 'dc:legacy-sql', agent_type: 'claude-code' },
      { jid: 'dc:legacy-sql', agent_type: 'codex' },
    ]);
    rawDbBeforeMigration.close();
    expect(migrateLegacyRoomRegistrationsInFile(dbPath)).toEqual({
      migratedRooms: 1,
      migratedRoleOverrides: 2,
    });
    _initTestDatabaseFromFile(dbPath);

    expect(getStoredRoomSettings('dc:legacy-sql')).toMatchObject({
      chatJid: 'dc:legacy-sql',
      roomMode: 'tribunal',
      modeSource: 'inferred',
      name: 'Legacy SQL Room',
      folder: 'legacy-sql-room',
      ownerAgentType: 'codex',
    });
    expect(getEffectiveRoomMode('dc:legacy-sql')).toBe('tribunal');
    expect(getEffectiveRuntimeRoomMode('dc:legacy-sql')).toBe('tribunal');
  });

  it('fails explicit migration when legacy registered_groups rows conflict on room-level metadata', () => {
    const tempDir = fs.mkdtempSync('/tmp/ejclaw-legacy-room-conflict-init-');
    const dbPath = path.join(tempDir, 'messages.db');
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
      );
    `);

    const insertGroup = legacyDb.prepare(
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
      ) VALUES (?, ?, ?, ?, ?, NULL, 1, 0, ?, NULL)`,
    );
    insertGroup.run(
      'dc:legacy-conflict',
      'Legacy Conflict Room',
      'legacy-conflict-a',
      '@Claude',
      '2024-01-01T00:00:00.000Z',
      'claude-code',
    );
    insertGroup.run(
      'dc:legacy-conflict',
      'Legacy Conflict Room',
      'legacy-conflict-b',
      '@Codex',
      '2024-01-01T00:00:00.000Z',
      'codex',
    );
    legacyDb.close();

    expect(() => _initTestDatabaseFromFile(dbPath)).toThrow(
      /Legacy room migration required before startup/,
    );
    expect(() => migrateLegacyRoomRegistrationsInFile(dbPath)).toThrow(
      /Conflicting room-level registered_groups metadata/,
    );
  });
});

describe('legacy room settings conflicts', () => {
  it('requires explicit migration before init when room_settings conflicts with legacy room-level metadata', () => {
    const tempDir = fs.mkdtempSync('/tmp/ejclaw-legacy-room-mixed-conflict-');
    const dbPath = path.join(tempDir, 'messages.db');
    const legacyDb = new Database(dbPath);

    legacyDb.exec(`
      CREATE TABLE room_settings (
        chat_jid TEXT PRIMARY KEY,
        room_mode TEXT NOT NULL DEFAULT 'single',
        mode_source TEXT NOT NULL DEFAULT 'explicit',
        name TEXT,
        folder TEXT,
        trigger_pattern TEXT,
        requires_trigger INTEGER,
        is_main INTEGER,
        owner_agent_type TEXT,
        work_dir TEXT,
        updated_at TEXT
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
        agent_type TEXT NOT NULL DEFAULT 'claude-code',
        work_dir TEXT,
        PRIMARY KEY (jid, agent_type),
        UNIQUE (folder, agent_type)
      );
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
        'dc:mixed-conflict',
        'single',
        'explicit',
        'Canonical Room',
        'canonical-folder',
        '@Andy',
        1,
        0,
        'codex',
        null,
        '2026-04-08T00:00:00.000Z',
      );
    legacyDb
      .prepare(
        `INSERT INTO room_role_overrides (
          chat_jid,
          role,
          agent_type,
          agent_config_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'dc:mixed-conflict',
        'owner',
        'codex',
        null,
        '2026-04-08T00:00:00.000Z',
        '2026-04-08T00:00:00.000Z',
      );

    const insertGroup = legacyDb.prepare(
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
      ) VALUES (?, ?, ?, ?, ?, NULL, 1, 0, ?, NULL)`,
    );
    insertGroup.run(
      'dc:mixed-conflict',
      'Legacy Room',
      'legacy-folder',
      '@Codex',
      '2026-04-08T00:00:00.000Z',
      'codex',
    );
    legacyDb.close();

    const pendingDb = new Database(dbPath, { readonly: true });
    expect(getPendingLegacyRegisteredGroupJidsForTests(pendingDb)).toEqual([
      'dc:mixed-conflict',
    ]);
    pendingDb.close();
    expect(() => _initTestDatabaseFromFile(dbPath)).toThrow(
      /Legacy room migration required before startup/,
    );
  });

  it('fails init when unsupported router_state DB keys remain without canonical keys', () => {
    const tempDir = fs.mkdtempSync('/tmp/ejclaw-legacy-router-state-db-');
    const dbPath = path.join(tempDir, 'messages.db');
    const legacyDb = new Database(dbPath);

    initializeDatabaseSchema(legacyDb);
    legacyDb
      .prepare('INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)')
      .run('last_timestamp', '1234');
    legacyDb
      .prepare('INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)')
      .run('last_agent_timestamp', '{"dc:room":"5678"}');
    legacyDb.close();

    expect(() => _initTestDatabaseFromFile(dbPath)).toThrow(
      /Unsupported router_state DB keys remain before startup \(keys=last_agent_timestamp,last_timestamp\)/,
    );

    const rawDb = new Database(dbPath, { readonly: true });
    expect(
      rawDb
        .prepare(
          `SELECT key, value
           FROM router_state
           ORDER BY key`,
        )
        .all(),
    ).toEqual([
      { key: 'last_agent_timestamp', value: '{"dc:room":"5678"}' },
      { key: 'last_timestamp', value: '1234' },
    ]);
    rawDb.close();
  });
});

describe('stale legacy capability rows', () => {
  it('ignores stale registered_groups capability rows once room_settings exists', () => {
    const tempDir = fs.mkdtempSync('/tmp/ejclaw-room-ssot-');
    const dbPath = path.join(tempDir, 'messages.db');
    const legacyDb = new Database(dbPath);

    legacyDb.exec(`
      CREATE TABLE room_settings (
        chat_jid TEXT PRIMARY KEY,
        room_mode TEXT NOT NULL DEFAULT 'single',
        mode_source TEXT NOT NULL DEFAULT 'explicit',
        name TEXT,
        folder TEXT,
        trigger_pattern TEXT,
        requires_trigger INTEGER,
        is_main INTEGER,
        owner_agent_type TEXT,
        work_dir TEXT,
        updated_at TEXT
      );

      CREATE TABLE registered_groups (
        jid TEXT NOT NULL,
        name TEXT NOT NULL,
        folder TEXT NOT NULL,
        trigger_pattern TEXT NOT NULL,
        added_at TEXT NOT NULL,
        agent_config TEXT,
        requires_trigger INTEGER,
        is_main INTEGER,
        agent_type TEXT,
        work_dir TEXT,
        PRIMARY KEY (jid, agent_type),
        UNIQUE (folder, agent_type)
      );
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
        'dc:ssot-room',
        'single',
        'explicit',
        'SSOT Room',
        'ssot-room',
        '@Andy',
        1,
        0,
        'codex',
        null,
        '2026-04-08T00:00:00.000Z',
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
        'dc:ssot-room',
        'SSOT Room',
        'ssot-room',
        '@Codex',
        '2026-04-08T00:00:00.000Z',
        null,
        1,
        0,
        'codex',
        null,
      );

    legacyDb
      .prepare(
        `INSERT OR REPLACE INTO registered_groups (
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
        'dc:ssot-room',
        'SSOT Room',
        'ssot-room',
        '@Claude',
        '2026-04-08T00:00:00.000Z',
        null,
        1,
        0,
        'claude-code',
        null,
      );
    legacyDb.close();

    expect(migrateLegacyRoomRegistrationsInFile(dbPath)).toEqual({
      migratedRooms: 0,
      migratedRoleOverrides: 1,
    });
    _initTestDatabaseFromFile(dbPath);

    expect(getRegisteredGroup('dc:ssot-room')).toMatchObject({
      folder: 'ssot-room',
      agentType: 'codex',
    });
    expect(getRegisteredGroup('dc:ssot-room', 'claude-code')).toBeUndefined();
    expect(getAllRoomBindings('claude-code')['dc:ssot-room']).toBeUndefined();
    expect(getRegisteredAgentTypesForJid('dc:ssot-room')).toEqual(['codex']);
  });
});

describe('canonical room metadata writeback', () => {
  it('keeps canonical room metadata writable after explicit migration drops the legacy table', () => {
    const tempDir = fs.mkdtempSync('/tmp/ejclaw-room-writeback-');
    const dbPath = path.join(tempDir, 'messages.db');
    const legacyDb = new Database(dbPath);

    legacyDb.exec(`
      CREATE TABLE room_settings (
        chat_jid TEXT PRIMARY KEY,
        room_mode TEXT NOT NULL DEFAULT 'single',
        mode_source TEXT NOT NULL DEFAULT 'explicit',
        name TEXT,
        folder TEXT,
        trigger_pattern TEXT,
        requires_trigger INTEGER,
        is_main INTEGER,
        owner_agent_type TEXT,
        work_dir TEXT,
        updated_at TEXT
      );

      CREATE TABLE registered_groups (
        jid TEXT NOT NULL,
        name TEXT NOT NULL,
        folder TEXT NOT NULL,
        trigger_pattern TEXT NOT NULL,
        added_at TEXT NOT NULL,
        agent_config TEXT,
        requires_trigger INTEGER,
        is_main INTEGER,
        agent_type TEXT,
        work_dir TEXT,
        PRIMARY KEY (jid, agent_type),
        UNIQUE (folder, agent_type)
      );
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
        'dc:ssot-writeback',
        'single',
        'explicit',
        'Explicit Writeback',
        'ssot-writeback',
        '@Codex',
        1,
        0,
        'codex',
        null,
        '2026-04-08T00:00:00.000Z',
      );

    const insertProjection = legacyDb.prepare(
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
    );

    insertProjection.run(
      'dc:ssot-writeback',
      'Explicit Writeback',
      'ssot-writeback',
      '@Codex',
      '2026-04-08T00:00:00.000Z',
      null,
      1,
      0,
      'codex',
      null,
    );
    insertProjection.run(
      'dc:ssot-writeback',
      'Explicit Writeback',
      'ssot-writeback',
      '@Claude',
      '2026-04-08T00:00:00.000Z',
      null,
      1,
      0,
      'claude-code',
      null,
    );
    legacyDb.close();

    expect(migrateLegacyRoomRegistrationsInFile(dbPath)).toEqual({
      migratedRooms: 0,
      migratedRoleOverrides: 1,
    });
    _initTestDatabaseFromFile(dbPath);

    updateRegisteredGroupName('dc:ssot-writeback', 'SSOT Writeback Renamed');

    expect(getStoredRoomSettings('dc:ssot-writeback')).toMatchObject({
      chatJid: 'dc:ssot-writeback',
      roomMode: 'single',
      modeSource: 'explicit',
      name: 'SSOT Writeback Renamed',
      ownerAgentType: 'codex',
    });

    const rawDb = new Database(dbPath, { readonly: true });
    const legacyTable = rawDb
      .prepare(
        `SELECT name
           FROM sqlite_master
          WHERE type = 'table'
            AND name = 'registered_groups'`,
      )
      .get();
    rawDb.close();

    expect(legacyTable).toBeUndefined();

    _initTestDatabaseFromFile(dbPath);

    expect(getStoredRoomSettings('dc:ssot-writeback')).toMatchObject({
      chatJid: 'dc:ssot-writeback',
      roomMode: 'single',
      modeSource: 'explicit',
      name: 'SSOT Writeback Renamed',
      ownerAgentType: 'codex',
    });
    clearExplicitRoomMode('dc:ssot-writeback');

    expect(getExplicitRoomMode('dc:ssot-writeback')).toBeUndefined();
    expect(getEffectiveRoomMode('dc:ssot-writeback')).toBe('single');
  });
});
