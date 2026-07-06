import { Database } from 'bun:sqlite';
import fs from 'fs';
import path from 'path';

import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  _initTestDatabaseFromFile,
  createProducedWorkItem,
  getOpenWorkItem,
  getOpenWorkItemForChat,
  markWorkItemDelivered,
  markWorkItemDeliveryRetry,
} from './db.js';
import { initializeDatabaseSchema } from './db/bootstrap.js';
import {
  CODEX_MAIN_SERVICE_ID,
  CODEX_REVIEW_SERVICE_ID,
  SERVICE_SESSION_SCOPE,
} from './config.js';

beforeEach(() => {
  _initTestDatabase();
});

describe('work items', () => {
  it('tracks produced, retry, and delivered states', () => {
    const item = createProducedWorkItem({
      group_folder: 'discord_test',
      chat_jid: 'dc:123',
      agent_type: 'claude-code',
      delivery_role: 'reviewer',
      start_seq: 10,
      end_seq: 12,
      result_payload: 'hello',
    });

    expect(item.delivery_role).toBe('reviewer');
    expect(getOpenWorkItem('dc:123', 'claude-code', item.service_id)?.id).toBe(
      item.id,
    );

    markWorkItemDeliveryRetry(item.id, 'send failed');
    const retried = getOpenWorkItem('dc:123', 'claude-code', item.service_id);
    expect(retried?.status).toBe('delivery_retry');
    expect(retried?.delivery_attempts).toBe(1);
    expect(retried?.last_error).toBe('send failed');

    markWorkItemDelivered(item.id, 'msg-1');
    expect(
      getOpenWorkItem('dc:123', 'claude-code', item.service_id),
    ).toBeUndefined();
  });

  it('stores produced work item attachments for delivery retries', () => {
    const item = createProducedWorkItem({
      group_folder: 'discord_test',
      chat_jid: 'dc:attachments',
      agent_type: 'claude-code',
      delivery_role: 'owner',
      start_seq: 1,
      end_seq: 2,
      result_payload: 'image ready',
      attachments: [
        {
          path: '/tmp/image.png',
          name: 'image.png',
          mime: 'image/png',
        },
      ],
    });

    const stored = getOpenWorkItem(
      'dc:attachments',
      'claude-code',
      item.service_id,
    );
    expect(stored?.attachments).toEqual([
      {
        path: '/tmp/image.png',
        name: 'image.png',
        mime: 'image/png',
      },
    ]);
  });

  it('finds pending delivery retries even when they were created by a fallback agent type', () => {
    const fallbackItem = createProducedWorkItem({
      group_folder: 'discord_test',
      chat_jid: 'dc:fallback',
      agent_type: 'codex',
      service_id: SERVICE_SESSION_SCOPE,
      delivery_role: 'reviewer',
      start_seq: 20,
      end_seq: 22,
      result_payload: 'fallback reviewer output',
    });

    expect(getOpenWorkItem('dc:fallback', 'claude-code')).toBeUndefined();
    expect(getOpenWorkItemForChat('dc:fallback')?.id).toBe(fallbackItem.id);

    markWorkItemDelivered(fallbackItem.id, 'msg-fallback');
    expect(getOpenWorkItemForChat('dc:fallback')).toBeUndefined();
  });
});

