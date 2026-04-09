import { Database } from 'bun:sqlite';
import fs from 'fs';
import path from 'path';

import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  _initTestDatabaseFromFile,
  _deleteStoredRoomSettingsForTests,
  _setMemoryTimestampsForTests,
  _setRegisteredGroupForTests,
  assignRoom,
  claimServiceHandoff,
  completeServiceHandoffAndAdvanceTargetCursor,
  createPairedTask,
  createTask,
  createServiceHandoff,
  createProducedWorkItem,
  clearExplicitRoomMode,
  deleteSession,
  deleteTask,
  getAllChats,
  getChannelOwnerLease,
  getAllRegisteredGroups,
  getDueTasks,
  getEffectiveRoomMode,
  getEffectiveRuntimeRoomMode,
  getExplicitRoomMode,
  getLatestMessageSeqAtOrBefore,
  getLatestPairedTaskForChat,
  getLatestTurnNumber,
  getLastRespondingAgentType,
  getRegisteredGroup,
  getMessagesSinceSeq,
  getNewMessagesBySeq,
  getOpenWorkItem,
  getOpenWorkItemForChat,
  getPendingServiceHandoffs,
  recallMemories,
  getRegisteredAgentTypesForJid,
  getMessagesSince,
  getNewMessages,
  getPairedProject,
  getPairedTaskById,
  getPairedTurnOutputs,
  getPairedWorkspace,
  getRouterState,
  getSession,
  getStoredRoomSettings,
  getTaskById,
  insertPairedTurnOutput,
  listPairedWorkspacesForTask,
  markWorkItemDelivered,
  markWorkItemDeliveryRetry,
  setSession,
  setRouterState,
  setExplicitRoomMode,
  rememberMemory,
  storeChatMetadata,
  storeMessage,
  updateRegisteredGroupName,
  updatePairedTask,
  upsertPairedProject,
  upsertPairedWorkspace,
  updateTask,
} from './db.js';
import {
  ARBITER_AGENT_TYPE,
  CLAUDE_SERVICE_ID,
  CODEX_MAIN_SERVICE_ID,
  CODEX_REVIEW_SERVICE_ID,
} from './config.js';
import {
  resolveTaskRuntimeIpcPath,
  resolveTaskSessionsPath,
} from './group-folder.js';

beforeEach(() => {
  _initTestDatabase();
});

// Helper to store a message using the normalized NewMessage interface
function store(overrides: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
}) {
  storeMessage({
    id: overrides.id,
    chat_jid: overrides.chat_jid,
    sender: overrides.sender,
    sender_name: overrides.sender_name,
    content: overrides.content,
    timestamp: overrides.timestamp,
    is_from_me: overrides.is_from_me ?? false,
  });
}

// --- storeMessage (NewMessage format) ---

describe('storeMessage', () => {
  it('stores a message and retrieves it', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-1',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'hello world',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('msg-1');
    expect(messages[0].sender).toBe('123@s.whatsapp.net');
    expect(messages[0].sender_name).toBe('Alice');
    expect(messages[0].content).toBe('hello world');
  });

  it('filters out empty content', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-2',
      chat_jid: 'group@g.us',
      sender: '111@s.whatsapp.net',
      sender_name: 'Dave',
      content: '',
      timestamp: '2024-01-01T00:00:04.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(0);
  });

  it('stores is_from_me flag', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-3',
      chat_jid: 'group@g.us',
      sender: 'me@s.whatsapp.net',
      sender_name: 'Me',
      content: 'my message',
      timestamp: '2024-01-01T00:00:05.000Z',
      is_from_me: true,
    });

    // Message is stored (we can retrieve it — is_from_me doesn't affect retrieval)
    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
  });

  it('detects the most recent bot responder agent type', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    storeMessage({
      id: 'bot-1',
      chat_jid: 'group@g.us',
      sender: 'claude-main',
      sender_name: 'Claude',
      content: 'first bot reply',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_bot_message: true,
    });
    storeMessage({
      id: 'bot-2',
      chat_jid: 'group@g.us',
      sender: 'codex-review',
      sender_name: 'Codex',
      content: 'second bot reply',
      timestamp: '2024-01-01T00:00:02.000Z',
      is_bot_message: true,
    });

    expect(getLastRespondingAgentType('group@g.us')).toBe('codex');
  });

  it('upserts on duplicate id+chat_jid', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-dup',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'original',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    store({
      id: 'msg-dup',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'updated',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('updated');
  });
});

// --- getMessagesSince ---

describe('getMessagesSince', () => {
  beforeEach(() => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'm1',
      chat_jid: 'group@g.us',
      sender: 'Alice@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'first',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'm2',
      chat_jid: 'group@g.us',
      sender: 'Bob@s.whatsapp.net',
      sender_name: 'Bob',
      content: 'second',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    storeMessage({
      id: 'm3',
      chat_jid: 'group@g.us',
      sender: 'Bot@s.whatsapp.net',
      sender_name: 'Bot',
      content: 'bot reply',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_bot_message: true,
    });
    store({
      id: 'm4',
      chat_jid: 'group@g.us',
      sender: 'Carol@s.whatsapp.net',
      sender_name: 'Carol',
      content: 'third',
      timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns messages after the given timestamp', () => {
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:02.000Z',
      'Andy',
    );
    expect(msgs).toHaveLength(2);
    expect(msgs[0].content).toBe('bot reply');
    expect(msgs[1].content).toBe('third');
  });

  it('includes bot messages from other senders', () => {
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    const botMsgs = msgs.filter((m) => m.content === 'bot reply');
    expect(botMsgs).toHaveLength(1);
    expect(botMsgs[0].is_bot_message).toBe(true);
  });

  it('returns all messages when sinceTimestamp is empty', () => {
    const msgs = getMessagesSince('group@g.us', '', 'Andy');
    expect(msgs).toHaveLength(4);
  });

  it('filters pre-migration bot messages via content prefix backstop', () => {
    // Simulate a message written before migration: has prefix but is_bot_message = 0
    store({
      id: 'm5',
      chat_jid: 'group@g.us',
      sender: 'Bot@s.whatsapp.net',
      sender_name: 'Bot',
      content: 'Andy: old bot reply',
      timestamp: '2024-01-01T00:00:05.000Z',
    });
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:04.000Z',
      'Andy',
    );
    expect(msgs).toHaveLength(0);
  });
});

// --- getNewMessages ---

