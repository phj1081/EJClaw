import { Database } from 'bun:sqlite';
import fs from 'fs';
import path from 'path';

import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  _initTestDatabaseFromFile,
  createPairedTask,
  createServiceHandoff,
  getChannelOwnerLease,
  getPendingServiceHandoffs,
  getPairedTaskById,
  setChannelOwnerLease,
} from './db.js';
import {
  ARBITER_AGENT_TYPE,
  CLAUDE_SERVICE_ID,
  CODEX_REVIEW_SERVICE_ID,
} from './config.js';

beforeEach(() => {
  _initTestDatabase();
});

describe('legacy schema writes after init', () => {
  it('creates paired tasks after init on a legacy paired_tasks schema', () => {
    const tempDir = fs.mkdtempSync('/tmp/ejclaw-legacy-paired-task-write-');
    const dbPath = path.join(tempDir, 'messages.db');
    const legacyDb = new Database(dbPath);

    legacyDb.exec(`
      CREATE TABLE paired_tasks (
        id TEXT PRIMARY KEY,
        chat_jid TEXT NOT NULL,
        group_folder TEXT NOT NULL,
        owner_service_id TEXT NOT NULL,
        reviewer_service_id TEXT NOT NULL,
        owner_agent_type TEXT,
        reviewer_agent_type TEXT,
        arbiter_agent_type TEXT,
        title TEXT,
        source_ref TEXT,
        plan_notes TEXT,
        review_requested_at TEXT,
        round_trip_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        arbiter_verdict TEXT,
        arbiter_requested_at TEXT,
        completion_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    legacyDb.close();

    _initTestDatabaseFromFile(dbPath);

    createPairedTask({
      id: 'paired-legacy-write',
      chat_jid: 'dc:legacy-write',
      group_folder: 'legacy-write-room',
      owner_service_id: CLAUDE_SERVICE_ID,
      reviewer_service_id: CODEX_REVIEW_SERVICE_ID,
      owner_agent_type: 'claude-code',
      reviewer_agent_type: 'codex',
      arbiter_agent_type: ARBITER_AGENT_TYPE ?? null,
      title: 'legacy write task',
      source_ref: 'HEAD',
      plan_notes: null,
      review_requested_at: null,
      round_trip_count: 0,
      status: 'active',
      arbiter_verdict: null,
      arbiter_requested_at: null,
      completion_reason: null,
      created_at: '2026-03-28T00:00:00.000Z',
      updated_at: '2026-03-28T00:00:00.000Z',
    });

    expect(getPairedTaskById('paired-legacy-write')).toMatchObject({
      owner_service_id: CLAUDE_SERVICE_ID,
      reviewer_service_id: CODEX_REVIEW_SERVICE_ID,
      owner_agent_type: 'claude-code',
      reviewer_agent_type: 'codex',
    });
  });

  it('creates paired tasks after init on a canonical paired_tasks schema without service id columns', () => {
    const tempDir = fs.mkdtempSync('/tmp/ejclaw-canonical-paired-task-write-');
    const dbPath = path.join(tempDir, 'messages.db');
    const legacyDb = new Database(dbPath);

    legacyDb.exec(`
      CREATE TABLE paired_tasks (
        id TEXT PRIMARY KEY,
        chat_jid TEXT NOT NULL,
        group_folder TEXT NOT NULL,
        owner_agent_type TEXT,
        reviewer_agent_type TEXT,
        arbiter_agent_type TEXT,
        title TEXT,
        source_ref TEXT,
        plan_notes TEXT,
        review_requested_at TEXT,
        round_trip_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        arbiter_verdict TEXT,
        arbiter_requested_at TEXT,
        completion_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    legacyDb.close();

    _initTestDatabaseFromFile(dbPath);

    createPairedTask({
      id: 'paired-canonical-write',
      chat_jid: 'dc:canonical-write',
      group_folder: 'canonical-write-room',
      owner_service_id: CLAUDE_SERVICE_ID,
      reviewer_service_id: CODEX_REVIEW_SERVICE_ID,
      owner_agent_type: 'claude-code',
      reviewer_agent_type: 'codex',
      arbiter_agent_type: ARBITER_AGENT_TYPE ?? null,
      title: 'canonical write task',
      source_ref: 'HEAD',
      plan_notes: null,
      review_requested_at: null,
      round_trip_count: 0,
      status: 'active',
      arbiter_verdict: null,
      arbiter_requested_at: null,
      completion_reason: null,
      created_at: '2026-03-28T00:00:00.000Z',
      updated_at: '2026-03-28T00:00:00.000Z',
    });

    expect(getPairedTaskById('paired-canonical-write')).toMatchObject({
      owner_service_id: CLAUDE_SERVICE_ID,
      reviewer_service_id: CODEX_REVIEW_SERVICE_ID,
      owner_agent_type: 'claude-code',
      reviewer_agent_type: 'codex',
    });
  });

  it('creates channel owner leases after init on a legacy channel_owner schema', () => {
    const tempDir = fs.mkdtempSync('/tmp/ejclaw-legacy-channel-owner-write-');
    const dbPath = path.join(tempDir, 'messages.db');
    const legacyDb = new Database(dbPath);

    legacyDb.exec(`
      CREATE TABLE channel_owner (
        chat_jid TEXT PRIMARY KEY,
        owner_service_id TEXT NOT NULL,
        reviewer_service_id TEXT,
        arbiter_service_id TEXT,
        owner_agent_type TEXT,
        reviewer_agent_type TEXT,
        arbiter_agent_type TEXT,
        activated_at TEXT,
        reason TEXT
      );
    `);
    legacyDb.close();

    _initTestDatabaseFromFile(dbPath);

    setChannelOwnerLease({
      chat_jid: 'dc:legacy-channel-owner-write',
      owner_service_id: CLAUDE_SERVICE_ID,
      reviewer_service_id: CODEX_REVIEW_SERVICE_ID,
      owner_agent_type: 'claude-code',
      reviewer_agent_type: 'codex',
      activated_at: '2026-03-28T00:00:00.000Z',
      reason: 'legacy-write',
    });

    expect(getChannelOwnerLease('dc:legacy-channel-owner-write')).toMatchObject(
      {
        owner_service_id: CLAUDE_SERVICE_ID,
        reviewer_service_id: CODEX_REVIEW_SERVICE_ID,
        owner_agent_type: 'claude-code',
        reviewer_agent_type: 'codex',
      },
    );
  });

  it('creates channel owner leases after init on a canonical channel_owner schema without service id columns', () => {
    const tempDir = fs.mkdtempSync(
      '/tmp/ejclaw-canonical-channel-owner-write-',
    );
    const dbPath = path.join(tempDir, 'messages.db');
    const legacyDb = new Database(dbPath);

    legacyDb.exec(`
      CREATE TABLE channel_owner (
        chat_jid TEXT PRIMARY KEY,
        owner_agent_type TEXT,
        reviewer_agent_type TEXT,
        arbiter_agent_type TEXT,
        activated_at TEXT,
        reason TEXT
      );
    `);
    legacyDb.close();

    _initTestDatabaseFromFile(dbPath);

    setChannelOwnerLease({
      chat_jid: 'dc:canonical-channel-owner-write',
      owner_service_id: CLAUDE_SERVICE_ID,
      reviewer_service_id: CODEX_REVIEW_SERVICE_ID,
      owner_agent_type: 'claude-code',
      reviewer_agent_type: 'codex',
      activated_at: '2026-03-28T00:00:00.000Z',
      reason: 'canonical-write',
    });

    expect(
      getChannelOwnerLease('dc:canonical-channel-owner-write'),
    ).toMatchObject({
      owner_service_id: CLAUDE_SERVICE_ID,
      reviewer_service_id: CODEX_REVIEW_SERVICE_ID,
      owner_agent_type: 'claude-code',
      reviewer_agent_type: 'codex',
    });
  });
});

describe('service handoff writes after init', () => {
  it('creates new service handoffs after init on a legacy handoff schema', () => {
    const tempDir = fs.mkdtempSync('/tmp/ejclaw-legacy-handoff-write-');
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
    legacyDb.close();

    _initTestDatabaseFromFile(dbPath);

    const handoff = createServiceHandoff({
      chat_jid: 'dc:legacy-write-handoff',
      group_folder: 'legacy-write-handoff',
      source_service_id: CLAUDE_SERVICE_ID,
      target_service_id: CODEX_REVIEW_SERVICE_ID,
      source_role: 'owner',
      target_role: 'reviewer',
      target_agent_type: 'codex',
      prompt: 'legacy handoff write',
      intended_role: 'reviewer',
    });

    expect(handoff.target_service_id).toBe(CODEX_REVIEW_SERVICE_ID);
    expect(getPendingServiceHandoffs(CODEX_REVIEW_SERVICE_ID)).toEqual([
      expect.objectContaining({
        id: handoff.id,
        target_service_id: CODEX_REVIEW_SERVICE_ID,
      }),
    ]);
  });

  it('creates new service handoffs after init on a canonical handoff schema without service id columns', () => {
    const tempDir = fs.mkdtempSync('/tmp/ejclaw-canonical-handoff-write-');
    const dbPath = path.join(tempDir, 'messages.db');
    const legacyDb = new Database(dbPath);

    legacyDb.exec(`
      CREATE TABLE service_handoffs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_jid TEXT NOT NULL,
        group_folder TEXT NOT NULL,
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
    legacyDb.close();

    _initTestDatabaseFromFile(dbPath);

    const handoff = createServiceHandoff({
      chat_jid: 'dc:canonical-write-handoff',
      group_folder: 'canonical-write-handoff',
      source_role: 'owner',
      source_agent_type: 'claude-code',
      target_role: 'reviewer',
      target_agent_type: 'codex',
      prompt: 'canonical handoff write',
      intended_role: 'reviewer',
    });

    expect(handoff.source_service_id).toBe(CLAUDE_SERVICE_ID);
    expect(handoff.target_service_id).toBe(CODEX_REVIEW_SERVICE_ID);
    expect(getPendingServiceHandoffs(CODEX_REVIEW_SERVICE_ID)).toEqual([
      expect.objectContaining({
        id: handoff.id,
        target_service_id: CODEX_REVIEW_SERVICE_ID,
      }),
    ]);
  });
});
