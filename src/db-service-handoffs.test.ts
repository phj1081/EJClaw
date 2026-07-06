import { Database } from 'bun:sqlite';
import fs from 'fs';
import path from 'path';

import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  _initTestDatabaseFromFile,
  assignRoom,
  claimServiceHandoff,
  completeServiceHandoffAndAdvanceTargetCursor,
  createServiceHandoff,
  getPendingServiceHandoffs,
  getPairedTurnById,
  getRouterState,
  setRouterState,
  storeChatMetadata,
} from './db.js';
import { initializeDatabaseSchema } from './db/bootstrap.js';
import {
  CLAUDE_SERVICE_ID,
  CODEX_MAIN_SERVICE_ID,
  CODEX_REVIEW_SERVICE_ID,
} from './config.js';
import { store } from '../test/helpers/db-test-utils.js';

beforeEach(() => {
  _initTestDatabase();
});

describe('service handoff completion', () => {
  it('atomically completes the handoff and advances the target cursor', () => {
    storeChatMetadata('dc:handoff', '2024-01-01T00:00:00.000Z');
    store({
      id: 'handoff-msg-1',
      chat_jid: 'dc:handoff',
      sender: 'user',
      sender_name: 'User',
      content: 'hello',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    const handoff = createServiceHandoff({
      chat_jid: 'dc:handoff',
      group_folder: 'test-group',
      source_service_id: 'claude',
      target_service_id: 'codex-review',
      target_agent_type: 'codex',
      prompt: 'hello',
      end_seq: 1,
    });

    expect(claimServiceHandoff(handoff.id)).toBe(true);

    const appliedCursor = completeServiceHandoffAndAdvanceTargetCursor({
      id: handoff.id,
      chat_jid: 'dc:handoff',
      end_seq: 1,
    });

    expect(appliedCursor).toBe('1');
    expect(getPendingServiceHandoffs('codex-review')).toEqual([]);
    expect(JSON.parse(getRouterState('last_agent_seq') || '{}')).toMatchObject({
      'dc:handoff': '1',
    });
  });

  it('does not move the target cursor backwards when a newer cursor already exists', () => {
    storeChatMetadata('dc:handoff', '2024-01-01T00:00:00.000Z');
    setRouterState('last_agent_seq', JSON.stringify({ 'dc:handoff': '5' }));
    const handoff = createServiceHandoff({
      chat_jid: 'dc:handoff',
      group_folder: 'test-group',
      source_service_id: 'claude',
      target_service_id: 'codex-review',
      target_agent_type: 'codex',
      prompt: 'hello',
      end_seq: 3,
    });

    expect(claimServiceHandoff(handoff.id)).toBe(true);

    const appliedCursor = completeServiceHandoffAndAdvanceTargetCursor({
      id: handoff.id,
      chat_jid: 'dc:handoff',
      end_seq: 3,
    });

    expect(appliedCursor).toBe('5');
    expect(JSON.parse(getRouterState('last_agent_seq') || '{}')).toMatchObject({
      'dc:handoff': '5',
    });
  });

  it('stores the intended handoff role when provided', () => {
    const handoff = createServiceHandoff({
      chat_jid: 'dc:handoff-role',
      group_folder: 'test-group',
      source_service_id: 'claude',
      target_service_id: 'codex-review',
      source_role: 'owner',
      target_role: 'reviewer',
      target_agent_type: 'codex',
      prompt: 'please review',
      reason: 'reviewer-claude-429',
      intended_role: 'reviewer',
    });

    expect(handoff.intended_role).toBe('reviewer');
    expect(handoff.source_role).toBe('owner');
    expect(handoff.target_role).toBe('reviewer');
    expect(getPendingServiceHandoffs('codex-review')).toEqual([
      expect.objectContaining({
        id: handoff.id,
        source_role: 'owner',
        target_role: 'reviewer',
        intended_role: 'reviewer',
        reason: 'reviewer-claude-429',
      }),
    ]);
  });

  it('derives handoff service shadows from role and agent metadata when raw service ids are omitted', () => {
    const handoff = createServiceHandoff({
      chat_jid: 'dc:handoff-derived-shadow',
      group_folder: 'handoff-derived-shadow',
      source_role: 'owner',
      source_agent_type: 'codex',
      target_role: 'reviewer',
      target_agent_type: 'claude-code',
      prompt: 'review this',
      intended_role: 'reviewer',
    });

    expect(handoff).toMatchObject({
      source_service_id: CODEX_MAIN_SERVICE_ID,
      target_service_id: CLAUDE_SERVICE_ID,
      source_role: 'owner',
      target_role: 'reviewer',
      target_agent_type: 'claude-code',
    });
  });

  it('stores handoff cursors under the provided role-scoped cursor key', () => {
    storeChatMetadata('dc:handoff-role-cursor', '2024-01-01T00:00:00.000Z');
    const handoff = createServiceHandoff({
      chat_jid: 'dc:handoff-role-cursor',
      group_folder: 'test-group',
      source_service_id: 'claude',
      target_service_id: 'codex-review',
      source_role: 'owner',
      target_role: 'reviewer',
      target_agent_type: 'codex',
      prompt: 'hello reviewer',
      end_seq: 7,
      intended_role: 'reviewer',
    });

    expect(claimServiceHandoff(handoff.id)).toBe(true);

    const appliedCursor = completeServiceHandoffAndAdvanceTargetCursor({
      id: handoff.id,
      chat_jid: 'dc:handoff-role-cursor',
      cursor_key: 'dc:handoff-role-cursor:reviewer',
      end_seq: 7,
    });

    expect(appliedCursor).toBe('7');
    expect(JSON.parse(getRouterState('last_agent_seq') || '{}')).toMatchObject({
      'dc:handoff-role-cursor:reviewer': '7',
    });
  });

  it('derives owner handoff service ids as stable role-slot shadows when raw ids are omitted', () => {
    assignRoom('dc:handoff-owner-shadow', {
      name: 'Owner Handoff Shadow',
      roomMode: 'tribunal',
      ownerAgentType: 'codex',
      folder: 'owner-handoff-shadow',
    });

    const handoff = createServiceHandoff({
      chat_jid: 'dc:handoff-owner-shadow',
      group_folder: 'owner-handoff-shadow',
      source_role: 'owner',
      target_role: 'owner',
      source_agent_type: 'codex',
      target_agent_type: 'codex',
      prompt: 'owner fallback',
      reason: 'claude-usage-exhausted',
      intended_role: 'owner',
    });

    expect(handoff.source_service_id).toBe(CODEX_MAIN_SERVICE_ID);
    expect(handoff.target_service_id).toBe(CODEX_MAIN_SERVICE_ID);
    expect(getPendingServiceHandoffs(CODEX_MAIN_SERVICE_ID)).toEqual([
      expect.objectContaining({
        id: handoff.id,
        source_service_id: CODEX_MAIN_SERVICE_ID,
        target_service_id: CODEX_MAIN_SERVICE_ID,
        source_role: 'owner',
        target_role: 'owner',
      }),
    ]);
  });
});

describe('service handoff service ids', () => {
  it('preserves stored owner handoff service ids during init when service id columns already exist', () => {
    const tempDir = fs.mkdtempSync('/tmp/ejclaw-handoff-shadow-');
    const dbPath = path.join(tempDir, 'messages.db');
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
      CREATE TABLE service_handoffs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_jid TEXT NOT NULL,
        group_folder TEXT NOT NULL,
        source_service_id TEXT NOT NULL,
        target_service_id TEXT NOT NULL,
        source_role TEXT,
        target_role TEXT,
        target_agent_type TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        start_seq INTEGER,
        end_seq INTEGER,
        reason TEXT,
        intended_role TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        claimed_at TEXT,
        completed_at TEXT,
        last_error TEXT
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
        'dc:handoff-owner-shadow',
        'tribunal',
        'explicit',
        'Owner Handoff Shadow',
        'owner-handoff-shadow',
        '@Owner',
        1,
        0,
        'codex',
        null,
        '2026-03-28T00:00:00.000Z',
      );

    legacyDb
      .prepare(
        `INSERT INTO service_handoffs (
          chat_jid,
          group_folder,
          source_service_id,
          target_service_id,
          source_role,
          target_role,
          target_agent_type,
          prompt,
          status,
          reason,
          intended_role,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'dc:handoff-owner-shadow',
        'owner-handoff-shadow',
        CLAUDE_SERVICE_ID,
        CODEX_REVIEW_SERVICE_ID,
        'owner',
        'owner',
        'codex',
        'owner fallback',
        'pending',
        'claude-usage-exhausted',
        'owner',
        '2026-03-28T00:00:00.000Z',
      );
    legacyDb.close();

    _initTestDatabaseFromFile(dbPath);

    expect(getPendingServiceHandoffs(CODEX_REVIEW_SERVICE_ID)).toEqual([
      expect.objectContaining({
        chat_jid: 'dc:handoff-owner-shadow',
        source_service_id: CLAUDE_SERVICE_ID,
        target_service_id: CODEX_REVIEW_SERVICE_ID,
        source_role: 'owner',
        target_role: 'owner',
      }),
    ]);
  });

  it('fails startup when stored handoff agent metadata conflicts with service ids', () => {
    const tempDir = fs.mkdtempSync('/tmp/ejclaw-handoff-metadata-conflict-');
    const dbPath = path.join(tempDir, 'messages.db');
    const legacyDb = new Database(dbPath);

    legacyDb.exec(`
      CREATE TABLE service_handoffs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_jid TEXT NOT NULL,
        group_folder TEXT NOT NULL,
        source_service_id TEXT NOT NULL,
        target_service_id TEXT NOT NULL,
        source_role TEXT,
        source_agent_type TEXT,
        target_role TEXT,
        target_agent_type TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        start_seq INTEGER,
        end_seq INTEGER,
        reason TEXT,
        intended_role TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        claimed_at TEXT,
        completed_at TEXT,
        last_error TEXT
      );
    `);
    legacyDb
      .prepare(
        `INSERT INTO service_handoffs (
          chat_jid,
          group_folder,
          source_service_id,
          target_service_id,
          source_role,
          source_agent_type,
          target_role,
          target_agent_type,
          prompt,
          status,
          intended_role,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'dc:handoff-conflict',
        'handoff-conflict',
        CODEX_REVIEW_SERVICE_ID,
        CLAUDE_SERVICE_ID,
        'reviewer',
        'claude-code',
        'reviewer',
        'codex',
        'conflicting handoff metadata',
        'pending',
        'reviewer',
        '2026-04-10T00:00:00.000Z',
      );
    legacyDb.close();

    expect(() => _initTestDatabaseFromFile(dbPath)).toThrow(
      /source_agent_type conflicts with source_service_id/,
    );
  });

  it('fails startup when stored handoff role metadata conflicts with service shadows', () => {
    const tempDir = fs.mkdtempSync('/tmp/ejclaw-handoff-role-shadow-conflict-');
    const dbPath = path.join(tempDir, 'messages.db');
    const legacyDb = new Database(dbPath);

    legacyDb.exec(`
      CREATE TABLE service_handoffs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_jid TEXT NOT NULL,
        group_folder TEXT NOT NULL,
        source_service_id TEXT NOT NULL,
        target_service_id TEXT NOT NULL,
        source_role TEXT,
        source_agent_type TEXT,
        target_role TEXT,
        target_agent_type TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        start_seq INTEGER,
        end_seq INTEGER,
        reason TEXT,
        intended_role TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        claimed_at TEXT,
        completed_at TEXT,
        last_error TEXT
      );
    `);
    legacyDb
      .prepare(
        `INSERT INTO service_handoffs (
          chat_jid,
          group_folder,
          source_service_id,
          target_service_id,
          source_role,
          source_agent_type,
          target_role,
          target_agent_type,
          prompt,
          status,
          intended_role,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'dc:handoff-role-conflict',
        'handoff-role-conflict',
        CLAUDE_SERVICE_ID,
        CODEX_MAIN_SERVICE_ID,
        'owner',
        'claude-code',
        'reviewer',
        'codex',
        'conflicting handoff role shadow',
        'pending',
        'reviewer',
        '2026-04-10T00:00:00.000Z',
      );
    legacyDb.close();

    expect(() => _initTestDatabaseFromFile(dbPath)).toThrow(
      /target_role conflicts with target_service_id/,
    );
  });
});

describe('service handoff canonical metadata', () => {
  it('fails fast when a service handoff row loses canonical target metadata after init', () => {
    const tempDir = fs.mkdtempSync('/tmp/ejclaw-handoff-strict-read-');
    const dbPath = path.join(tempDir, 'messages.db');

    try {
      const fileDb = new Database(dbPath);
      initializeDatabaseSchema(fileDb);
      fileDb.close();

      _initTestDatabaseFromFile(dbPath);
      const handoff = createServiceHandoff({
        chat_jid: 'dc:handoff-strict-read',
        group_folder: 'handoff-strict-read',
        source_service_id: CLAUDE_SERVICE_ID,
        target_service_id: CODEX_REVIEW_SERVICE_ID,
        source_role: 'owner',
        target_role: 'reviewer',
        source_agent_type: 'claude-code',
        target_agent_type: 'codex',
        prompt: 'strict read handoff',
        intended_role: 'reviewer',
      });

      const rawDb = new Database(dbPath);
      rawDb
        .prepare(
          `UPDATE service_handoffs
              SET target_agent_type = ''
            WHERE id = ?`,
        )
        .run(handoff.id);
      rawDb.close();

      expect(() => getPendingServiceHandoffs(CODEX_REVIEW_SERVICE_ID)).toThrow(
        /cannot read target_agent_type from stored row metadata/,
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      _initTestDatabase();
    }
  });

  it('preserves an explicit reviewer target service id when creating a new handoff', () => {
    const handoff = createServiceHandoff({
      chat_jid: 'dc:handoff-stored-reviewer',
      group_folder: 'handoff-stored-reviewer',
      paired_task_id: 'task-stored-reviewer-handoff',
      paired_task_updated_at: '2026-04-10T00:00:00.000Z',
      turn_intent_kind: 'reviewer-turn',
      turn_role: 'reviewer',
      source_service_id: CLAUDE_SERVICE_ID,
      target_service_id: 'stale-reviewer-shadow',
      source_role: 'owner',
      target_role: 'reviewer',
      source_agent_type: 'claude-code',
      target_agent_type: 'codex',
      prompt: 'stored reviewer service id',
      intended_role: 'reviewer',
    });

    expect(handoff.target_service_id).toBe('stale-reviewer-shadow');
    expect(handoff.turn_id).toBe(
      'task-stored-reviewer-handoff:2026-04-10T00:00:00.000Z:reviewer-turn',
    );
    expect(handoff.turn_attempt_no).toBe(1);
    expect(handoff.turn_role).toBe('reviewer');
    expect(
      getPairedTurnById(
        'task-stored-reviewer-handoff:2026-04-10T00:00:00.000Z:reviewer-turn',
      ),
    ).toMatchObject({
      turn_id:
        'task-stored-reviewer-handoff:2026-04-10T00:00:00.000Z:reviewer-turn',
      task_id: 'task-stored-reviewer-handoff',
      role: 'reviewer',
      intent_kind: 'reviewer-turn',
      state: 'delegated',
      executor_service_id: 'stale-reviewer-shadow',
      executor_agent_type: 'codex',
    });
    expect(getPendingServiceHandoffs('stale-reviewer-shadow')).toEqual([
      expect.objectContaining({
        id: handoff.id,
        paired_task_id: 'task-stored-reviewer-handoff',
        paired_task_updated_at: '2026-04-10T00:00:00.000Z',
        turn_id:
          'task-stored-reviewer-handoff:2026-04-10T00:00:00.000Z:reviewer-turn',
        turn_attempt_no: 1,
        turn_intent_kind: 'reviewer-turn',
        turn_role: 'reviewer',
        source_service_id: CLAUDE_SERVICE_ID,
        target_service_id: 'stale-reviewer-shadow',
        source_role: 'owner',
        target_role: 'reviewer',
      }),
    ]);
  });
});
