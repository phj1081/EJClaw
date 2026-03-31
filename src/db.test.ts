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
  createPairedTask,
  createTask,
  createServiceHandoff,
  createProducedWorkItem,
  clearExplicitRoomMode,
  deleteSession,
  deleteTask,
  getAllChats,
  getAllRegisteredGroups,
  getDueTasks,
  getEffectiveRoomMode,
  getEffectiveRuntimeRoomMode,
  getExplicitRoomMode,
  getLatestMessageSeqAtOrBefore,
  getLatestPairedTaskForChat,
  getMessagesSinceSeq,
  getNewMessagesBySeq,
  getOpenWorkItem,
  getPendingServiceHandoffs,
  getRegisteredAgentTypesForJid,
  getMessagesSince,
  getNewMessages,
  getPairedProject,
  getPairedTaskById,
  getPairedWorkspace,
  getRouterStateForService,
  getSession,
  getStoredRoomSettings,
  getTaskById,
  listPairedWorkspacesForTask,
  markWorkItemDelivered,
  markWorkItemDeliveryRetry,
  setSession,
  setRegisteredGroup,
  setRouterStateForService,
  setExplicitRoomMode,
  storeChatMetadata,
  storeMessage,
  updateRegisteredGroupName,
  updatePairedTask,
  upsertPairedProject,
  upsertPairedWorkspace,
  updateTask,
} from './db.js';
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
    setRegisteredGroup('dc:main', {
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
    setRegisteredGroup('group@g.us', {
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
    setRegisteredGroup('dc:shared', {
      name: 'Shared Room',
      folder: 'shared-room',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      agentType: 'claude-code',
    });
    setRegisteredGroup('dc:shared', {
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
});

describe('paired room registration', () => {
  it('detects when both Claude and Codex are registered on the same jid', () => {
    setRegisteredGroup('dc:123', {
      name: 'Paired Room',
      folder: 'paired-room',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      agentType: 'claude-code',
    });
    setRegisteredGroup('dc:123', {
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
    setRegisteredGroup('dc:solo', {
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
    setRegisteredGroup('dc:legacy-paired', {
      name: 'Legacy Paired',
      folder: 'legacy-paired',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      agentType: 'claude-code',
    });
    setRegisteredGroup('dc:legacy-paired', {
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
    setRegisteredGroup('dc:room-settings', {
      name: 'Room Settings Test',
      folder: 'room-settings-test',
      trigger: '@Claude',
      added_at: '2024-01-01T00:00:00.000Z',
      agentType: 'claude-code',
    });
    setRegisteredGroup('dc:room-settings', {
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
    setRegisteredGroup('dc:explicit-single', {
      name: 'Explicit Single',
      folder: 'explicit-single',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      agentType: 'claude-code',
    });
    setRegisteredGroup('dc:explicit-single', {
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

  it('lets explicit tribunal become runnable when the configured reviewer can run on the solo registration', () => {
    setRegisteredGroup('dc:explicit-tribunal', {
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

  it('keeps explicit tribunal non-runnable when the configured reviewer service is unavailable', () => {
    setRegisteredGroup('dc:explicit-tribunal-codex', {
      name: 'Explicit Tribunal Codex',
      folder: 'explicit-tribunal-codex',
      trigger: '@Codex',
      added_at: '2024-01-01T00:00:00.000Z',
      agentType: 'codex',
    });

    setExplicitRoomMode('dc:explicit-tribunal-codex', 'tribunal');

    expect(getEffectiveRoomMode('dc:explicit-tribunal-codex')).toBe('tribunal');
    expect(getEffectiveRuntimeRoomMode('dc:explicit-tribunal-codex')).toBe(
      'single',
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
      target_service_id: 'codex-review',
      chat_jid: 'dc:handoff',
      end_seq: 1,
    });

    expect(appliedCursor).toBe('1');
    expect(getPendingServiceHandoffs('codex-review')).toEqual([]);
    expect(
      JSON.parse(
        getRouterStateForService('last_agent_seq', 'codex-review') || '{}',
      ),
    ).toMatchObject({
      'dc:handoff': '1',
    });
  });

  it('does not move the target cursor backwards when a newer cursor already exists', () => {
    storeChatMetadata('dc:handoff', '2024-01-01T00:00:00.000Z');
    setRouterStateForService(
      'last_agent_seq',
      JSON.stringify({ 'dc:handoff': '5' }),
      'codex-review',
    );
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
      target_service_id: 'codex-review',
      chat_jid: 'dc:handoff',
      end_seq: 3,
    });

    expect(appliedCursor).toBe('5');
    expect(
      JSON.parse(
        getRouterStateForService('last_agent_seq', 'codex-review') || '{}',
      ),
    ).toMatchObject({
      'dc:handoff': '5',
    });
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

describe('work items', () => {
  it('tracks produced, retry, and delivered states', () => {
    const item = createProducedWorkItem({
      group_folder: 'discord_test',
      chat_jid: 'dc:123',
      agent_type: 'claude-code',
      start_seq: 10,
      end_seq: 12,
      result_payload: 'hello',
    });

    expect(getOpenWorkItem('dc:123', 'claude-code')?.id).toBe(item.id);

    markWorkItemDeliveryRetry(item.id, 'send failed');
    const retried = getOpenWorkItem('dc:123', 'claude-code');
    expect(retried?.status).toBe('delivery_retry');
    expect(retried?.delivery_attempts).toBe(1);
    expect(retried?.last_error).toBe('send failed');

    markWorkItemDelivered(item.id, 'msg-1');
    expect(getOpenWorkItem('dc:123', 'claude-code')).toBeUndefined();
  });
});