describe('work item service routing', () => {
  it('stores service id from role and agent type when an explicit service id is omitted', () => {
    const reviewerItem = createProducedWorkItem({
      group_folder: 'discord_test',
      chat_jid: 'dc:shadow-reviewer',
      agent_type: 'codex',
      delivery_role: 'reviewer',
      start_seq: 1,
      end_seq: 2,
      result_payload: 'reviewer output',
    });
    const ownerItem = createProducedWorkItem({
      group_folder: 'discord_test',
      chat_jid: 'dc:shadow-owner',
      agent_type: 'codex',
      delivery_role: 'owner',
      start_seq: 3,
      end_seq: 4,
      result_payload: 'owner output',
    });

    expect(reviewerItem.service_id).toBe(CODEX_REVIEW_SERVICE_ID);
    expect(ownerItem.service_id).toBe(CODEX_MAIN_SERVICE_ID);
  });

  it('routes open work items by stored service id before falling back to role shadow inference', () => {
    const reviewerItem = createProducedWorkItem({
      group_folder: 'discord_test',
      chat_jid: 'dc:stored-service-reviewer',
      agent_type: 'codex',
      service_id: 'stale-reviewer-shadow',
      delivery_role: 'reviewer',
      start_seq: 1,
      end_seq: 2,
      result_payload: 'reviewer output',
    });
    createProducedWorkItem({
      group_folder: 'discord_test',
      chat_jid: 'dc:stored-service-reviewer',
      agent_type: 'codex',
      service_id: CODEX_MAIN_SERVICE_ID,
      delivery_role: 'owner',
      start_seq: 3,
      end_seq: 4,
      result_payload: 'owner output',
    });

    expect(
      getOpenWorkItem(
        'dc:stored-service-reviewer',
        'codex',
        'stale-reviewer-shadow',
      )?.id,
    ).toBe(reviewerItem.id);
  });

  it('returns undefined when no open work item matches the requested service id or fallback role', () => {
    createProducedWorkItem({
      group_folder: 'discord_test',
      chat_jid: 'dc:stored-service-mismatch',
      agent_type: 'codex',
      service_id: 'stale-reviewer-shadow',
      delivery_role: 'reviewer',
      start_seq: 1,
      end_seq: 2,
      result_payload: 'reviewer output',
    });

    expect(
      getOpenWorkItem(
        'dc:stored-service-mismatch',
        'codex',
        CODEX_MAIN_SERVICE_ID,
      ),
    ).toBeUndefined();
    expect(
      getOpenWorkItemForChat('dc:stored-service-mismatch'),
    ).toBeUndefined();
  });

  it('allows a current-service open work item even when a stale-service open row already exists', () => {
    createProducedWorkItem({
      group_folder: 'discord_test',
      chat_jid: 'dc:repro',
      agent_type: 'codex',
      service_id: 'stale-reviewer-shadow',
      delivery_role: 'reviewer',
      start_seq: 1,
      end_seq: 2,
      result_payload: 'stale reviewer output',
    });

    expect(
      getOpenWorkItemForChat('dc:repro', CODEX_MAIN_SERVICE_ID),
    ).toBeUndefined();

    const currentItem = createProducedWorkItem({
      group_folder: 'discord_test',
      chat_jid: 'dc:repro',
      agent_type: 'codex',
      service_id: CODEX_MAIN_SERVICE_ID,
      delivery_role: 'reviewer',
      start_seq: 3,
      end_seq: 4,
      result_payload: 'current reviewer output',
    });

    expect(getOpenWorkItemForChat('dc:repro', CODEX_MAIN_SERVICE_ID)?.id).toBe(
      currentItem.id,
    );
  });
});

describe('work item canonical service metadata', () => {
  it('fails fast when a work item row loses canonical agent metadata after init', () => {
    const tempDir = fs.mkdtempSync('/tmp/ejclaw-work-item-strict-read-');
    const dbPath = path.join(tempDir, 'messages.db');

    try {
      const fileDb = new Database(dbPath);
      initializeDatabaseSchema(fileDb);
      fileDb.close();

      _initTestDatabaseFromFile(dbPath);
      const item = createProducedWorkItem({
        group_folder: 'discord_test',
        chat_jid: 'dc:work-item-strict-read',
        agent_type: 'codex',
        service_id: CODEX_REVIEW_SERVICE_ID,
        delivery_role: 'reviewer',
        start_seq: 1,
        end_seq: 2,
        result_payload: 'strict read work item',
      });

      const rawDb = new Database(dbPath);
      rawDb
        .prepare(
          `UPDATE work_items
              SET agent_type = ''
            WHERE id = ?`,
        )
        .run(item.id);
      rawDb.close();

      expect(() =>
        getOpenWorkItemForChat(
          'dc:work-item-strict-read',
          CODEX_REVIEW_SERVICE_ID,
        ),
      ).toThrow(/cannot read agent_type from stored row metadata/);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      _initTestDatabase();
    }
  });

  it('backfills work item service ids during init on a canonical work_items schema without service_id columns', () => {
    const tempDir = fs.mkdtempSync('/tmp/ejclaw-work-items-canonical-');
    const dbPath = path.join(tempDir, 'messages.db');
    const legacyDb = new Database(dbPath);

    legacyDb.exec(`
      CREATE TABLE work_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_folder TEXT NOT NULL,
        chat_jid TEXT NOT NULL,
        agent_type TEXT NOT NULL,
        delivery_role TEXT,
        status TEXT NOT NULL DEFAULT 'produced',
        start_seq INTEGER,
        end_seq INTEGER,
        result_payload TEXT NOT NULL,
        delivery_attempts INTEGER NOT NULL DEFAULT 0,
        delivery_message_id TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        delivered_at TEXT
      );
    `);
    legacyDb
      .prepare(
        `INSERT INTO work_items (
          group_folder,
          chat_jid,
          agent_type,
          delivery_role,
          status,
          start_seq,
          end_seq,
          result_payload,
          delivery_attempts,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'discord_test',
        'dc:legacy-work-item',
        'codex',
        'reviewer',
        'produced',
        1,
        2,
        'legacy reviewer output',
        0,
        '2026-03-28T00:00:00.000Z',
        '2026-03-28T00:00:00.000Z',
      );
    legacyDb.close();

    _initTestDatabaseFromFile(dbPath);

    expect(
      getOpenWorkItem('dc:legacy-work-item', 'codex', CODEX_REVIEW_SERVICE_ID),
    ).toMatchObject({
      delivery_role: 'reviewer',
      service_id: CODEX_REVIEW_SERVICE_ID,
      result_payload: 'legacy reviewer output',
    });
  });
});