describe('getNewMessages', () => {
  beforeEach(() => {
    storeChatMetadata('group1@g.us', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group2@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'a1',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g1 msg1',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'a2',
      chat_jid: 'group2@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g2 msg1',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    storeMessage({
      id: 'a3',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'bot reply',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_bot_message: true,
    });
    store({
      id: 'a4',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g1 msg2',
      timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns new messages across multiple groups', () => {
    const { messages, newTimestamp } = getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(4);
    expect(newTimestamp).toBe('2024-01-01T00:00:04.000Z');
  });

  it('filters by timestamp', () => {
    const { messages } = getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      '2024-01-01T00:00:02.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe('bot reply');
    expect(messages[1].content).toBe('g1 msg2');
  });

  it('returns empty for no registered groups', () => {
    const { messages, newTimestamp } = getNewMessages([], '', 'Andy');
    expect(messages).toHaveLength(0);
    expect(newTimestamp).toBe('');
  });
});

describe('session accessors', () => {
  it('deletes only the current service session for a group', () => {
    setSession('group-a', 'session-123');
    expect(getSession('group-a')).toBe('session-123');

    deleteSession('group-a');
    expect(getSession('group-a')).toBeUndefined();
  });

  it('migrates legacy sessions table rows into the composite primary key schema', () => {
    const tempDir = fs.mkdtempSync('/tmp/ejclaw-session-schema-migration-');
    const dbPath = path.join(tempDir, 'messages.db');
    const legacyDb = new Database(dbPath);

    legacyDb.exec(`
      CREATE TABLE sessions (
        group_folder TEXT PRIMARY KEY,
        session_id TEXT NOT NULL
      );
    `);
    legacyDb
      .prepare(
        `INSERT INTO sessions (group_folder, session_id)
         VALUES (?, ?)`,
      )
      .run('group-legacy-schema', 'legacy-schema-session-123');
    legacyDb.close();

    _initTestDatabaseFromFile(dbPath);

    expect(getSession('group-legacy-schema', 'claude-code')).toBe(
      'legacy-schema-session-123',
    );

    const migratedDb = new Database(dbPath, { readonly: true });
    const sessionColumns = migratedDb
      .prepare(`PRAGMA table_info(sessions)`)
      .all() as Array<{ name: string }>;
    expect(sessionColumns.some((col) => col.name === 'agent_type')).toBe(true);
    migratedDb.close();
  });

  it('backfills legacy service-scoped sessions into canonical agent sessions during init', () => {
    const tempDir = fs.mkdtempSync('/tmp/ejclaw-session-backfill-');
    const dbPath = path.join(tempDir, 'messages.db');
    const legacyDb = new Database(dbPath);

    legacyDb.exec(`
      CREATE TABLE sessions (
        group_folder TEXT NOT NULL,
        agent_type TEXT NOT NULL DEFAULT 'claude-code',
        session_id TEXT NOT NULL,
        PRIMARY KEY (group_folder, agent_type)
      );
      CREATE TABLE service_sessions (
        group_folder TEXT NOT NULL,
        service_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        PRIMARY KEY (group_folder, service_id)
      );
    `);
    legacyDb
      .prepare(
        `INSERT INTO service_sessions (group_folder, service_id, session_id)
         VALUES (?, ?, ?)`,
      )
      .run('group-legacy', CLAUDE_SERVICE_ID, 'legacy-session-123');
    legacyDb.close();

    _initTestDatabaseFromFile(dbPath);

    expect(getSession('group-legacy', 'claude-code')).toBe(
      'legacy-session-123',
    );

    const migratedDb = new Database(dbPath, { readonly: true });
    expect(
      migratedDb
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'service_sessions'`,
        )
        .get(),
    ).toBeUndefined();
    migratedDb.close();
  });
});

// --- storeChatMetadata ---

describe('storeChatMetadata', () => {
  it('stores chat with JID as default name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].jid).toBe('group@g.us');
    expect(chats[0].name).toBe('group@g.us');
  });

  it('stores chat with explicit name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z', 'My Group');
    const chats = getAllChats();
    expect(chats[0].name).toBe('My Group');
  });

  it('updates name on subsequent call with name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z', 'Updated Name');
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].name).toBe('Updated Name');
  });

  it('preserves newer timestamp on conflict', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:05.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z');
    const chats = getAllChats();
    expect(chats[0].last_message_time).toBe('2024-01-01T00:00:05.000Z');
  });
});

// --- Task CRUD ---

describe('task CRUD', () => {
  it('creates and retrieves a task', () => {
    createTask({
      id: 'task-1',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'do something',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2024-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    const task = getTaskById('task-1');
    expect(task).toBeDefined();
    expect(task!.prompt).toBe('do something');
    expect(task!.status).toBe('active');
  });

  it('updates task status', () => {
    createTask({
      id: 'task-2',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    updateTask('task-2', { status: 'paused' });
    expect(getTaskById('task-2')!.status).toBe('paused');
  });

  it('stores and updates GitHub CI task metadata', () => {
    createTask({
      id: 'task-github',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      ci_provider: 'github',
      ci_metadata: JSON.stringify({ repo: 'owner/repo', run_id: 123456 }),
      prompt: 'github watcher',
      schedule_type: 'interval',
      schedule_value: '15000',
      context_mode: 'isolated',
      next_run: '2024-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    expect(getTaskById('task-github')?.ci_provider).toBe('github');
    expect(getTaskById('task-github')?.ci_metadata).toContain('owner/repo');

    updateTask('task-github', {
      ci_metadata: JSON.stringify({
        repo: 'owner/repo',
        run_id: 123456,
        poll_count: 2,
      }),
    });

    expect(getTaskById('task-github')?.ci_metadata).toContain('"poll_count":2');
  });

  it('deletes a task and its run logs', () => {
    createTask({
      id: 'task-3',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'delete me',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    deleteTask('task-3');
    expect(getTaskById('task-3')).toBeUndefined();
  });

  it('deletes task-scoped IPC and session directories when removing a task', () => {
    const taskId = 'task-cleanup';
    const groupFolder = 'cleanup-group';
    const runtimeIpcDir = resolveTaskRuntimeIpcPath(groupFolder, taskId);
    const taskSessionsDir = resolveTaskSessionsPath(groupFolder, taskId);

    fs.rmSync(runtimeIpcDir, { recursive: true, force: true });
    fs.rmSync(taskSessionsDir, { recursive: true, force: true });
    fs.mkdirSync(runtimeIpcDir, { recursive: true });
    fs.mkdirSync(taskSessionsDir, { recursive: true });

    createTask({
      id: taskId,
      group_folder: groupFolder,
      chat_jid: 'group@g.us',
      prompt: `
[BACKGROUND CI WATCH]

Watch target:
cleanup

Check instructions:
Check the run.
      `.trim(),
      schedule_type: 'interval',
      schedule_value: '60000',
      context_mode: 'group',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    deleteTask(taskId);

    expect(fs.existsSync(runtimeIpcDir)).toBe(false);
    expect(fs.existsSync(taskSessionsDir)).toBe(false);
  });

  it('returns due tasks only for the requested agent type', () => {
    const dueAt = new Date(Date.now() - 1_000).toISOString();

    createTask({
      id: 'task-claude',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      agent_type: 'claude-code',
      prompt: 'claude task',
      schedule_type: 'once',
      schedule_value: dueAt,
      context_mode: 'isolated',
      next_run: dueAt,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });
    createTask({
      id: 'task-codex',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      agent_type: 'codex',
      prompt: 'codex task',
      schedule_type: 'once',
      schedule_value: dueAt,
      context_mode: 'isolated',
      next_run: dueAt,
      status: 'active',
      created_at: '2024-01-01T00:00:01.000Z',
    });

    const dueIds = getDueTasks().map((task) => task.id);
    expect(dueIds).toContain('task-claude');
    expect(dueIds).toContain('task-codex');
  });
});

describe('paired task state', () => {
  it('stores project, task, and workspace state', () => {
    upsertPairedProject({
      chat_jid: 'dc:paired',
      group_folder: 'paired-room',
      canonical_work_dir: '/tmp/paired-room',
      created_at: '2026-03-28T00:00:00.000Z',
      updated_at: '2026-03-28T00:00:00.000Z',
    });

    createPairedTask({
      id: 'paired-task-1',
      chat_jid: 'dc:paired',
      group_folder: 'paired-room',
      owner_service_id: 'codex-main',
      reviewer_service_id: 'codex-review',
      title: 'wire up workspaces',
      source_ref: 'HEAD',
      plan_notes: null,
      round_trip_count: 0,
      review_requested_at: null,
      status: 'active',
      arbiter_verdict: null,
      arbiter_requested_at: null,
      completion_reason: null,
      created_at: '2026-03-28T00:00:00.000Z',
      updated_at: '2026-03-28T00:00:00.000Z',
    });

    upsertPairedWorkspace({
      id: 'paired-task-1:owner',
      task_id: 'paired-task-1',
      role: 'owner',
      workspace_dir: '/tmp/paired-room/owner',
      snapshot_source_dir: null,
      snapshot_ref: null,
      status: 'ready',
      snapshot_refreshed_at: null,
      created_at: '2026-03-28T00:00:00.000Z',
      updated_at: '2026-03-28T00:00:00.000Z',
    });

    expect(getPairedProject('dc:paired')?.canonical_work_dir).toBe(
      '/tmp/paired-room',
    );
    expect(getPairedTaskById('paired-task-1')?.status).toBe('active');
    expect(getPairedWorkspace('paired-task-1', 'owner')?.workspace_dir).toBe(
      '/tmp/paired-room/owner',
    );
  });

  it('updates task state and keeps one workspace per role', () => {
    createPairedTask({
      id: 'paired-task-2',
      chat_jid: 'dc:paired',
      group_folder: 'paired-room',
      owner_service_id: 'codex-main',
      reviewer_service_id: 'codex-review',
      title: null,
      source_ref: null,
      plan_notes: null,
      round_trip_count: 0,
      review_requested_at: null,
      status: 'active',
      arbiter_verdict: null,
      arbiter_requested_at: null,
      completion_reason: null,
      created_at: '2026-03-28T00:00:00.000Z',
      updated_at: '2026-03-28T00:00:00.000Z',
    });

    updatePairedTask('paired-task-2', {
      status: 'review_ready',
      review_requested_at: '2026-03-28T00:10:00.000Z',
      updated_at: '2026-03-28T00:10:00.000Z',
    });

    upsertPairedWorkspace({
      id: 'paired-task-2:reviewer',
      task_id: 'paired-task-2',
      role: 'reviewer',
      workspace_dir: '/tmp/reviewer-v1',
      snapshot_source_dir: '/tmp/owner',
      snapshot_ref: 'fingerprint-v1',
      status: 'ready',
      snapshot_refreshed_at: '2026-03-28T00:10:00.000Z',
      created_at: '2026-03-28T00:10:00.000Z',
      updated_at: '2026-03-28T00:10:00.000Z',
    });
    upsertPairedWorkspace({
      id: 'paired-task-2:reviewer',
      task_id: 'paired-task-2',
      role: 'reviewer',
      workspace_dir: '/tmp/reviewer-v2',
      snapshot_source_dir: '/tmp/owner',
      snapshot_ref: 'fingerprint-v2',
      status: 'ready',
      snapshot_refreshed_at: '2026-03-28T00:12:00.000Z',
      created_at: '2026-03-28T00:10:00.000Z',
      updated_at: '2026-03-28T00:12:00.000Z',
    });

    expect(getPairedTaskById('paired-task-2')?.status).toBe('review_ready');
    expect(
      listPairedWorkspacesForTask('paired-task-2').map(
        (workspace) => workspace.workspace_dir,
      ),
    ).toEqual(['/tmp/reviewer-v2']);
  });

  it('stores paired turn outputs in order and truncates oversized text', () => {
    createPairedTask({
      id: 'paired-task-turn-output',
      chat_jid: 'dc:paired',
      group_folder: 'paired-room',
      owner_service_id: 'codex-main',
      reviewer_service_id: 'codex-review',
      title: null,
      source_ref: null,
      plan_notes: null,
      round_trip_count: 0,
      review_requested_at: null,
      status: 'active',
      arbiter_verdict: null,
      arbiter_requested_at: null,
      completion_reason: null,
      created_at: '2026-03-28T00:00:00.000Z',
      updated_at: '2026-03-28T00:00:00.000Z',
    });

    insertPairedTurnOutput(
      'paired-task-turn-output',
      2,
      'reviewer',
      'review turn',
    );
    insertPairedTurnOutput(
      'paired-task-turn-output',
      1,
      'owner',
      'x'.repeat(60_000),
    );

    const outputs = getPairedTurnOutputs('paired-task-turn-output');

    expect(outputs.map((output) => output.turn_number)).toEqual([1, 2]);
    expect(outputs[0].role).toBe('owner');
    expect(outputs[0].output_text).toHaveLength(50_000);
    expect(outputs[1].output_text).toBe('review turn');
    expect(getLatestTurnNumber('paired-task-turn-output')).toBe(2);
  });

  it('normalizes paired task service shadow from persisted role agent types during init', () => {
    const tempDir = fs.mkdtempSync('/tmp/ejclaw-paired-task-shadow-');
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

    legacyDb
      .prepare(
        `INSERT INTO paired_tasks (
          id,
          chat_jid,
          group_folder,
          owner_service_id,
          reviewer_service_id,
          owner_agent_type,
          reviewer_agent_type,
          arbiter_agent_type,
          title,
          source_ref,
          plan_notes,
          review_requested_at,
          round_trip_count,
          status,
          arbiter_verdict,
          arbiter_requested_at,
          completion_reason,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'paired-legacy-1',
        'dc:paired',
        'paired-room',
        CODEX_REVIEW_SERVICE_ID,
        CODEX_MAIN_SERVICE_ID,
        'codex',
        'claude-code',
        'codex',
        null,
        'HEAD',
        null,
        null,
        0,
        'active',
        null,
        null,
        null,
        '2026-03-28T00:00:00.000Z',
        '2026-03-28T00:00:00.000Z',
      );
    legacyDb.close();

    _initTestDatabaseFromFile(dbPath);

    expect(getPairedTaskById('paired-legacy-1')).toMatchObject({
      owner_service_id: CODEX_MAIN_SERVICE_ID,
      reviewer_service_id: CLAUDE_SERVICE_ID,
      owner_agent_type: 'codex',
      reviewer_agent_type: 'claude-code',
      arbiter_agent_type: 'codex',
    });
  });

  it('backfills paired task role metadata from stable room metadata for pre-column legacy rows', () => {
    const tempDir = fs.mkdtempSync('/tmp/ejclaw-paired-task-legacy-shadow-');
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
      CREATE TABLE paired_tasks (
        id TEXT PRIMARY KEY,
        chat_jid TEXT NOT NULL,
        group_folder TEXT NOT NULL,
        owner_service_id TEXT NOT NULL,
        reviewer_service_id TEXT NOT NULL,
        title TEXT,
        source_ref TEXT,
        plan_notes TEXT,
        review_requested_at TEXT,
        round_trip_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        arbiter_verdict TEXT,
        arbiter_requested_at TEXT,
        completion_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (status IN ('active', 'review_ready', 'in_review', 'merge_ready', 'completed', 'arbiter_requested', 'in_arbitration'))
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
      'dc:legacy-failover',
      'Legacy Failover Room',
      'legacy-failover-room',
      '@Claude',
      '2024-01-01T00:00:00.000Z',
      'claude-code',
    );
    insertGroup.run(
      'dc:legacy-failover',
      'Legacy Failover Room',
      'legacy-failover-room',
      '@Codex',
      '2024-01-01T00:00:00.000Z',
      'codex',
    );

    legacyDb
      .prepare(
        `INSERT INTO paired_tasks (
          id,
          chat_jid,
          group_folder,
          owner_service_id,
          reviewer_service_id,
          title,
          source_ref,
          plan_notes,
          review_requested_at,
          round_trip_count,
          status,
          arbiter_verdict,
          arbiter_requested_at,
          completion_reason,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'paired-legacy-failover',
        'dc:legacy-failover',
        'legacy-failover-room',
        CODEX_REVIEW_SERVICE_ID,
        CLAUDE_SERVICE_ID,
        null,
        'HEAD',
        null,
        null,
        0,
        'active',
        null,
        null,
        null,
        '2026-03-28T00:00:00.000Z',
        '2026-03-28T00:00:00.000Z',
      );
    legacyDb.close();

    _initTestDatabaseFromFile(dbPath);

    expect(getStoredRoomSettings('dc:legacy-failover')).toMatchObject({
      ownerAgentType: 'codex',
    });
    expect(getPairedTaskById('paired-legacy-failover')).toMatchObject({
      owner_service_id: CODEX_MAIN_SERVICE_ID,
      reviewer_service_id: CLAUDE_SERVICE_ID,
      owner_agent_type: 'codex',
      reviewer_agent_type: 'claude-code',
      arbiter_agent_type: ARBITER_AGENT_TYPE ?? null,
    });
  });

  it('preserves task-level role metadata even when current room settings differ', () => {
    const tempDir = fs.mkdtempSync('/tmp/ejclaw-paired-task-ssot-');
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

    legacyDb
      .prepare(
        `INSERT INTO room_settings (
          chat_jid,
          room_mode,
          mode_source,
          owner_agent_type,
          updated_at
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        'dc:task-ssot',
        'tribunal',
        'explicit',
        'codex',
        '2026-03-28T00:00:00.000Z',
      );

    legacyDb
      .prepare(
        `INSERT INTO paired_tasks (
          id,
          chat_jid,
          group_folder,
          owner_service_id,
          reviewer_service_id,
          owner_agent_type,
          reviewer_agent_type,
          arbiter_agent_type,
          title,
          source_ref,
          plan_notes,
          review_requested_at,
          round_trip_count,
          status,
          arbiter_verdict,
          arbiter_requested_at,
          completion_reason,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'paired-task-ssot',
        'dc:task-ssot',
        'task-ssot-room',
        CODEX_REVIEW_SERVICE_ID,
        CLAUDE_SERVICE_ID,
        'claude-code',
        'codex',
        'codex',
        null,
        'HEAD',
        null,
        null,
        0,
        'active',
        null,
        null,
        null,
        '2026-03-28T00:00:00.000Z',
        '2026-03-28T00:00:00.000Z',
      );
    legacyDb.close();

    _initTestDatabaseFromFile(dbPath);

    expect(getStoredRoomSettings('dc:task-ssot')).toMatchObject({
      ownerAgentType: 'codex',
    });
    expect(getPairedTaskById('paired-task-ssot')).toMatchObject({
      owner_service_id: CLAUDE_SERVICE_ID,
      reviewer_service_id: CODEX_REVIEW_SERVICE_ID,
      owner_agent_type: 'claude-code',
      reviewer_agent_type: 'codex',
      arbiter_agent_type: 'codex',
    });
  });

  it('preserves explicit room owner trigger and agent type during init and uses them for null task fallback', () => {
    const tempDir = fs.mkdtempSync('/tmp/ejclaw-room-settings-ssot-');
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
        'dc:explicit-owner',
        'tribunal',
        'explicit',
        'Explicit Owner Room',
        'explicit-owner-room',
        '@Custom',
        1,
        0,
        'claude-code',
        null,
        '2026-03-28T00:00:00.000Z',
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
      'dc:explicit-owner',
      'Explicit Owner Room',
      'explicit-owner-room',
      '@Claude',
      '2024-01-01T00:00:00.000Z',
      'claude-code',
    );
    insertGroup.run(
      'dc:explicit-owner',
      'Explicit Owner Room',
      'explicit-owner-room',
      '@Codex',
      '2024-01-01T00:00:00.000Z',
      'codex',
    );

    legacyDb
      .prepare(
        `INSERT INTO paired_tasks (
          id,
          chat_jid,
          group_folder,
          owner_service_id,
          reviewer_service_id,
          owner_agent_type,
          reviewer_agent_type,
          arbiter_agent_type,
          title,
          source_ref,
          plan_notes,
          review_requested_at,
          round_trip_count,
          status,
          arbiter_verdict,
          arbiter_requested_at,
          completion_reason,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'paired-explicit-owner',
        'dc:explicit-owner',
        'explicit-owner-room',
        CODEX_REVIEW_SERVICE_ID,
        CODEX_MAIN_SERVICE_ID,
        null,
        null,
        null,
        null,
        'HEAD',
        null,
        null,
        0,
        'active',
        null,
        null,
        null,
        '2026-03-28T00:00:00.000Z',
        '2026-03-28T00:00:00.000Z',
      );
    legacyDb.close();

    _initTestDatabaseFromFile(dbPath);

    expect(getStoredRoomSettings('dc:explicit-owner')).toMatchObject({
      roomMode: 'tribunal',
      modeSource: 'explicit',
      ownerAgentType: 'claude-code',
      trigger: '@Custom',
    });
    expect(getPairedTaskById('paired-explicit-owner')).toMatchObject({
      owner_service_id: CLAUDE_SERVICE_ID,
      reviewer_service_id: CLAUDE_SERVICE_ID,
      owner_agent_type: 'claude-code',
      reviewer_agent_type: 'claude-code',
      arbiter_agent_type: ARBITER_AGENT_TYPE ?? null,
    });
  });

  it('preserves explicit room trigger during init even when legacy explicit rows lack owner agent type', () => {
    const tempDir = fs.mkdtempSync('/tmp/ejclaw-room-settings-trigger-ssot-');
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
        'dc:explicit-trigger-only',
        'tribunal',
        'explicit',
        'Explicit Trigger Room',
        'explicit-trigger-room',
        '@Custom',
        1,
        0,
        null,
        null,
        '2026-03-28T00:00:00.000Z',
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
      'dc:explicit-trigger-only',
      'Explicit Trigger Room',
      'explicit-trigger-room',
      '@Claude',
      '2024-01-01T00:00:00.000Z',
      'claude-code',
    );
    insertGroup.run(
      'dc:explicit-trigger-only',
      'Explicit Trigger Room',
      'explicit-trigger-room',
      '@Codex',
      '2024-01-01T00:00:00.000Z',
      'codex',
    );
    legacyDb.close();

    _initTestDatabaseFromFile(dbPath);

    expect(getStoredRoomSettings('dc:explicit-trigger-only')).toMatchObject({
      roomMode: 'tribunal',
      modeSource: 'explicit',
      trigger: '@Custom',
    });
  });
});

// --- LIMIT behavior ---

describe('message query LIMIT', () => {
  beforeEach(() => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    for (let i = 1; i <= 10; i++) {
      store({
        id: `lim-${i}`,
        chat_jid: 'group@g.us',
        sender: 'user@s.whatsapp.net',
        sender_name: 'User',
        content: `message ${i}`,
        timestamp: `2024-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
      });
    }
  });

  it('getNewMessages caps to limit and returns most recent in chronological order', () => {
    const { messages, newTimestamp } = getNewMessages(
      ['group@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
      3,
    );
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('message 8');
    expect(messages[2].content).toBe('message 10');
    // Chronological order preserved
    expect(messages[1].timestamp > messages[0].timestamp).toBe(true);
    // newTimestamp reflects latest returned row
    expect(newTimestamp).toBe('2024-01-01T00:00:10.000Z');
  });

  it('getMessagesSince caps to limit and returns most recent in chronological order', () => {
    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
      3,
    );
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('message 8');
    expect(messages[2].content).toBe('message 10');
    expect(messages[1].timestamp > messages[0].timestamp).toBe(true);
  });

  it('returns all messages when count is under the limit', () => {
    const { messages } = getNewMessages(
      ['group@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
      50,
    );
    expect(messages).toHaveLength(10);
  });
});

// --- RegisteredGroup isMain round-trip ---

describe('registered group isMain', () => {
  it('persists isMain=true through set/get round-trip', () => {
    _setRegisteredGroupForTests('dc:main', {
      name: 'Main Chat',
      folder: 'discord_main',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: true,
    });

    const groups = getAllRegisteredGroups();
    const group = groups['dc:main'];
    expect(group).toBeDefined();
    expect(group.isMain).toBe(true);
    expect(group.folder).toBe('discord_main');
  });

  it('omits isMain for non-main groups', () => {
    _setRegisteredGroupForTests('group@g.us', {
      name: 'Family Chat',
      folder: 'discord_family-chat',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
    });

    const groups = getAllRegisteredGroups();
    const group = groups['group@g.us'];
    expect(group).toBeDefined();
    expect(group.isMain).toBeUndefined();
  });

  it('filters duplicate jid registrations by agent type', () => {
    _setRegisteredGroupForTests('dc:shared', {
      name: 'Shared Room',
      folder: 'shared-room',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      agentType: 'claude-code',
    });
    _setRegisteredGroupForTests('dc:shared', {
      name: 'Shared Room',
      folder: 'shared-room',
      trigger: '@Codex',
      added_at: '2024-01-01T00:00:00.000Z',
      agentType: 'codex',
    });

    const claudeGroups = getAllRegisteredGroups('claude-code');
    const codexGroups = getAllRegisteredGroups('codex');

    expect(claudeGroups['dc:shared']?.agentType).toBe('claude-code');
    expect(claudeGroups['dc:shared']?.name).toBe('Shared Room');
    expect(codexGroups['dc:shared']?.agentType).toBe('codex');
    expect(codexGroups['dc:shared']?.name).toBe('Shared Room');
  });
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

  it('materializes tribunal capability rows while serving metadata from room_settings', () => {
    assignRoom('dc:assigned-room', {
      name: 'Assigned Room',
      roomMode: 'tribunal',
      ownerAgentType: 'codex',
      folder: 'assigned-room',
    });

    const allGroups = getAllRegisteredGroups();
    const claudeGroups = getAllRegisteredGroups('claude-code');
    const codexGroups = getAllRegisteredGroups('codex');

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

  it('updates room_settings-backed metadata across tribunal projection rows', () => {
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
      getAllRegisteredGroups('claude-code')['dc:projection-room'],
    ).toMatchObject({
      name: 'Projection Room Renamed',
      folder: 'projection-room',
      agentType: 'claude-code',
    });
    expect(getAllRegisteredGroups('codex')['dc:projection-room']).toMatchObject(
      {
        name: 'Projection Room Renamed',
        folder: 'projection-room',
        agentType: 'codex',
      },
    );
  });

  it('recreates inferred room_settings when renaming a legacy projection-only room', () => {
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

    expect(getStoredRoomSettings('dc:legacy-rename')).toMatchObject({
      chatJid: 'dc:legacy-rename',
      roomMode: 'tribunal',
      modeSource: 'inferred',
      name: 'Legacy Rename Updated',
      folder: 'legacy-rename',
    });
    expect(
      getAllRegisteredGroups('claude-code')['dc:legacy-rename'],
    ).toMatchObject({
      name: 'Legacy Rename Updated',
      agentType: 'claude-code',
    });
    expect(getAllRegisteredGroups('codex')['dc:legacy-rename']).toMatchObject({
      name: 'Legacy Rename Updated',
      agentType: 'codex',
    });
  });

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
        'Stale Projection',
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
        'Stale Projection',
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

    _initTestDatabaseFromFile(dbPath);

    expect(getRegisteredGroup('dc:ssot-room')).toMatchObject({
      folder: 'ssot-room',
      agentType: 'codex',
    });
    expect(getRegisteredGroup('dc:ssot-room', 'claude-code')).toBeUndefined();
    expect(
      getAllRegisteredGroups('claude-code')['dc:ssot-room'],
    ).toBeUndefined();
    expect(getRegisteredAgentTypesForJid('dc:ssot-room')).toEqual(['codex']);
  });

  it('re-materializes explicit room_settings writes back into the projection rows', () => {
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
      'Stale Projection',
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
      'Stale Projection',
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

    _initTestDatabaseFromFile(dbPath);

    updateRegisteredGroupName('dc:ssot-writeback', 'SSOT Writeback Renamed');

    expect(getStoredRoomSettings('dc:ssot-writeback')).toMatchObject({
      chatJid: 'dc:ssot-writeback',
      roomMode: 'single',
      modeSource: 'explicit',
      name: 'SSOT Writeback Renamed',
      ownerAgentType: 'codex',
    });

    const rawDb = new Database(dbPath);
    const projectionRows = rawDb
      .prepare(
        `SELECT agent_type, name
         FROM registered_groups
         WHERE jid = ?
         ORDER BY agent_type`,
      )
      .all('dc:ssot-writeback') as Array<{
      agent_type: string | null;
      name: string;
    }>;
    rawDb.close();

    expect(projectionRows).toEqual([
      {
        agent_type: 'codex',
        name: 'SSOT Writeback Renamed',
      },
    ]);

    clearExplicitRoomMode('dc:ssot-writeback');

    expect(getExplicitRoomMode('dc:ssot-writeback')).toBeUndefined();
    expect(getEffectiveRoomMode('dc:ssot-writeback')).toBe('single');
  });
});

describe('paired room registration', () => {
  it('detects when both Claude and Codex are registered on the same jid', () => {
    _setRegisteredGroupForTests('dc:123', {
      name: 'Paired Room',
      folder: 'paired-room',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      agentType: 'claude-code',
    });
    _setRegisteredGroupForTests('dc:123', {
      name: 'Paired Room',
      folder: 'paired-room',
      trigger: '@Codex',
      added_at: '2024-01-01T00:00:00.000Z',
      agentType: 'codex',
    });

    expect(getRegisteredAgentTypesForJid('dc:123').sort()).toEqual([
      'claude-code',
      'codex',
    ]);
    expect(getExplicitRoomMode('dc:123')).toBeUndefined();
    expect(getEffectiveRoomMode('dc:123')).toBe('tribunal');
    expect(getEffectiveRuntimeRoomMode('dc:123')).toBe('tribunal');
  });

  it('does not mark solo rooms as paired', () => {
    _setRegisteredGroupForTests('dc:solo', {
      name: 'Solo Claude Room',
      folder: 'solo-claude',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      agentType: 'claude-code',
    });

    expect(getRegisteredAgentTypesForJid('dc:solo')).toEqual(['claude-code']);
    expect(getEffectiveRuntimeRoomMode('dc:solo')).toBe('single');
  });

  it('keeps inferred room mode available when no explicit override exists', () => {
    _setRegisteredGroupForTests('dc:legacy-paired', {
      name: 'Legacy Paired',
      folder: 'legacy-paired',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      agentType: 'claude-code',
    });
    _setRegisteredGroupForTests('dc:legacy-paired', {
      name: 'Legacy Paired',
      folder: 'legacy-paired',
      trigger: '@Codex',
      added_at: '2024-01-01T00:00:00.000Z',
      agentType: 'codex',
    });

    expect(getExplicitRoomMode('dc:legacy-paired')).toBeUndefined();
    expect(getEffectiveRoomMode('dc:legacy-paired')).toBe('tribunal');
    expect(getEffectiveRuntimeRoomMode('dc:legacy-paired')).toBe('tribunal');
  });

  it('backfills inferred room modes for legacy SQL rows missing room_settings', () => {
    const tempDir = fs.mkdtempSync('/tmp/ejclaw-room-mode-');
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
      CREATE TABLE room_settings (
        chat_jid TEXT PRIMARY KEY,
        room_mode TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (room_mode IN ('single', 'tribunal'))
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

    _initTestDatabaseFromFile(dbPath);

    expect(getExplicitRoomMode('dc:legacy-sql')).toBeUndefined();
    expect(getEffectiveRoomMode('dc:legacy-sql')).toBe('tribunal');
    expect(getEffectiveRuntimeRoomMode('dc:legacy-sql')).toBe('tribunal');

    expect(getStoredRoomSettings('dc:legacy-sql')).toMatchObject({
      chatJid: 'dc:legacy-sql',
      roomMode: 'tribunal',
      modeSource: 'inferred',
      name: 'Legacy SQL Room',
      folder: 'legacy-sql-room',
      trigger: '@Codex',
      requiresTrigger: true,
      isMain: false,
      ownerAgentType: 'codex',
    });
  });

  it('keeps room-level metadata synced on setRegisteredGroup helper writes', () => {
    _setRegisteredGroupForTests('dc:room-settings', {
      name: 'Room Settings Test',
      folder: 'room-settings-test',
      trigger: '@Claude',
      added_at: '2024-01-01T00:00:00.000Z',
      agentType: 'claude-code',
    });
    _setRegisteredGroupForTests('dc:room-settings', {
      name: 'Room Settings Test',
      folder: 'room-settings-test',
      trigger: '@Codex',
      added_at: '2024-01-01T00:00:00.000Z',
      agentType: 'codex',
    });

    expect(getStoredRoomSettings('dc:room-settings')).toMatchObject({
      chatJid: 'dc:room-settings',
      roomMode: 'tribunal',
      modeSource: 'inferred',
      name: 'Room Settings Test',
      folder: 'room-settings-test',
      trigger: '@Codex',
      ownerAgentType: 'codex',
    });

    setExplicitRoomMode('dc:room-settings', 'single');

    expect(getStoredRoomSettings('dc:room-settings')).toMatchObject({
      chatJid: 'dc:room-settings',
      roomMode: 'single',
      modeSource: 'explicit',
      name: 'Room Settings Test',
      folder: 'room-settings-test',
      trigger: '@Codex',
      ownerAgentType: 'codex',
    });

    updateRegisteredGroupName('dc:room-settings', 'Room Settings Renamed');

    expect(getStoredRoomSettings('dc:room-settings')).toMatchObject({
      chatJid: 'dc:room-settings',
      roomMode: 'single',
      modeSource: 'explicit',
      name: 'Room Settings Renamed',
      folder: 'room-settings-test',
      trigger: '@Codex',
      ownerAgentType: 'codex',
    });
  });

  it('fails room_settings backfill when room-level metadata conflicts across agent rows', () => {
    const tempDir = fs.mkdtempSync('/tmp/ejclaw-room-settings-conflict-');
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
      CREATE TABLE room_settings (
        chat_jid TEXT PRIMARY KEY,
        room_mode TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (room_mode IN ('single', 'tribunal'))
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
      'dc:conflict',
      'Conflict Room',
      'conflict-folder-1',
      '@Claude',
      '2024-01-01T00:00:00.000Z',
      'claude-code',
    );
    insertGroup.run(
      'dc:conflict',
      'Conflict Room',
      'conflict-folder-2',
      '@Codex',
      '2024-01-01T00:00:00.000Z',
      'codex',
    );
    legacyDb.close();

    expect(() => _initTestDatabaseFromFile(dbPath)).toThrow(
      /Conflicting room-level registered_groups metadata/,
    );
  });

  it('lets explicit single override dual registration for paired-room checks', () => {
    _setRegisteredGroupForTests('dc:explicit-single', {
      name: 'Explicit Single',
      folder: 'explicit-single',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      agentType: 'claude-code',
    });
    _setRegisteredGroupForTests('dc:explicit-single', {
      name: 'Explicit Single',
      folder: 'explicit-single',
      trigger: '@Codex',
      added_at: '2024-01-01T00:00:00.000Z',
      agentType: 'codex',
    });

    setExplicitRoomMode('dc:explicit-single', 'single');

    expect(getExplicitRoomMode('dc:explicit-single')).toBe('single');
    expect(getEffectiveRoomMode('dc:explicit-single')).toBe('single');
    expect(getEffectiveRuntimeRoomMode('dc:explicit-single')).toBe('single');
  });

  it('restores inferred paired mode when clearing an explicit single override', () => {
    _setRegisteredGroupForTests('dc:explicit-single-clear', {
      name: 'Explicit Single Clear',
      folder: 'explicit-single-clear',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      agentType: 'claude-code',
    });
    _setRegisteredGroupForTests('dc:explicit-single-clear', {
      name: 'Explicit Single Clear',
      folder: 'explicit-single-clear',
      trigger: '@Codex',
      added_at: '2024-01-01T00:00:00.000Z',
      agentType: 'codex',
    });

    setExplicitRoomMode('dc:explicit-single-clear', 'single');

    expect(getExplicitRoomMode('dc:explicit-single-clear')).toBe('single');
    expect(getEffectiveRoomMode('dc:explicit-single-clear')).toBe('single');

    clearExplicitRoomMode('dc:explicit-single-clear');

    expect(getExplicitRoomMode('dc:explicit-single-clear')).toBeUndefined();
    expect(getEffectiveRoomMode('dc:explicit-single-clear')).toBe('tribunal');
    expect(getEffectiveRuntimeRoomMode('dc:explicit-single-clear')).toBe(
      'tribunal',
    );
  });

  it('lets explicit tribunal become runnable when the configured reviewer can run on the solo registration', () => {
    _setRegisteredGroupForTests('dc:explicit-tribunal', {
      name: 'Explicit Tribunal Claude',
      folder: 'explicit-tribunal-claude',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      agentType: 'claude-code',
    });

    expect(getEffectiveRoomMode('dc:explicit-tribunal')).toBe('single');

    setExplicitRoomMode('dc:explicit-tribunal', 'tribunal');

    expect(getExplicitRoomMode('dc:explicit-tribunal')).toBe('tribunal');
    expect(getEffectiveRoomMode('dc:explicit-tribunal')).toBe('tribunal');
    expect(getEffectiveRuntimeRoomMode('dc:explicit-tribunal')).toBe(
      'tribunal',
    );

    clearExplicitRoomMode('dc:explicit-tribunal');

    expect(getExplicitRoomMode('dc:explicit-tribunal')).toBeUndefined();
    expect(getEffectiveRoomMode('dc:explicit-tribunal')).toBe('single');
    expect(getEffectiveRuntimeRoomMode('dc:explicit-tribunal')).toBe('single');
  });

  it('trusts stored tribunal mode even when legacy capability rows are incomplete', () => {
    _setRegisteredGroupForTests('dc:explicit-tribunal-codex', {
      name: 'Explicit Tribunal Codex',
      folder: 'explicit-tribunal-codex',
      trigger: '@Codex',
      added_at: '2024-01-01T00:00:00.000Z',
      agentType: 'codex',
    });

    setExplicitRoomMode('dc:explicit-tribunal-codex', 'tribunal');

    expect(getEffectiveRoomMode('dc:explicit-tribunal-codex')).toBe('tribunal');
    expect(getEffectiveRuntimeRoomMode('dc:explicit-tribunal-codex')).toBe(
      'tribunal',
    );
  });
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

  it('stores owner handoff service ids as stable role-slot shadows', () => {
    assignRoom('dc:handoff-owner-shadow', {
      name: 'Owner Handoff Shadow',
      roomMode: 'tribunal',
      ownerAgentType: 'codex',
      folder: 'owner-handoff-shadow',
      trigger: '@Owner',
      requiresTrigger: true,
    });

    const handoff = createServiceHandoff({
      chat_jid: 'dc:handoff-owner-shadow',
      group_folder: 'owner-handoff-shadow',
      source_service_id: CLAUDE_SERVICE_ID,
      target_service_id: CODEX_REVIEW_SERVICE_ID,
      source_role: 'owner',
      target_role: 'owner',
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

  it('normalizes legacy owner handoff service ids to stable role-slot shadows during init', () => {
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

    expect(getPendingServiceHandoffs(CODEX_MAIN_SERVICE_ID)).toEqual([
      expect.objectContaining({
        chat_jid: 'dc:handoff-owner-shadow',
        source_service_id: CODEX_MAIN_SERVICE_ID,
        target_service_id: CODEX_MAIN_SERVICE_ID,
        source_role: 'owner',
        target_role: 'owner',
      }),
    ]);
  });

  it('rebuilds legacy service-shadow tables into canonical schemas while preserving derived runtime shadows', () => {
    const tempDir = fs.mkdtempSync('/tmp/ejclaw-canonical-schema-');
    const dbPath = path.join(tempDir, 'messages.db');
    const legacyDb = new Database(dbPath);

    legacyDb.exec(`
      CREATE TABLE work_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_folder TEXT NOT NULL,
        chat_jid TEXT NOT NULL,
        agent_type TEXT NOT NULL,
        service_id TEXT NOT NULL DEFAULT '',
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
        status TEXT NOT NULL DEFAULT 'active',
        arbiter_verdict TEXT,
        arbiter_requested_at TEXT,
        completion_reason TEXT,
        created_at TEXT NOT NULL,
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
        created_at TEXT NOT NULL,
        claimed_at TEXT,
        completed_at TEXT,
        last_error TEXT
      );
    `);

    legacyDb
      .prepare(
        `INSERT INTO work_items (
          group_folder, chat_jid, agent_type, service_id, delivery_role, status,
          start_seq, end_seq, result_payload, delivery_attempts, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'canonical-schema',
        'dc:canonical-schema',
        'codex',
        CODEX_REVIEW_SERVICE_ID,
        'reviewer',
        'produced',
        1,
        2,
        'payload',
        0,
        '2026-04-03T00:00:00.000Z',
        '2026-04-03T00:00:00.000Z',
      );

    legacyDb
      .prepare(
        `INSERT INTO channel_owner (
          chat_jid, owner_service_id, reviewer_service_id, arbiter_service_id,
          owner_agent_type, reviewer_agent_type, arbiter_agent_type, activated_at, reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'dc:canonical-schema',
        CODEX_MAIN_SERVICE_ID,
        CLAUDE_SERVICE_ID,
        null,
        'codex',
        'claude-code',
        null,
        '2026-04-03T00:00:00.000Z',
        'explicit',
      );

    legacyDb
      .prepare(
        `INSERT INTO paired_tasks (
          id, chat_jid, group_folder, owner_service_id, reviewer_service_id,
          owner_agent_type, reviewer_agent_type, arbiter_agent_type, title,
          source_ref, plan_notes, review_requested_at, round_trip_count,
          status, arbiter_verdict, arbiter_requested_at, completion_reason,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'task-canonical-schema',
        'dc:canonical-schema',
        'canonical-schema',
        CODEX_MAIN_SERVICE_ID,
        CLAUDE_SERVICE_ID,
        'codex',
        'claude-code',
        null,
        'canonical task',
        null,
        null,
        null,
        0,
        'active',
        null,
        null,
        null,
        '2026-04-03T00:00:00.000Z',
        '2026-04-03T00:00:00.000Z',
      );

    legacyDb
      .prepare(
        `INSERT INTO service_handoffs (
          chat_jid, group_folder, source_service_id, target_service_id,
          source_role, target_role, target_agent_type, prompt, status,
          reason, intended_role, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'dc:canonical-schema',
        'canonical-schema',
        CODEX_MAIN_SERVICE_ID,
        CLAUDE_SERVICE_ID,
        'owner',
        'reviewer',
        'claude-code',
        'review please',
        'pending',
        'reviewer-codex-manual',
        'reviewer',
        '2026-04-03T00:00:00.000Z',
      );
    legacyDb.close();

    _initTestDatabaseFromFile(dbPath);

    expect(
      getOpenWorkItem('dc:canonical-schema', 'codex', CODEX_REVIEW_SERVICE_ID),
    ).toMatchObject({
      delivery_role: 'reviewer',
      service_id: CODEX_REVIEW_SERVICE_ID,
    });
    expect(getChannelOwnerLease('dc:canonical-schema')).toMatchObject({
      owner_service_id: CODEX_MAIN_SERVICE_ID,
      reviewer_service_id: CLAUDE_SERVICE_ID,
    });
    expect(getLatestPairedTaskForChat('dc:canonical-schema')).toMatchObject({
      owner_service_id: CODEX_MAIN_SERVICE_ID,
      reviewer_service_id: CLAUDE_SERVICE_ID,
    });
    expect(getPendingServiceHandoffs(CLAUDE_SERVICE_ID)).toEqual([
      expect.objectContaining({
        chat_jid: 'dc:canonical-schema',
        source_service_id: CODEX_MAIN_SERVICE_ID,
        target_service_id: CLAUDE_SERVICE_ID,
        source_agent_type: 'codex',
      }),
    ]);

    const migratedDb = new Database(dbPath, { readonly: true });
    expect(
      (
        migratedDb.prepare(`PRAGMA table_info(work_items)`).all() as Array<{
          name: string;
        }>
      ).map((row) => row.name),
    ).not.toContain('service_id');
    expect(
      (
        migratedDb.prepare(`PRAGMA table_info(channel_owner)`).all() as Array<{
          name: string;
        }>
      ).map((row) => row.name),
    ).not.toContain('owner_service_id');
    expect(
      (
        migratedDb.prepare(`PRAGMA table_info(paired_tasks)`).all() as Array<{
          name: string;
        }>
      ).map((row) => row.name),
    ).not.toContain('owner_service_id');
    expect(
      (
        migratedDb
          .prepare(`PRAGMA table_info(service_handoffs)`)
          .all() as Array<{ name: string }>
      ).map((row) => row.name),
    ).not.toContain('source_service_id');
    expect(
      (
        migratedDb
          .prepare(`PRAGMA table_info(service_handoffs)`)
          .all() as Array<{ name: string }>
      ).map((row) => row.name),
    ).toContain('source_agent_type');
    migratedDb.close();
  });
});

describe('message seq cursors', () => {
  beforeEach(() => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    store({
      id: 'seq-1',
      chat_jid: 'group@g.us',
      sender: 'alice',
      sender_name: 'Alice',
      content: 'first',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'seq-2',
      chat_jid: 'group@g.us',
      sender: 'bob',
      sender_name: 'Bob',
      content: 'second',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    store({
      id: 'seq-3',
      chat_jid: 'group@g.us',
      sender: 'carol',
      sender_name: 'Carol',
      content: 'third',
      timestamp: '2024-01-01T00:00:03.000Z',
    });
  });

  it('assigns monotonic seq values and preserves them on upsert', () => {
    const { messages } = getNewMessagesBySeq(['group@g.us'], 0, 'Andy');
    expect(messages.map((m) => m.seq)).toEqual([1, 2, 3]);

    store({
      id: 'seq-2',
      chat_jid: 'group@g.us',
      sender: 'bob',
      sender_name: 'Bob',
      content: 'second updated',
      timestamp: '2024-01-01T00:00:02.500Z',
    });

    const afterUpdate = getMessagesSinceSeq('group@g.us', 0, 'Andy');
    expect(afterUpdate.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(afterUpdate[1].content).toBe('second updated');
  });

  it('maps legacy timestamp cursors to the latest seq at or before that time', () => {
    expect(
      getLatestMessageSeqAtOrBefore('2024-01-01T00:00:02.000Z', 'group@g.us'),
    ).toBe(2);
  });
});

describe('memories', () => {
  it('recalls scoped memories through FTS and exact keyword matching', () => {
    rememberMemory({
      scopeKind: 'room',
      scopeKey: 'room:test-group',
      content: '세션 재시작 후에도 방 메모리를 주입한다.',
      keywords: ['room:test-group', 'session-reset'],
      sourceKind: 'compact',
      sourceRef: 'compact:1',
    });
    rememberMemory({
      scopeKind: 'room',
      scopeKey: 'room:test-group',
      content: '이 메모리는 다른 검색어다.',
      keywords: ['room:test-group'],
      sourceKind: 'compact',
      sourceRef: 'compact:2',
    });

    const byText = recallMemories({
      scopeKind: 'room',
      scopeKey: 'room:test-group',
      text: 'session reset',
      limit: 5,
    });
    expect(byText).toHaveLength(1);
    expect(byText[0].content).toContain('방 메모리를 주입한다');

    const byKeyword = recallMemories({
      scopeKind: 'room',
      scopeKey: 'room:test-group',
      keywords: ['session-reset'],
      limit: 5,
    });
    expect(byKeyword).toHaveLength(1);
    expect(byKeyword[0].content).toContain('방 메모리를 주입한다');
  });

  it('archives old memories when a scope exceeds its bounded limit', () => {
    for (let index = 0; index < 305; index += 1) {
      rememberMemory({
        scopeKind: 'room',
        scopeKey: 'room:bounded',
        content: `memory-${index}`,
        keywords: ['room:bounded'],
        sourceKind: 'compact',
        sourceRef: `compact:${index}`,
      });
    }

    const recalled = recallMemories({
      scopeKind: 'room',
      scopeKey: 'room:bounded',
      limit: 500,
    });

    expect(recalled).toHaveLength(300);
    expect(recalled.some((memory) => memory.content === 'memory-0')).toBe(
      false,
    );
    expect(recalled.some((memory) => memory.content === 'memory-304')).toBe(
      true,
    );
  });

  it('archives stale compact memories before recall using last_used_at TTL', () => {
    const staleId = rememberMemory({
      scopeKind: 'room',
      scopeKey: 'room:ttl',
      content: '오래된 compact memory',
      keywords: ['room:ttl'],
      sourceKind: 'compact',
      sourceRef: 'compact:stale',
    });
    rememberMemory({
      scopeKind: 'room',
      scopeKey: 'room:ttl',
      content: '최근에 다시 쓰인 compact memory',
      keywords: ['room:ttl'],
      sourceKind: 'compact',
      sourceRef: 'compact:fresh',
    });

    _setMemoryTimestampsForTests(staleId, {
      createdAt: '2020-01-01T00:00:00.000Z',
      lastUsedAt: '2020-01-02T00:00:00.000Z',
    });

    const recalled = recallMemories({
      scopeKind: 'room',
      scopeKey: 'room:ttl',
      limit: 10,
    });

    expect(
      recalled.some((memory) => memory.content === '오래된 compact memory'),
    ).toBe(false);
    expect(
      recalled.some(
        (memory) => memory.content === '최근에 다시 쓰인 compact memory',
      ),
    ).toBe(true);
  });

  it('keeps explicit memories even when they are old', () => {
    const explicitId = rememberMemory({
      scopeKind: 'room',
      scopeKey: 'room:ttl-explicit',
      content: '관리자가 남긴 고정 규칙',
      keywords: ['room:ttl-explicit'],
      sourceKind: 'explicit',
      sourceRef: 'msg:1',
    });

    _setMemoryTimestampsForTests(explicitId, {
      createdAt: '2020-01-01T00:00:00.000Z',
      lastUsedAt: '2020-01-02T00:00:00.000Z',
    });

    const recalled = recallMemories({
      scopeKind: 'room',
      scopeKey: 'room:ttl-explicit',
      limit: 10,
    });

    expect(recalled).toHaveLength(1);
    expect(recalled[0].content).toBe('관리자가 남긴 고정 규칙');
  });
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
    expect(getOpenWorkItem('dc:123', 'claude-code')?.id).toBe(item.id);

    markWorkItemDeliveryRetry(item.id, 'send failed');
    const retried = getOpenWorkItem('dc:123', 'claude-code');
    expect(retried?.status).toBe('delivery_retry');
    expect(retried?.delivery_attempts).toBe(1);
    expect(retried?.last_error).toBe('send failed');

    markWorkItemDelivered(item.id, 'msg-1');
    expect(getOpenWorkItem('dc:123', 'claude-code')).toBeUndefined();
  });

  it('finds pending delivery retries even when they were created by a fallback agent type', () => {
    const fallbackItem = createProducedWorkItem({
      group_folder: 'discord_test',
      chat_jid: 'dc:fallback',
      agent_type: 'codex',
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

  it('stores service shadow as a derived compatibility field from role and agent type', () => {
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
});
