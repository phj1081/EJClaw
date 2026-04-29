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
  claimPairedTurnReservation,
  failPairedTurn,
  failServiceHandoff,
  deleteSession,
  deleteTask,
  getAllChats,
  getChannelOwnerLease,
  getAllRoomBindings,
  getDueTasks,
  getEffectiveRoomMode,
  getEffectiveRuntimeRoomMode,
  getExplicitRoomMode,
  getLatestMessageSeqAtOrBefore,
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
  getPairedTurnAttempts,
  getPairedTurnById,
  getPairedTurnsForTask,
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
  markPairedTurnRunning,
  releasePairedTaskExecutionLease,
  reservePairedTurnReservation,
  setSession,
  setRouterState,
  setExplicitRoomMode,
  rememberMemory,
  storeChatMetadata,
  storeMessage,
  setChannelOwnerLease,
  updateRegisteredGroupName,
  updatePairedTask,
  upsertPairedProject,
  upsertPairedWorkspace,
  updateTask,
} from './db.js';
import { initializeDatabaseSchema } from './db/bootstrap.js';
import {
  buildPairedTurnAttemptId,
  buildPairedTurnAttemptParentId,
} from './db/paired-turn-attempts.js';
import {
  type RoomRegistrationSnapshot,
  type RoomRoleOverrideSnapshot,
  type StoredRoomSettings,
  getStoredRoomSettingsRowFromDatabase,
  inferOwnerAgentTypeFromRegisteredAgentTypes,
  inferRoomModeFromRegisteredAgentTypes,
  insertStoredRoomSettingsFromMigration,
  normalizeStoredAgentType,
  upsertRoomRoleOverride,
} from './db/room-registration.js';
import { buildPairedTurnIdentity } from './paired-turn-identity.js';
import {
  ARBITER_AGENT_TYPE,
  CLAUDE_SERVICE_ID,
  CODEX_MAIN_SERVICE_ID,
  CODEX_REVIEW_SERVICE_ID,
  OWNER_AGENT_TYPE,
  SERVICE_ID,
  SERVICE_SESSION_SCOPE,
  normalizeServiceId,
} from './config.js';
import {
  resolveTaskRuntimeIpcPath,
  resolveTaskSessionsPath,
} from './group-folder.js';
import type { PairedTask } from './types.js';

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

function insertPairedTurnIdentityRow(
  database: Database,
  args: {
    turnId: string;
    taskId: string;
    taskUpdatedAt: string;
    role: 'owner' | 'reviewer' | 'arbiter';
    intentKind:
      | 'owner-turn'
      | 'reviewer-turn'
      | 'arbiter-turn'
      | 'owner-follow-up'
      | 'finalize-owner-turn';
    createdAt: string;
    updatedAt: string;
  },
): void {
  database
    .prepare(
      `
        INSERT INTO paired_turns (
          turn_id,
          task_id,
          task_updated_at,
          role,
          intent_kind,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      args.turnId,
      args.taskId,
      args.taskUpdatedAt,
      args.role,
      args.intentKind,
      args.createdAt,
      args.updatedAt,
    );
}

type LegacyRoomMigrationPlanForTests = Parameters<
  typeof insertStoredRoomSettingsFromMigration
>[1];

function getStoredRoleOverridesForLegacyMigration(
  database: Database,
  jid: string,
): Map<
  'owner' | 'reviewer' | 'arbiter',
  {
    role: 'owner' | 'reviewer' | 'arbiter';
    agentType: 'claude-code' | 'codex';
    agentConfig?: unknown;
    createdAt: string;
    updatedAt: string;
  }
> {
  let rows: Array<{
    role: 'owner' | 'reviewer' | 'arbiter';
    agent_type: string | null;
    agent_config_json: string | null;
    created_at: string;
    updated_at: string;
  }>;
  try {
    rows = database
      .prepare(
        `SELECT role, agent_type, agent_config_json, created_at, updated_at
           FROM room_role_overrides
          WHERE chat_jid = ?`,
      )
      .all(jid) as Array<{
      role: 'owner' | 'reviewer' | 'arbiter';
      agent_type: string | null;
      agent_config_json: string | null;
      created_at: string;
      updated_at: string;
    }>;
  } catch {
    return new Map();
  }

  const result = new Map<
    'owner' | 'reviewer' | 'arbiter',
    {
      role: 'owner' | 'reviewer' | 'arbiter';
      agentType: 'claude-code' | 'codex';
      agentConfig?: unknown;
      createdAt: string;
      updatedAt: string;
    }
  >();
  for (const row of rows) {
    const agentType = normalizeStoredAgentType(row.agent_type);
    if (!agentType) continue;
    result.set(row.role, {
      role: row.role,
      agentType,
      agentConfig: row.agent_config_json
        ? JSON.parse(row.agent_config_json)
        : undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }
  return result;
}

function collectLegacyRoomRegistrationSnapshotForTests(
  database: Database,
  jid: string,
  existingStored?: Pick<
    StoredRoomSettings,
    'modeSource' | 'ownerAgentType' | 'trigger'
  >,
): RoomRegistrationSnapshot | undefined {
  const rows = database
    .prepare(
      `SELECT name, folder, trigger_pattern, requires_trigger, is_main, agent_type, work_dir
         FROM registered_groups
        WHERE jid = ?
        ORDER BY agent_type`,
    )
    .all(jid) as Array<{
    name: string;
    folder: string;
    trigger_pattern: string;
    requires_trigger: number | null;
    is_main: number | null;
    agent_type: string | null;
    work_dir: string | null;
  }>;
  if (rows.length === 0) return undefined;

  const first = rows[0]!;
  const conflicts = new Set<string>();
  for (const row of rows.slice(1)) {
    if (row.name !== first.name) conflicts.add('name');
    if (row.folder !== first.folder) conflicts.add('folder');
    if ((row.requires_trigger ?? 1) !== (first.requires_trigger ?? 1)) {
      conflicts.add('requires_trigger');
    }
    if ((row.is_main ?? 0) !== (first.is_main ?? 0)) {
      conflicts.add('is_main');
    }
    if ((row.work_dir ?? null) !== (first.work_dir ?? null)) {
      conflicts.add('work_dir');
    }
  }
  if (conflicts.size > 0) {
    throw new Error(
      `Conflicting room-level registered_groups metadata for ${jid}: ${[
        ...conflicts,
      ].join(', ')}`,
    );
  }

  const agentTypes = new Set<'claude-code' | 'codex'>();
  for (const row of rows) {
    const agentType = normalizeStoredAgentType(row.agent_type);
    if (agentType) {
      agentTypes.add(agentType);
    }
  }
  const inferredOwnerAgentType = inferOwnerAgentTypeFromRegisteredAgentTypes([
    ...agentTypes,
  ]);
  const preferExplicitTrigger =
    existingStored?.modeSource === 'explicit' && existingStored.trigger;
  const preferExplicitOwner =
    existingStored?.modeSource === 'explicit' && existingStored.ownerAgentType;
  const preferredOwnerAgentType = preferExplicitOwner
    ? existingStored.ownerAgentType
    : undefined;
  const preferredOwnerRow = preferredOwnerAgentType
    ? rows.find(
        (row) =>
          normalizeStoredAgentType(row.agent_type) === preferredOwnerAgentType,
      )
    : undefined;
  const inferredOwnerRow =
    rows.find(
      (row) =>
        normalizeStoredAgentType(row.agent_type) === inferredOwnerAgentType,
    ) ?? rows[0]!;
  const ownerAgentType = preferredOwnerAgentType ?? inferredOwnerAgentType;
  const ownerRow = preferredOwnerRow ?? inferredOwnerRow;

  return {
    name: first.name,
    folder: first.folder,
    triggerPattern: preferExplicitTrigger
      ? existingStored.trigger!
      : (preferredOwnerRow?.trigger_pattern ?? ownerRow.trigger_pattern),
    requiresTrigger: (first.requires_trigger ?? 1) === 1,
    isMain: (first.is_main ?? 0) === 1,
    ownerAgentType,
    workDir: first.work_dir ?? null,
  };
}

function buildLegacyRoomMigrationPlanForTests(
  database: Database,
  jid: string,
): LegacyRoomMigrationPlanForTests | undefined {
  const existingStored = getStoredRoomSettingsRowFromDatabase(database, jid);
  const snapshot = collectLegacyRoomRegistrationSnapshotForTests(
    database,
    jid,
    existingStored,
  );
  if (!snapshot) return undefined;

  const rows = database
    .prepare(
      `SELECT added_at
         FROM registered_groups
        WHERE jid = ?
        ORDER BY added_at, agent_type`,
    )
    .all(jid) as Array<{ added_at: string }>;
  if (rows.length === 0) return undefined;

  const agentTypes = (
    database
      .prepare(
        `SELECT agent_type
           FROM registered_groups
          WHERE jid = ?`,
      )
      .all(jid) as Array<{ agent_type: string | null }>
  )
    .map((row) => normalizeStoredAgentType(row.agent_type))
    .filter((value): value is 'claude-code' | 'codex' => Boolean(value));
  const roomMode =
    existingStored?.roomMode ??
    inferRoomModeFromRegisteredAgentTypes(agentTypes);
  const createdAt = rows[0]!.added_at;
  const updatedAt = rows[rows.length - 1]!.added_at;
  const roleOverrides: RoomRoleOverrideSnapshot[] = [];

  const getCapabilityMetadata = (
    preferredAgentType?: 'claude-code' | 'codex',
  ) =>
    (preferredAgentType
      ? database
          .prepare(
            `SELECT added_at, agent_config
                 FROM registered_groups
                WHERE jid = ? AND agent_type = ?
                LIMIT 1`,
          )
          .get(jid, preferredAgentType)
      : database
          .prepare(
            `SELECT added_at, agent_config
                 FROM registered_groups
                WHERE jid = ?
                ORDER BY CASE WHEN agent_type = ? THEN 0 ELSE 1 END, added_at
                LIMIT 1`,
          )
          .get(jid, OWNER_AGENT_TYPE)) as
      | { added_at: string; agent_config: string | null }
      | undefined;

  const ownerMetadata = getCapabilityMetadata(snapshot.ownerAgentType);
  roleOverrides.push({
    role: 'owner',
    agentType: snapshot.ownerAgentType,
    agentConfig: ownerMetadata?.agent_config
      ? JSON.parse(ownerMetadata.agent_config)
      : undefined,
    createdAt: ownerMetadata?.added_at ?? createdAt,
    updatedAt,
  });

  if (roomMode === 'tribunal') {
    const reviewerAgentType = agentTypes.find(
      (agentType) => agentType !== snapshot.ownerAgentType,
    );
    if (!reviewerAgentType) {
      throw new Error(
        `Missing reviewer agent type for tribunal legacy room ${jid}`,
      );
    }
    const reviewerMetadata = getCapabilityMetadata(reviewerAgentType);
    roleOverrides.push({
      role: 'reviewer',
      agentType: reviewerAgentType,
      agentConfig: reviewerMetadata?.agent_config
        ? JSON.parse(reviewerMetadata.agent_config)
        : undefined,
      createdAt: reviewerMetadata?.added_at ?? createdAt,
      updatedAt,
    });
  }

  return {
    chatJid: jid,
    roomMode,
    createdAt,
    updatedAt,
    snapshot,
    roleOverrides,
  };
}

function getPendingLegacyRegisteredGroupJidsForTests(
  database: Database,
): string[] {
  const rows = database
    .prepare(
      `SELECT DISTINCT jid
         FROM registered_groups
        ORDER BY jid`,
    )
    .all() as Array<{ jid: string }>;

  return rows
    .map((row) => row.jid)
    .filter((jid) => {
      const stored = getStoredRoomSettingsRowFromDatabase(database, jid);
      if (!stored) {
        return true;
      }

      const plan = buildLegacyRoomMigrationPlanForTests(database, jid);
      if (!plan) {
        return false;
      }
      if (
        stored.name !== plan.snapshot.name ||
        stored.folder !== plan.snapshot.folder ||
        (stored.requiresTrigger ?? true) !== plan.snapshot.requiresTrigger ||
        (stored.isMain ?? false) !== plan.snapshot.isMain ||
        (stored.workDir ?? null) !== (plan.snapshot.workDir ?? null)
      ) {
        return true;
      }

      const existingOverrides = getStoredRoleOverridesForLegacyMigration(
        database,
        jid,
      );
      return plan.roleOverrides.some((override) => {
        const actual = existingOverrides.get(override.role);
        return (
          actual?.agentType !== override.agentType ||
          JSON.stringify(actual?.agentConfig ?? null) !==
            JSON.stringify(override.agentConfig ?? null)
        );
      });
    });
}

function migrateLegacyRoomRegistrationsInFile(dbPath: string): {
  migratedRooms: number;
  migratedRoleOverrides: number;
} {
  const migrationDb = new Database(dbPath);
  let migratedRooms = 0;
  let migratedRoleOverrides = 0;

  try {
    initializeDatabaseSchema(migrationDb);
    migrationDb.transaction(() => {
      const rows = getPendingLegacyRegisteredGroupJidsForTests(migrationDb).map(
        (jid) => ({ jid }),
      );

      for (const row of rows) {
        const plan = buildLegacyRoomMigrationPlanForTests(migrationDb, row.jid);
        if (!plan) continue;
        const existing = migrationDb
          .prepare('SELECT 1 FROM room_settings WHERE chat_jid = ?')
          .get(row.jid);
        if (!existing) {
          insertStoredRoomSettingsFromMigration(migrationDb, plan);
          migratedRooms += 1;
        }
        for (const override of plan.roleOverrides) {
          upsertRoomRoleOverride(migrationDb, row.jid, override);
          migratedRoleOverrides += 1;
        }
      }
      migrationDb.exec(`DROP TABLE IF EXISTS registered_groups`);
    })();
  } finally {
    migrationDb.close();
  }

  return { migratedRooms, migratedRoleOverrides };
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

  it('backfills legacy service_sessions rows into sessions during init', () => {
    const tempDir = fs.mkdtempSync('/tmp/ejclaw-service-sessions-backfill-');
    const dbPath = path.join(tempDir, 'messages.db');
    const legacyDb = new Database(dbPath);

    legacyDb.exec(`
      CREATE TABLE sessions (
        group_folder TEXT PRIMARY KEY,
        session_id TEXT NOT NULL
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
      .run('group-legacy', CLAUDE_SERVICE_ID, 'legacy-service-session-123');
    legacyDb.close();

    _initTestDatabaseFromFile(dbPath);

    expect(getSession('group-legacy', 'claude-code')).toBe(
      'legacy-service-session-123',
    );

    const migratedDb = new Database(dbPath, { readonly: true });
    const hasServiceSessions = Boolean(
      migratedDb
        .prepare(
          `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'service_sessions'`,
        )
        .get(),
    );
    expect(hasServiceSessions).toBe(false);
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
    expect(outputs[0].verdict).toBe('continue');
    expect(outputs[1].output_text).toBe('review turn');
    expect(outputs[1].verdict).toBe('continue');
    expect(getLatestTurnNumber('paired-task-turn-output')).toBe(2);
  });

  it('stores the parsed visible verdict with paired turn outputs', () => {
    createPairedTask({
      id: 'paired-task-turn-output-verdict',
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
      'paired-task-turn-output-verdict',
      1,
      'owner',
      'STEP_DONE\n1단계 완료',
    );
    insertPairedTurnOutput(
      'paired-task-turn-output-verdict',
      2,
      'owner',
      'TASK_DONE\n요청 범위 전체 완료',
    );

    const outputs = getPairedTurnOutputs('paired-task-turn-output-verdict');

    expect(outputs.map((output) => output.verdict)).toEqual([
      'step_done',
      'task_done',
    ]);
  });

  it('preserves explicit created_at when inserting a paired turn output', () => {
    createPairedTask({
      id: 'paired-task-turn-output-created-at',
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
      'paired-task-turn-output-created-at',
      0,
      'owner',
      'carried forward owner final',
      '2026-03-28T00:01:23.000Z',
    );

    const outputs = getPairedTurnOutputs('paired-task-turn-output-created-at');

    expect(outputs).toHaveLength(1);
    expect(outputs[0].created_at).toBe('2026-03-28T00:01:23.000Z');
  });

  it('fails init when paired task agent and service metadata conflict', () => {
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

    expect(() => _initTestDatabaseFromFile(dbPath)).toThrow(
      /paired_tasks\(paired-legacy-1\): reviewer_agent_type conflicts with reviewer_service_id/,
    );
  });

  it('preserves raw legacy paired task service ids during init when failover created the task', () => {
    const tempDir = fs.mkdtempSync('/tmp/ejclaw-paired-task-legacy-failover-');
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
        'paired-legacy-failover',
        'dc:paired-failover',
        'paired-failover-room',
        CODEX_REVIEW_SERVICE_ID,
        CLAUDE_SERVICE_ID,
        null,
        null,
        null,
        'legacy failover task',
        null,
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

    expect(getPairedTaskById('paired-legacy-failover')).toMatchObject({
      owner_service_id: CODEX_REVIEW_SERVICE_ID,
      reviewer_service_id: CLAUDE_SERVICE_ID,
      owner_agent_type: 'codex',
      reviewer_agent_type: 'claude-code',
    });
  });

  it('backfills configured owner agent type when creating a paired task with a raw non-shadow owner service id', () => {
    createPairedTask({
      id: 'paired-task-raw-owner-service',
      chat_jid: 'dc:paired-raw-owner-service',
      group_folder: 'paired-raw-owner-service',
      owner_service_id: 'andy',
      reviewer_service_id: CLAUDE_SERVICE_ID,
      title: null,
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

    expect(getPairedTaskById('paired-task-raw-owner-service')).toMatchObject({
      owner_service_id: 'andy',
      reviewer_service_id: CLAUDE_SERVICE_ID,
      owner_agent_type: OWNER_AGENT_TYPE,
      reviewer_agent_type: 'claude-code',
    });
  });

  it('preserves raw legacy paired task service ids during init when registered group metadata is present', () => {
    const tempDir = fs.mkdtempSync('/tmp/ejclaw-paired-task-legacy-groups-');
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
      'dc:paired-failover-groups',
      'Legacy Failover Groups',
      'paired-failover-groups',
      '@Claude',
      '2024-01-01T00:00:00.000Z',
      'claude-code',
    );
    insertGroup.run(
      'dc:paired-failover-groups',
      'Legacy Failover Groups',
      'paired-failover-groups',
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
        'paired-legacy-groups',
        'dc:paired-failover-groups',
        'paired-failover-groups',
        CODEX_REVIEW_SERVICE_ID,
        CLAUDE_SERVICE_ID,
        null,
        null,
        null,
        'legacy failover with groups',
        null,
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

    expect(migrateLegacyRoomRegistrationsInFile(dbPath)).toEqual({
      migratedRooms: 1,
      migratedRoleOverrides: 2,
    });
    _initTestDatabaseFromFile(dbPath);

    expect(getPairedTaskById('paired-legacy-groups')).toMatchObject({
      owner_service_id: CODEX_REVIEW_SERVICE_ID,
      reviewer_service_id: CLAUDE_SERVICE_ID,
      owner_agent_type: 'codex',
      reviewer_agent_type: 'claude-code',
    });
  });

  it('preserves raw legacy channel owner lease service ids during init', () => {
    const tempDir = fs.mkdtempSync('/tmp/ejclaw-channel-owner-legacy-');
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

    legacyDb
      .prepare(
        `INSERT INTO channel_owner (
          chat_jid,
          owner_service_id,
          reviewer_service_id,
          arbiter_service_id,
          owner_agent_type,
          reviewer_agent_type,
          arbiter_agent_type,
          activated_at,
          reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'dc:legacy-channel-owner',
        CODEX_REVIEW_SERVICE_ID,
        CLAUDE_SERVICE_ID,
        null,
        null,
        null,
        null,
        '2026-03-28T00:00:00.000Z',
        'legacy-failover',
      );
    legacyDb.close();

    _initTestDatabaseFromFile(dbPath);

    expect(getChannelOwnerLease('dc:legacy-channel-owner')).toMatchObject({
      owner_service_id: CODEX_REVIEW_SERVICE_ID,
      reviewer_service_id: CLAUDE_SERVICE_ID,
      owner_agent_type: 'codex',
      reviewer_agent_type: 'claude-code',
    });
  });

  it('fails fast when a paired task row loses canonical agent metadata after init', () => {
    const tempDir = fs.mkdtempSync('/tmp/ejclaw-paired-task-strict-read-');
    const dbPath = path.join(tempDir, 'messages.db');

    try {
      const fileDb = new Database(dbPath);
      initializeDatabaseSchema(fileDb);
      fileDb.close();

      _initTestDatabaseFromFile(dbPath);
      createPairedTask({
        id: 'paired-task-strict-read',
        chat_jid: 'dc:paired-task-strict-read',
        group_folder: 'paired-task-strict-read',
        owner_service_id: CODEX_MAIN_SERVICE_ID,
        reviewer_service_id: CLAUDE_SERVICE_ID,
        owner_agent_type: 'codex',
        reviewer_agent_type: 'claude-code',
        arbiter_agent_type: null,
        title: 'strict read task',
        source_ref: null,
        plan_notes: null,
        review_requested_at: null,
        round_trip_count: 0,
        status: 'active',
        arbiter_verdict: null,
        arbiter_requested_at: null,
        completion_reason: null,
        created_at: '2026-04-10T00:00:00.000Z',
        updated_at: '2026-04-10T00:00:00.000Z',
      });

      const rawDb = new Database(dbPath);
      rawDb
        .prepare(
          `UPDATE paired_tasks
              SET reviewer_agent_type = NULL
            WHERE id = ?`,
        )
        .run('paired-task-strict-read');
      rawDb.close();

      expect(() => getPairedTaskById('paired-task-strict-read')).toThrow(
        /cannot read reviewer_agent_type from stored row metadata/,
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      _initTestDatabase();
    }
  });

  it('preserves stored reviewer service ids during init even when reviewer agent metadata exists', () => {
    const tempDir = fs.mkdtempSync(
      '/tmp/ejclaw-channel-owner-stored-reviewer-',
    );
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

    legacyDb
      .prepare(
        `INSERT INTO channel_owner (
          chat_jid,
          owner_service_id,
          reviewer_service_id,
          arbiter_service_id,
          owner_agent_type,
          reviewer_agent_type,
          arbiter_agent_type,
          activated_at,
          reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'dc:legacy-channel-owner-stored-reviewer',
        CLAUDE_SERVICE_ID,
        'stale-reviewer-shadow',
        null,
        'claude-code',
        'codex',
        null,
        '2026-03-28T00:00:00.000Z',
        'legacy-reviewer-stored-id',
      );
    legacyDb.close();

    _initTestDatabaseFromFile(dbPath);

    expect(
      getChannelOwnerLease('dc:legacy-channel-owner-stored-reviewer'),
    ).toMatchObject({
      owner_service_id: CLAUDE_SERVICE_ID,
      reviewer_service_id: 'stale-reviewer-shadow',
      owner_agent_type: 'claude-code',
      reviewer_agent_type: 'codex',
    });
  });

  it('fails fast when a channel owner lease row loses canonical reviewer metadata after init', () => {
    const tempDir = fs.mkdtempSync('/tmp/ejclaw-channel-owner-strict-read-');
    const dbPath = path.join(tempDir, 'messages.db');

    try {
      const fileDb = new Database(dbPath);
      initializeDatabaseSchema(fileDb);
      fileDb.close();

      _initTestDatabaseFromFile(dbPath);
      setChannelOwnerLease({
        chat_jid: 'dc:channel-owner-strict-read',
        owner_service_id: CODEX_MAIN_SERVICE_ID,
        reviewer_service_id: CLAUDE_SERVICE_ID,
        owner_agent_type: 'codex',
        reviewer_agent_type: 'claude-code',
        reason: 'strict read setup',
      });

      const rawDb = new Database(dbPath);
      rawDb
        .prepare(
          `UPDATE channel_owner
              SET reviewer_agent_type = NULL
            WHERE chat_jid = ?`,
        )
        .run('dc:channel-owner-strict-read');
      rawDb.close();

      expect(() =>
        getChannelOwnerLease('dc:channel-owner-strict-read'),
      ).toThrow(/cannot read reviewer_agent_type from stored row metadata/);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      _initTestDatabase();
    }
  });

  it('fails init when stored paired task metadata conflicts with stored service ids even if room settings differ', () => {
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

    expect(() => _initTestDatabaseFromFile(dbPath)).toThrow(
      /paired_tasks\(paired-task-ssot\): owner_agent_type conflicts with owner_service_id/,
    );
  });

  it('preserves explicit room trigger during init without rewriting task agent metadata from room settings', () => {
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

    expect(migrateLegacyRoomRegistrationsInFile(dbPath)).toEqual({
      migratedRooms: 0,
      migratedRoleOverrides: 2,
    });
    _initTestDatabaseFromFile(dbPath);

    expect(getStoredRoomSettings('dc:explicit-owner')).toMatchObject({
      roomMode: 'tribunal',
      modeSource: 'explicit',
      ownerAgentType: 'claude-code',
      trigger: '@Custom',
    });
    expect(getPairedTaskById('paired-explicit-owner')).toMatchObject({
      owner_service_id: CODEX_REVIEW_SERVICE_ID,
      reviewer_service_id: CODEX_MAIN_SERVICE_ID,
      owner_agent_type: 'codex',
      reviewer_agent_type: 'codex',
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

    expect(migrateLegacyRoomRegistrationsInFile(dbPath)).toEqual({
      migratedRooms: 0,
      migratedRoleOverrides: 2,
    });
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
  it('projects trigger metadata from canonical room settings into registered groups', () => {
    _setRegisteredGroupForTests('dc:triggered', {
      name: 'Triggered Room',
      folder: 'triggered-room',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      requiresTrigger: true,
    });

    expect(getRegisteredGroup('dc:triggered')).toMatchObject({
      trigger: '@Andy',
      requiresTrigger: true,
    });
    expect(getAllRoomBindings()['dc:triggered']).toMatchObject({
      trigger: '@Andy',
      requiresTrigger: true,
    });
  });

  it('persists isMain=true through set/get round-trip', () => {
    _setRegisteredGroupForTests('dc:main', {
      name: 'Main Chat',
      folder: 'discord_main',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: true,
    });

    const groups = getAllRoomBindings();
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

    const groups = getAllRoomBindings();
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

    const claudeGroups = getAllRoomBindings('claude-code');
    const codexGroups = getAllRoomBindings('codex');

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

describe('paired room registration', () => {
  it('detects paired capability types from canonical tribunal room settings', () => {
    assignRoom('dc:123', {
      name: 'Paired Room',
      roomMode: 'tribunal',
      ownerAgentType: 'codex',
      folder: 'paired-room',
    });

    expect(getRegisteredAgentTypesForJid('dc:123').sort()).toEqual([
      'claude-code',
      'codex',
    ]);
    expect(getExplicitRoomMode('dc:123')).toBe('tribunal');
    expect(getEffectiveRoomMode('dc:123')).toBe('tribunal');
    expect(getEffectiveRuntimeRoomMode('dc:123')).toBe('tribunal');
  });

  it('does not mark canonical single rooms as paired', () => {
    assignRoom('dc:solo', {
      name: 'Solo Claude Room',
      roomMode: 'single',
      ownerAgentType: 'claude-code',
      folder: 'solo-claude',
    });

    expect(getRegisteredAgentTypesForJid('dc:solo')).toEqual(['claude-code']);
    expect(getEffectiveRuntimeRoomMode('dc:solo')).toBe('single');
  });

  it('keeps canonical inferred room mode available when no explicit override exists', () => {
    assignRoom('dc:canonical-inferred-paired', {
      name: 'Canonical Inferred Paired',
      roomMode: 'tribunal',
      ownerAgentType: 'codex',
      folder: 'canonical-inferred-paired',
    });

    clearExplicitRoomMode('dc:canonical-inferred-paired');

    expect(getExplicitRoomMode('dc:canonical-inferred-paired')).toBeUndefined();
    expect(getEffectiveRoomMode('dc:canonical-inferred-paired')).toBe(
      'tribunal',
    );
    expect(getEffectiveRuntimeRoomMode('dc:canonical-inferred-paired')).toBe(
      'tribunal',
    );
  });

  it('ignores legacy capability rows when canonical room settings are missing', () => {
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
    _deleteStoredRoomSettingsForTests('dc:legacy-paired');

    expect(getRegisteredAgentTypesForJid('dc:legacy-paired')).toEqual([]);
    expect(getExplicitRoomMode('dc:legacy-paired')).toBeUndefined();
    expect(getEffectiveRoomMode('dc:legacy-paired')).toBe('single');
    expect(getEffectiveRuntimeRoomMode('dc:legacy-paired')).toBe('single');
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

  it('trusts stored tribunal mode without projection rows', () => {
    assignRoom('dc:explicit-tribunal-codex', {
      name: 'Explicit Tribunal Codex',
      roomMode: 'single',
      ownerAgentType: 'codex',
      folder: 'explicit-tribunal-codex',
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

  it('marks a delegated logical turn failed when its handoff fails', () => {
    const handoff = createServiceHandoff({
      chat_jid: 'dc:handoff-failed-turn',
      group_folder: 'handoff-failed-turn',
      paired_task_id: 'task-failed-reviewer-handoff',
      paired_task_updated_at: '2026-04-10T00:00:00.000Z',
      turn_intent_kind: 'reviewer-turn',
      turn_role: 'reviewer',
      source_service_id: CLAUDE_SERVICE_ID,
      target_service_id: CODEX_REVIEW_SERVICE_ID,
      source_role: 'owner',
      target_role: 'reviewer',
      source_agent_type: 'claude-code',
      target_agent_type: 'codex',
      prompt: 'failed reviewer handoff',
      intended_role: 'reviewer',
    });

    failServiceHandoff(handoff.id, 'Group not registered on target service');

    expect(
      getPairedTurnById(
        'task-failed-reviewer-handoff:2026-04-10T00:00:00.000Z:reviewer-turn',
      ),
    ).toMatchObject({
      turn_id:
        'task-failed-reviewer-handoff:2026-04-10T00:00:00.000Z:reviewer-turn',
      state: 'failed',
      last_error: 'Group not registered on target service',
    });
    expect(getPendingServiceHandoffs(CODEX_REVIEW_SERVICE_ID)).toEqual([]);
  });

  it('records queued and running logical turn state across reservation and lease claims', () => {
    const task: PairedTask = {
      id: 'task-paired-turn-state',
      chat_jid: 'group@test',
      group_folder: 'test-group',
      owner_service_id: CLAUDE_SERVICE_ID,
      reviewer_service_id: CODEX_REVIEW_SERVICE_ID,
      owner_agent_type: 'claude-code',
      reviewer_agent_type: 'codex',
      arbiter_agent_type: null,
      title: null,
      source_ref: 'HEAD',
      plan_notes: null,
      review_requested_at: '2026-04-10T00:00:00.000Z',
      round_trip_count: 1,
      status: 'review_ready' as const,
      arbiter_verdict: null,
      arbiter_requested_at: null,
      completion_reason: null,
      created_at: '2026-04-10T00:00:00.000Z',
      updated_at: '2026-04-10T00:00:00.000Z',
    };
    createPairedTask(task);

    expect(
      reservePairedTurnReservation({
        chatJid: task.chat_jid,
        taskId: task.id,
        taskStatus: task.status,
        roundTripCount: task.round_trip_count,
        taskUpdatedAt: task.updated_at,
        intentKind: 'reviewer-turn',
        runId: 'run-queued-turn',
      }),
    ).toBe(true);
    expect(
      getPairedTurnById(`${task.id}:${task.updated_at}:reviewer-turn`),
    ).toMatchObject({
      state: 'queued',
      attempt_no: 0,
      executor_service_id: null,
    });

    expect(
      claimPairedTurnReservation({
        chatJid: task.chat_jid,
        taskId: task.id,
        taskStatus: task.status,
        roundTripCount: task.round_trip_count,
        taskUpdatedAt: task.updated_at,
        intentKind: 'reviewer-turn',
        runId: 'run-running-turn',
      }),
    ).toBe(true);

    expect(
      getPairedTurnById(`${task.id}:${task.updated_at}:reviewer-turn`),
    ).toMatchObject({
      state: 'running',
      attempt_no: 1,
      executor_service_id: normalizeServiceId(SERVICE_ID),
    });
    expect(getPairedTurnsForTask(task.id)).toHaveLength(1);
  });

  it('does not create current-state shadow columns in fresh paired_turns schema', () => {
    const database = new Database(':memory:');

    try {
      initializeDatabaseSchema(database);

      const pairedTurnColumns = database
        .prepare(`PRAGMA table_info(paired_turns)`)
        .all() as Array<{ name: string }>;

      expect(
        pairedTurnColumns.some(
          (column) =>
            column.name === 'state' ||
            column.name === 'attempt_no' ||
            column.name === 'executor_service_id' ||
            column.name === 'executor_agent_type' ||
            column.name === 'completed_at' ||
            column.name === 'last_error',
        ),
      ).toBe(false);
    } finally {
      database.close();
    }
  });

  it('records execution attempt history across delegated failure and retry', () => {
    const task: PairedTask = {
      id: 'task-paired-turn-attempt-history',
      chat_jid: 'group@test',
      group_folder: 'test-group',
      owner_service_id: CLAUDE_SERVICE_ID,
      reviewer_service_id: CODEX_REVIEW_SERVICE_ID,
      owner_agent_type: 'claude-code',
      reviewer_agent_type: 'codex',
      arbiter_agent_type: null,
      title: null,
      source_ref: 'HEAD',
      plan_notes: null,
      review_requested_at: '2026-04-10T00:00:00.000Z',
      round_trip_count: 1,
      status: 'review_ready' as const,
      arbiter_verdict: null,
      arbiter_requested_at: null,
      completion_reason: null,
      created_at: '2026-04-10T00:00:00.000Z',
      updated_at: '2026-04-10T00:00:00.000Z',
    };
    createPairedTask(task);

    expect(
      reservePairedTurnReservation({
        chatJid: task.chat_jid,
        taskId: task.id,
        taskStatus: task.status,
        roundTripCount: task.round_trip_count,
        taskUpdatedAt: task.updated_at,
        intentKind: 'reviewer-turn',
        runId: 'run-attempt-history-queued-1',
      }),
    ).toBe(true);
    expect(
      claimPairedTurnReservation({
        chatJid: task.chat_jid,
        taskId: task.id,
        taskStatus: task.status,
        roundTripCount: task.round_trip_count,
        taskUpdatedAt: task.updated_at,
        intentKind: 'reviewer-turn',
        runId: 'run-attempt-history-running-1',
      }),
    ).toBe(true);

    const handoff = createServiceHandoff({
      chat_jid: task.chat_jid,
      group_folder: task.group_folder,
      paired_task_id: task.id,
      paired_task_updated_at: task.updated_at,
      turn_intent_kind: 'reviewer-turn',
      turn_role: 'reviewer',
      source_service_id: CLAUDE_SERVICE_ID,
      target_service_id: CODEX_REVIEW_SERVICE_ID,
      source_role: 'owner',
      target_role: 'reviewer',
      source_agent_type: 'claude-code',
      target_agent_type: 'codex',
      prompt: 'retry reviewer via delegated handoff',
      intended_role: 'reviewer',
    });

    failServiceHandoff(handoff.id, 'delegated reviewer handoff failed');
    releasePairedTaskExecutionLease({
      taskId: task.id,
      runId: 'run-attempt-history-running-1',
    });

    expect(
      reservePairedTurnReservation({
        chatJid: task.chat_jid,
        taskId: task.id,
        taskStatus: task.status,
        roundTripCount: task.round_trip_count,
        taskUpdatedAt: task.updated_at,
        intentKind: 'reviewer-turn',
        runId: 'run-attempt-history-queued-2',
      }),
    ).toBe(true);
    expect(
      claimPairedTurnReservation({
        chatJid: task.chat_jid,
        taskId: task.id,
        taskStatus: task.status,
        roundTripCount: task.round_trip_count,
        taskUpdatedAt: task.updated_at,
        intentKind: 'reviewer-turn',
        runId: 'run-attempt-history-running-2',
      }),
    ).toBe(true);

    expect(
      getPairedTurnAttempts(`${task.id}:${task.updated_at}:reviewer-turn`),
    ).toMatchObject([
      {
        attempt_no: 1,
        parent_handoff_id: null,
        continuation_handoff_id: handoff.id,
        task_id: task.id,
        task_updated_at: task.updated_at,
        role: 'reviewer',
        intent_kind: 'reviewer-turn',
        state: 'failed',
        executor_service_id: CODEX_REVIEW_SERVICE_ID,
        executor_agent_type: 'codex',
        last_error: 'delegated reviewer handoff failed',
      },
      {
        attempt_no: 2,
        parent_handoff_id: handoff.id,
        task_id: task.id,
        task_updated_at: task.updated_at,
        role: 'reviewer',
        intent_kind: 'reviewer-turn',
        state: 'running',
        executor_service_id: normalizeServiceId(SERVICE_ID),
        executor_agent_type:
          normalizeServiceId(SERVICE_ID) === CLAUDE_SERVICE_ID
            ? 'claude-code'
            : 'codex',
        last_error: null,
      },
    ]);
  });

  it('reopens a completed reservation from the latest failed attempt even when paired_turns state is stale', () => {
    const tempDir = fs.mkdtempSync('/tmp/ejclaw-paired-turn-failed-reopen-');
    const dbPath = path.join(tempDir, 'messages.db');

    try {
      _initTestDatabaseFromFile(dbPath);

      const task: PairedTask = {
        id: 'task-paired-turn-failed-reopen',
        chat_jid: 'group@test',
        group_folder: 'test-group',
        owner_service_id: CLAUDE_SERVICE_ID,
        reviewer_service_id: CODEX_REVIEW_SERVICE_ID,
        owner_agent_type: 'claude-code',
        reviewer_agent_type: 'codex',
        arbiter_agent_type: null,
        title: null,
        source_ref: 'HEAD',
        plan_notes: null,
        review_requested_at: '2026-04-10T00:00:00.000Z',
        round_trip_count: 1,
        status: 'review_ready' as const,
        arbiter_verdict: null,
        arbiter_requested_at: null,
        completion_reason: null,
        created_at: '2026-04-10T00:00:00.000Z',
        updated_at: '2026-04-10T00:00:00.000Z',
      };
      createPairedTask(task);

      expect(
        reservePairedTurnReservation({
          chatJid: task.chat_jid,
          taskId: task.id,
          taskStatus: task.status,
          roundTripCount: task.round_trip_count,
          taskUpdatedAt: task.updated_at,
          intentKind: 'reviewer-turn',
          runId: 'run-failed-reopen-queued-1',
        }),
      ).toBe(true);
      expect(
        claimPairedTurnReservation({
          chatJid: task.chat_jid,
          taskId: task.id,
          taskStatus: task.status,
          roundTripCount: task.round_trip_count,
          taskUpdatedAt: task.updated_at,
          intentKind: 'reviewer-turn',
          runId: 'run-failed-reopen-running-1',
        }),
      ).toBe(true);

      const turnIdentity = buildPairedTurnIdentity({
        taskId: task.id,
        taskUpdatedAt: task.updated_at,
        intentKind: 'reviewer-turn',
        role: 'reviewer',
      });
      failPairedTurn({
        turnIdentity,
        error: 'failed reviewer attempt',
      });
      releasePairedTaskExecutionLease({
        taskId: task.id,
        runId: 'run-failed-reopen-running-1',
      });

      const rawDb = new Database(dbPath);
      rawDb.exec(
        `ALTER TABLE paired_turns ADD COLUMN state TEXT DEFAULT 'queued'`,
      );
      rawDb.exec(`ALTER TABLE paired_turns ADD COLUMN last_error TEXT`);
      rawDb
        .prepare(
          `
            UPDATE paired_turns
               SET state = 'queued',
                   last_error = NULL
             WHERE turn_id = ?
          `,
        )
        .run(turnIdentity.turnId);
      rawDb.close();

      expect(
        reservePairedTurnReservation({
          chatJid: task.chat_jid,
          taskId: task.id,
          taskStatus: task.status,
          roundTripCount: task.round_trip_count,
          taskUpdatedAt: task.updated_at,
          intentKind: 'reviewer-turn',
          runId: 'run-failed-reopen-queued-2',
        }),
      ).toBe(true);
      expect(
        claimPairedTurnReservation({
          chatJid: task.chat_jid,
          taskId: task.id,
          taskStatus: task.status,
          roundTripCount: task.round_trip_count,
          taskUpdatedAt: task.updated_at,
          intentKind: 'reviewer-turn',
          runId: 'run-failed-reopen-running-2',
        }),
      ).toBe(true);

      expect(getPairedTurnById(turnIdentity.turnId)).toMatchObject({
        state: 'running',
        attempt_no: 2,
      });
      expect(getPairedTurnAttempts(turnIdentity.turnId)).toMatchObject([
        {
          attempt_no: 1,
          state: 'failed',
          last_error: 'failed reviewer attempt',
        },
        {
          attempt_no: 2,
          state: 'running',
          active_run_id: 'run-failed-reopen-running-2',
        },
      ]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      _initTestDatabase();
    }
  });

  it('keeps delegated continuation on attempt 1 even when paired_turns attempt_no is stale', () => {
    const tempDir = fs.mkdtempSync(
      '/tmp/ejclaw-paired-turn-attempt-cache-drift-',
    );
    const dbPath = path.join(tempDir, 'messages.db');

    try {
      _initTestDatabaseFromFile(dbPath);

      const task: PairedTask = {
        id: 'task-paired-turn-attempt-cache-drift',
        chat_jid: 'group@test',
        group_folder: 'test-group',
        owner_service_id: CLAUDE_SERVICE_ID,
        reviewer_service_id: CODEX_REVIEW_SERVICE_ID,
        owner_agent_type: 'claude-code',
        reviewer_agent_type: 'codex',
        arbiter_agent_type: null,
        title: null,
        source_ref: 'HEAD',
        plan_notes: null,
        review_requested_at: '2026-04-10T00:00:00.000Z',
        round_trip_count: 1,
        status: 'review_ready' as const,
        arbiter_verdict: null,
        arbiter_requested_at: null,
        completion_reason: null,
        created_at: '2026-04-10T00:00:00.000Z',
        updated_at: '2026-04-10T00:00:00.000Z',
      };
      createPairedTask(task);

      expect(
        reservePairedTurnReservation({
          chatJid: task.chat_jid,
          taskId: task.id,
          taskStatus: task.status,
          roundTripCount: task.round_trip_count,
          taskUpdatedAt: task.updated_at,
          intentKind: 'reviewer-turn',
          runId: 'run-attempt-cache-drift-queued-1',
        }),
      ).toBe(true);
      expect(
        claimPairedTurnReservation({
          chatJid: task.chat_jid,
          taskId: task.id,
          taskStatus: task.status,
          roundTripCount: task.round_trip_count,
          taskUpdatedAt: task.updated_at,
          intentKind: 'reviewer-turn',
          runId: 'run-attempt-cache-drift-running-1',
        }),
      ).toBe(true);

      const turnId = `${task.id}:${task.updated_at}:reviewer-turn`;
      const rawDb = new Database(dbPath);
      rawDb.exec(
        `ALTER TABLE paired_turns ADD COLUMN attempt_no INTEGER NOT NULL DEFAULT 0`,
      );
      rawDb
        .prepare(
          `
            UPDATE paired_turns
               SET attempt_no = 99
             WHERE turn_id = ?
          `,
        )
        .run(turnId);
      rawDb.close();

      const handoff = createServiceHandoff({
        chat_jid: task.chat_jid,
        group_folder: task.group_folder,
        paired_task_id: task.id,
        paired_task_updated_at: task.updated_at,
        turn_intent_kind: 'reviewer-turn',
        turn_role: 'reviewer',
        source_service_id: CLAUDE_SERVICE_ID,
        target_service_id: CODEX_REVIEW_SERVICE_ID,
        source_role: 'owner',
        target_role: 'reviewer',
        source_agent_type: 'claude-code',
        target_agent_type: 'codex',
        prompt: 'delegate reviewer with stale aggregate attempt cache',
        intended_role: 'reviewer',
      });

      expect(handoff.turn_attempt_no).toBe(1);
      expect(getPairedTurnById(turnId)).toMatchObject({
        state: 'delegated',
        attempt_no: 1,
        executor_service_id: CODEX_REVIEW_SERVICE_ID,
      });
      expect(getPairedTurnAttempts(turnId)).toMatchObject([
        {
          attempt_no: 1,
          continuation_handoff_id: handoff.id,
          state: 'delegated',
          executor_service_id: CODEX_REVIEW_SERVICE_ID,
          executor_agent_type: 'codex',
        },
      ]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      _initTestDatabase();
    }
  });

  it('drops legacy next_parent_handoff_id scratch state on re-init and keeps retry lineage on attempt rows', () => {
    const tempDir = fs.mkdtempSync('/tmp/ejclaw-attempt-parent-lineage-');
    const dbPath = path.join(tempDir, 'messages.db');

    _initTestDatabaseFromFile(dbPath);

    const task: PairedTask = {
      id: 'task-attempt-parent-lineage',
      chat_jid: 'group@test',
      group_folder: 'test-group',
      owner_service_id: CLAUDE_SERVICE_ID,
      reviewer_service_id: CODEX_REVIEW_SERVICE_ID,
      owner_agent_type: 'claude-code',
      reviewer_agent_type: 'codex',
      arbiter_agent_type: null,
      title: null,
      source_ref: 'HEAD',
      plan_notes: null,
      review_requested_at: '2026-04-10T00:00:00.000Z',
      round_trip_count: 1,
      status: 'review_ready' as const,
      arbiter_verdict: null,
      arbiter_requested_at: null,
      completion_reason: null,
      created_at: '2026-04-10T00:00:00.000Z',
      updated_at: '2026-04-10T00:00:00.000Z',
    };
    createPairedTask(task);

    expect(
      reservePairedTurnReservation({
        chatJid: task.chat_jid,
        taskId: task.id,
        taskStatus: task.status,
        roundTripCount: task.round_trip_count,
        taskUpdatedAt: task.updated_at,
        intentKind: 'reviewer-turn',
        runId: 'run-attempt-parent-lineage-queued-1',
      }),
    ).toBe(true);
    expect(
      claimPairedTurnReservation({
        chatJid: task.chat_jid,
        taskId: task.id,
        taskStatus: task.status,
        roundTripCount: task.round_trip_count,
        taskUpdatedAt: task.updated_at,
        intentKind: 'reviewer-turn',
        runId: 'run-attempt-parent-lineage-running-1',
      }),
    ).toBe(true);

    const handoff = createServiceHandoff({
      chat_jid: task.chat_jid,
      group_folder: task.group_folder,
      paired_task_id: task.id,
      paired_task_updated_at: task.updated_at,
      turn_intent_kind: 'reviewer-turn',
      turn_role: 'reviewer',
      source_service_id: CLAUDE_SERVICE_ID,
      target_service_id: CODEX_REVIEW_SERVICE_ID,
      source_role: 'owner',
      target_role: 'reviewer',
      source_agent_type: 'claude-code',
      target_agent_type: 'codex',
      prompt: 'derive retry parent from previous attempt row',
      intended_role: 'reviewer',
    });

    failServiceHandoff(handoff.id, 'delegated reviewer handoff failed');
    releasePairedTaskExecutionLease({
      taskId: task.id,
      runId: 'run-attempt-parent-lineage-running-1',
    });

    const turnId = `${task.id}:${task.updated_at}:reviewer-turn`;
    const rawDb = new Database(dbPath);
    rawDb.exec(
      `ALTER TABLE paired_turns ADD COLUMN next_parent_handoff_id INTEGER`,
    );
    rawDb
      .prepare(
        `
          UPDATE paired_turns
             SET next_parent_handoff_id = ?
           WHERE turn_id = ?
        `,
      )
      .run(handoff.id + 9999, turnId);
    rawDb.close();

    _initTestDatabaseFromFile(dbPath);

    const rebuiltDb = new Database(dbPath);
    const pairedTurnColumns = rebuiltDb
      .prepare(`PRAGMA table_info(paired_turns)`)
      .all() as Array<{ name: string }>;
    rebuiltDb.close();

    expect(
      pairedTurnColumns.some(
        (column) => column.name === 'next_parent_handoff_id',
      ),
    ).toBe(false);

    expect(
      reservePairedTurnReservation({
        chatJid: task.chat_jid,
        taskId: task.id,
        taskStatus: task.status,
        roundTripCount: task.round_trip_count,
        taskUpdatedAt: task.updated_at,
        intentKind: 'reviewer-turn',
        runId: 'run-attempt-parent-lineage-queued-2',
      }),
    ).toBe(true);
    expect(
      claimPairedTurnReservation({
        chatJid: task.chat_jid,
        taskId: task.id,
        taskStatus: task.status,
        roundTripCount: task.round_trip_count,
        taskUpdatedAt: task.updated_at,
        intentKind: 'reviewer-turn',
        runId: 'run-attempt-parent-lineage-running-2',
      }),
    ).toBe(true);

    expect(getPairedTurnAttempts(turnId)).toMatchObject([
      {
        attempt_no: 1,
        continuation_handoff_id: handoff.id,
        state: 'failed',
      },
      {
        attempt_no: 2,
        parent_handoff_id: handoff.id,
        state: 'running',
      },
    ]);
  });

  it('keeps attempt 1 when a delegated handoff continues on the target executor', () => {
    const handoff = createServiceHandoff({
      chat_jid: 'dc:handoff-attempt-continuation',
      group_folder: 'handoff-attempt-continuation',
      paired_task_id: 'task-handoff-attempt-continuation',
      paired_task_updated_at: '2026-04-10T00:00:00.000Z',
      turn_intent_kind: 'reviewer-turn',
      turn_role: 'reviewer',
      source_service_id: CLAUDE_SERVICE_ID,
      target_service_id: CODEX_REVIEW_SERVICE_ID,
      source_role: 'owner',
      target_role: 'reviewer',
      source_agent_type: 'claude-code',
      target_agent_type: 'codex',
      prompt: 'continue delegated reviewer handoff',
      intended_role: 'reviewer',
    });

    expect(handoff.turn_id).toBe(
      'task-handoff-attempt-continuation:2026-04-10T00:00:00.000Z:reviewer-turn',
    );

    markPairedTurnRunning({
      turnIdentity: {
        turnId: handoff.turn_id!,
        taskId: 'task-handoff-attempt-continuation',
        taskUpdatedAt: '2026-04-10T00:00:00.000Z',
        intentKind: 'reviewer-turn',
        role: 'reviewer',
      },
      executorServiceId: CODEX_REVIEW_SERVICE_ID,
      executorAgentType: 'codex',
      runId: 'run-handoff-continuation-1',
    });

    expect(getPairedTurnById(handoff.turn_id!)).toMatchObject({
      state: 'running',
      attempt_no: 1,
      executor_service_id: CODEX_REVIEW_SERVICE_ID,
      executor_agent_type: 'codex',
    });
    expect(getPairedTurnAttempts(handoff.turn_id!)).toMatchObject([
      {
        attempt_no: 1,
        parent_handoff_id: null,
        continuation_handoff_id: handoff.id,
        task_id: 'task-handoff-attempt-continuation',
        task_updated_at: '2026-04-10T00:00:00.000Z',
        role: 'reviewer',
        intent_kind: 'reviewer-turn',
        state: 'running',
        executor_service_id: CODEX_REVIEW_SERVICE_ID,
        executor_agent_type: 'codex',
        active_run_id: 'run-handoff-continuation-1',
        last_error: null,
      },
    ]);
  });

  it('drops legacy paired_turn active_run_id scratch state on re-init and keeps same-run continuation on attempt rows', () => {
    const tempDir = fs.mkdtempSync('/tmp/ejclaw-current-run-write-drift-');
    const dbPath = path.join(tempDir, 'messages.db');

    const turnIdentity = buildPairedTurnIdentity({
      taskId: 'task-current-run-drift',
      taskUpdatedAt: '2026-04-10T00:00:00.000Z',
      intentKind: 'reviewer-turn',
      role: 'reviewer',
    });

    try {
      _initTestDatabaseFromFile(dbPath);

      markPairedTurnRunning({
        turnIdentity,
        executorServiceId: CODEX_REVIEW_SERVICE_ID,
        executorAgentType: 'codex',
        runId: 'run-current-run-drift-1',
      });

      const rawDb = new Database(dbPath);
      rawDb.exec(`
        DROP TRIGGER IF EXISTS paired_turn_attempts_validate_insert;
        DROP TRIGGER IF EXISTS paired_turn_attempts_validate_update;
      `);
      rawDb.exec(`ALTER TABLE paired_turns ADD COLUMN active_run_id TEXT`);
      rawDb
        .prepare(
          `
            UPDATE paired_turns
               SET active_run_id = ?
             WHERE turn_id = ?
          `,
        )
        .run('stale-run-id', turnIdentity.turnId);
      rawDb.close();

      _initTestDatabaseFromFile(dbPath);

      const rebuiltDb = new Database(dbPath);
      const pairedTurnColumns = rebuiltDb
        .prepare(`PRAGMA table_info(paired_turns)`)
        .all() as Array<{ name: string }>;
      rebuiltDb.close();

      expect(
        pairedTurnColumns.some((column) => column.name === 'active_run_id'),
      ).toBe(false);

      markPairedTurnRunning({
        turnIdentity,
        executorServiceId: CODEX_REVIEW_SERVICE_ID,
        executorAgentType: 'codex',
        runId: 'run-current-run-drift-1',
      });

      expect(getPairedTurnById(turnIdentity.turnId)).toMatchObject({
        state: 'running',
        attempt_no: 1,
      });
      expect(getPairedTurnAttempts(turnIdentity.turnId)).toMatchObject([
        {
          attempt_no: 1,
          state: 'running',
          executor_service_id: CODEX_REVIEW_SERVICE_ID,
          executor_agent_type: 'codex',
          active_run_id: 'run-current-run-drift-1',
        },
      ]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      _initTestDatabase();
    }
  });

  it('backfills running attempt active_run_id from lease provenance before legacy paired_turn scratch on re-init', () => {
    const tempDir = fs.mkdtempSync('/tmp/ejclaw-current-run-lease-backfill-');
    const dbPath = path.join(tempDir, 'messages.db');

    const turnIdentity = buildPairedTurnIdentity({
      taskId: 'task-current-run-lease-backfill',
      taskUpdatedAt: '2026-04-10T00:00:00.000Z',
      intentKind: 'reviewer-turn',
      role: 'reviewer',
    });

    try {
      _initTestDatabaseFromFile(dbPath);

      markPairedTurnRunning({
        turnIdentity,
        executorServiceId: CODEX_REVIEW_SERVICE_ID,
        executorAgentType: 'codex',
        runId: 'run-correct',
      });

      const rawDb = new Database(dbPath);
      rawDb.exec(`
        DROP TRIGGER IF EXISTS paired_turn_attempts_validate_insert;
        DROP TRIGGER IF EXISTS paired_turn_attempts_validate_update;
      `);
      rawDb.exec(`ALTER TABLE paired_turns ADD COLUMN active_run_id TEXT`);
      rawDb
        .prepare(
          `
            UPDATE paired_turn_attempts
               SET active_run_id = NULL
             WHERE turn_id = ?
               AND attempt_no = 1
          `,
        )
        .run(turnIdentity.turnId);
      rawDb
        .prepare(
          `
            UPDATE paired_turns
               SET active_run_id = ?
             WHERE turn_id = ?
          `,
        )
        .run('run-stale', turnIdentity.turnId);
      rawDb
        .prepare(
          `
            INSERT OR REPLACE INTO paired_task_execution_leases (
              task_id,
              chat_jid,
              role,
              turn_id,
              turn_attempt_id,
              turn_attempt_no,
              intent_kind,
              claimed_run_id,
              claimed_service_id,
              task_status,
              task_updated_at,
              claimed_at,
              updated_at,
              expires_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          turnIdentity.taskId,
          'dc:current-run-lease-backfill',
          'reviewer',
          turnIdentity.turnId,
          buildPairedTurnAttemptId(turnIdentity.turnId, 1),
          1,
          turnIdentity.intentKind,
          'run-correct',
          CODEX_REVIEW_SERVICE_ID,
          'review_ready',
          turnIdentity.taskUpdatedAt,
          '2026-04-10T00:00:05.000Z',
          '2026-04-10T00:00:10.000Z',
          '2026-04-10T01:00:00.000Z',
        );
      rawDb.close();

      _initTestDatabaseFromFile(dbPath);

      expect(getPairedTurnAttempts(turnIdentity.turnId)).toMatchObject([
        {
          attempt_no: 1,
          state: 'running',
          executor_service_id: CODEX_REVIEW_SERVICE_ID,
          executor_agent_type: 'codex',
          active_run_id: 'run-correct',
        },
      ]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      _initTestDatabase();
    }
  });

  it('keeps attempt 1 when same-run continuation follows lease-backed active_run_id after re-init', () => {
    const tempDir = fs.mkdtempSync(
      '/tmp/ejclaw-current-run-lease-continuation-',
    );
    const dbPath = path.join(tempDir, 'messages.db');

    const turnIdentity = buildPairedTurnIdentity({
      taskId: 'task-current-run-lease-continuation',
      taskUpdatedAt: '2026-04-10T00:00:00.000Z',
      intentKind: 'reviewer-turn',
      role: 'reviewer',
    });

    try {
      _initTestDatabaseFromFile(dbPath);

      markPairedTurnRunning({
        turnIdentity,
        executorServiceId: CODEX_REVIEW_SERVICE_ID,
        executorAgentType: 'codex',
        runId: 'run-correct',
      });

      const rawDb = new Database(dbPath);
      rawDb.exec(`
        DROP TRIGGER IF EXISTS paired_turn_attempts_validate_insert;
        DROP TRIGGER IF EXISTS paired_turn_attempts_validate_update;
      `);
      rawDb.exec(`ALTER TABLE paired_turns ADD COLUMN active_run_id TEXT`);
      rawDb
        .prepare(
          `
            UPDATE paired_turn_attempts
               SET active_run_id = NULL
             WHERE turn_id = ?
               AND attempt_no = 1
          `,
        )
        .run(turnIdentity.turnId);
      rawDb
        .prepare(
          `
            UPDATE paired_turns
               SET active_run_id = ?
             WHERE turn_id = ?
          `,
        )
        .run('run-stale', turnIdentity.turnId);
      rawDb
        .prepare(
          `
            INSERT OR REPLACE INTO paired_task_execution_leases (
              task_id,
              chat_jid,
              role,
              turn_id,
              turn_attempt_id,
              turn_attempt_no,
              intent_kind,
              claimed_run_id,
              claimed_service_id,
              task_status,
              task_updated_at,
              claimed_at,
              updated_at,
              expires_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          turnIdentity.taskId,
          'dc:current-run-lease-continuation',
          'reviewer',
          turnIdentity.turnId,
          buildPairedTurnAttemptId(turnIdentity.turnId, 1),
          1,
          turnIdentity.intentKind,
          'run-correct',
          CODEX_REVIEW_SERVICE_ID,
          'review_ready',
          turnIdentity.taskUpdatedAt,
          '2026-04-10T00:00:05.000Z',
          '2026-04-10T00:00:10.000Z',
          '2026-04-10T01:00:00.000Z',
        );
      rawDb.close();

      _initTestDatabaseFromFile(dbPath);

      markPairedTurnRunning({
        turnIdentity,
        executorServiceId: CODEX_REVIEW_SERVICE_ID,
        executorAgentType: 'codex',
        runId: 'run-correct',
      });

      expect(getPairedTurnById(turnIdentity.turnId)).toMatchObject({
        state: 'running',
        attempt_no: 1,
      });
      expect(getPairedTurnAttempts(turnIdentity.turnId)).toMatchObject([
        {
          attempt_no: 1,
          state: 'running',
          executor_service_id: CODEX_REVIEW_SERVICE_ID,
          executor_agent_type: 'codex',
          active_run_id: 'run-correct',
        },
      ]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      _initTestDatabase();
    }
  });

  it('keeps attempt 1 when paired_turn state drifts away from the current attempt row', () => {
    const tempDir = fs.mkdtempSync('/tmp/ejclaw-current-state-write-drift-');
    const dbPath = path.join(tempDir, 'messages.db');

    const turnIdentity = buildPairedTurnIdentity({
      taskId: 'task-current-state-drift',
      taskUpdatedAt: '2026-04-10T00:00:00.000Z',
      intentKind: 'reviewer-turn',
      role: 'reviewer',
    });

    try {
      _initTestDatabaseFromFile(dbPath);

      markPairedTurnRunning({
        turnIdentity,
        executorServiceId: CODEX_REVIEW_SERVICE_ID,
        executorAgentType: 'codex',
        runId: 'run-current-state-drift-1',
      });

      const rawDb = new Database(dbPath);
      rawDb.exec(
        `ALTER TABLE paired_turns ADD COLUMN state TEXT DEFAULT 'queued'`,
      );
      rawDb
        .prepare(
          `
            UPDATE paired_turns
               SET state = 'queued'
             WHERE turn_id = ?
          `,
        )
        .run(turnIdentity.turnId);
      rawDb.close();

      markPairedTurnRunning({
        turnIdentity,
        executorServiceId: CODEX_REVIEW_SERVICE_ID,
        executorAgentType: 'codex',
        runId: 'run-current-state-drift-1',
      });

      expect(getPairedTurnById(turnIdentity.turnId)).toMatchObject({
        state: 'running',
        attempt_no: 1,
      });
      expect(getPairedTurnAttempts(turnIdentity.turnId)).toMatchObject([
        {
          attempt_no: 1,
          state: 'running',
          executor_service_id: CODEX_REVIEW_SERVICE_ID,
          executor_agent_type: 'codex',
          active_run_id: 'run-current-state-drift-1',
        },
      ]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      _initTestDatabase();
    }
  });

  it('hydrates paired turn reads from the latest attempt row when paired_turn cache is stale', () => {
    const tempDir = fs.mkdtempSync('/tmp/ejclaw-current-state-read-hydration-');
    const dbPath = path.join(tempDir, 'messages.db');

    try {
      _initTestDatabaseFromFile(dbPath);

      const task: PairedTask = {
        id: 'task-current-state-read-hydration',
        chat_jid: 'group@test',
        group_folder: 'test-group',
        owner_service_id: CLAUDE_SERVICE_ID,
        reviewer_service_id: CODEX_REVIEW_SERVICE_ID,
        owner_agent_type: 'claude-code',
        reviewer_agent_type: 'codex',
        arbiter_agent_type: null,
        title: null,
        source_ref: 'HEAD',
        plan_notes: null,
        review_requested_at: '2026-04-10T00:00:00.000Z',
        round_trip_count: 1,
        status: 'review_ready' as const,
        arbiter_verdict: null,
        arbiter_requested_at: null,
        completion_reason: null,
        created_at: '2026-04-10T00:00:00.000Z',
        updated_at: '2026-04-10T00:00:00.000Z',
      };
      createPairedTask(task);

      expect(
        reservePairedTurnReservation({
          chatJid: task.chat_jid,
          taskId: task.id,
          taskStatus: task.status,
          roundTripCount: task.round_trip_count,
          taskUpdatedAt: task.updated_at,
          intentKind: 'reviewer-turn',
          runId: 'run-current-state-read-hydration-queued-1',
        }),
      ).toBe(true);
      expect(
        claimPairedTurnReservation({
          chatJid: task.chat_jid,
          taskId: task.id,
          taskStatus: task.status,
          roundTripCount: task.round_trip_count,
          taskUpdatedAt: task.updated_at,
          intentKind: 'reviewer-turn',
          runId: 'run-current-state-read-hydration-running-1',
        }),
      ).toBe(true);

      const turnIdentity = buildPairedTurnIdentity({
        taskId: task.id,
        taskUpdatedAt: task.updated_at,
        intentKind: 'reviewer-turn',
        role: 'reviewer',
      });
      failPairedTurn({
        turnIdentity,
        error: 'failed reviewer read hydration attempt',
      });

      const rawDb = new Database(dbPath);
      rawDb.exec(
        `ALTER TABLE paired_turns ADD COLUMN state TEXT DEFAULT 'queued'`,
      );
      rawDb.exec(
        `ALTER TABLE paired_turns ADD COLUMN attempt_no INTEGER NOT NULL DEFAULT 0`,
      );
      rawDb.exec(
        `ALTER TABLE paired_turns ADD COLUMN executor_service_id TEXT`,
      );
      rawDb.exec(
        `ALTER TABLE paired_turns ADD COLUMN executor_agent_type TEXT`,
      );
      rawDb.exec(`ALTER TABLE paired_turns ADD COLUMN last_error TEXT`);
      rawDb
        .prepare(
          `
            UPDATE paired_turns
               SET task_id = ?,
                   state = 'queued',
                   attempt_no = 99,
                   executor_service_id = ?,
                   executor_agent_type = ?,
                   last_error = NULL
             WHERE turn_id = ?
          `,
        )
        .run(
          'task-stale-current-state-cache',
          'stale-service',
          'claude-code',
          turnIdentity.turnId,
        );
      rawDb.close();

      expect(getPairedTurnById(turnIdentity.turnId)).toMatchObject({
        turn_id: turnIdentity.turnId,
        task_id: task.id,
        task_updated_at: task.updated_at,
        role: 'reviewer',
        intent_kind: 'reviewer-turn',
        state: 'failed',
        attempt_no: 1,
        executor_service_id: normalizeServiceId(SERVICE_ID),
        last_error: 'failed reviewer read hydration attempt',
      });
      expect(getPairedTurnsForTask(task.id)).toMatchObject([
        {
          turn_id: turnIdentity.turnId,
          task_id: task.id,
          task_updated_at: task.updated_at,
          role: 'reviewer',
          intent_kind: 'reviewer-turn',
          state: 'failed',
          attempt_no: 1,
          executor_service_id: normalizeServiceId(SERVICE_ID),
          last_error: 'failed reviewer read hydration attempt',
        },
      ]);
      expect(getPairedTurnsForTask('task-stale-current-state-cache')).toEqual(
        [],
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      _initTestDatabase();
    }
  });

  it('keeps latest attempt hydration when a paired_turn aggregate current attempt lags the latest attempt row', () => {
    const tempDir = fs.mkdtempSync('/tmp/ejclaw-current-attempt-drift-');
    const dbPath = path.join(tempDir, 'messages.db');

    try {
      _initTestDatabaseFromFile(dbPath);

      const task: PairedTask = {
        id: 'task-current-attempt-drift',
        chat_jid: 'group@test',
        group_folder: 'test-group',
        owner_service_id: CLAUDE_SERVICE_ID,
        reviewer_service_id: CODEX_REVIEW_SERVICE_ID,
        owner_agent_type: 'claude-code',
        reviewer_agent_type: 'codex',
        arbiter_agent_type: null,
        title: null,
        source_ref: 'HEAD',
        plan_notes: null,
        review_requested_at: '2026-04-10T00:00:00.000Z',
        round_trip_count: 1,
        status: 'review_ready' as const,
        arbiter_verdict: null,
        arbiter_requested_at: null,
        completion_reason: null,
        created_at: '2026-04-10T00:00:00.000Z',
        updated_at: '2026-04-10T00:00:00.000Z',
      };
      createPairedTask(task);

      expect(
        reservePairedTurnReservation({
          chatJid: task.chat_jid,
          taskId: task.id,
          taskStatus: task.status,
          roundTripCount: task.round_trip_count,
          taskUpdatedAt: task.updated_at,
          intentKind: 'reviewer-turn',
          runId: 'run-current-attempt-drift-queued-1',
        }),
      ).toBe(true);
      expect(
        claimPairedTurnReservation({
          chatJid: task.chat_jid,
          taskId: task.id,
          taskStatus: task.status,
          roundTripCount: task.round_trip_count,
          taskUpdatedAt: task.updated_at,
          intentKind: 'reviewer-turn',
          runId: 'run-current-attempt-drift-running-1',
        }),
      ).toBe(true);

      const handoff = createServiceHandoff({
        chat_jid: task.chat_jid,
        group_folder: task.group_folder,
        paired_task_id: task.id,
        paired_task_updated_at: task.updated_at,
        turn_intent_kind: 'reviewer-turn',
        turn_role: 'reviewer',
        source_service_id: CLAUDE_SERVICE_ID,
        target_service_id: CODEX_REVIEW_SERVICE_ID,
        source_role: 'owner',
        target_role: 'reviewer',
        source_agent_type: 'claude-code',
        target_agent_type: 'codex',
        prompt: 'drift latest attempt row away from aggregate',
        intended_role: 'reviewer',
      });

      failServiceHandoff(handoff.id, 'delegated reviewer handoff failed');
      releasePairedTaskExecutionLease({
        taskId: task.id,
        runId: 'run-current-attempt-drift-running-1',
      });

      expect(
        reservePairedTurnReservation({
          chatJid: task.chat_jid,
          taskId: task.id,
          taskStatus: task.status,
          roundTripCount: task.round_trip_count,
          taskUpdatedAt: task.updated_at,
          intentKind: 'reviewer-turn',
          runId: 'run-current-attempt-drift-queued-2',
        }),
      ).toBe(true);
      expect(
        claimPairedTurnReservation({
          chatJid: task.chat_jid,
          taskId: task.id,
          taskStatus: task.status,
          roundTripCount: task.round_trip_count,
          taskUpdatedAt: task.updated_at,
          intentKind: 'reviewer-turn',
          runId: 'run-current-attempt-drift-running-2',
        }),
      ).toBe(true);

      const turnId = `${task.id}:${task.updated_at}:reviewer-turn`;
      const rawDb = new Database(dbPath);
      rawDb.exec(
        `ALTER TABLE paired_turns ADD COLUMN attempt_no INTEGER NOT NULL DEFAULT 0`,
      );
      rawDb
        .prepare(
          `
            UPDATE paired_turns
               SET attempt_no = 1
             WHERE turn_id = ?
          `,
        )
        .run(turnId);
      rawDb.close();

      _initTestDatabaseFromFile(dbPath);

      expect(getPairedTurnById(turnId)).toMatchObject({
        turn_id: turnId,
        task_id: task.id,
        task_updated_at: task.updated_at,
        role: 'reviewer',
        intent_kind: 'reviewer-turn',
        state: 'running',
        attempt_no: 2,
      });
      expect(getPairedTurnAttempts(turnId)).toMatchObject([
        {
          attempt_no: 1,
          state: 'failed',
          continuation_handoff_id: handoff.id,
        },
        {
          attempt_no: 2,
          state: 'running',
          active_run_id: 'run-current-attempt-drift-running-2',
        },
      ]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      _initTestDatabase();
    }
  });

  it('keeps latest attempt hydration when a paired_turn aggregate state drifts from a running attempt row', () => {
    const tempDir = fs.mkdtempSync('/tmp/ejclaw-current-state-drift-');
    const dbPath = path.join(tempDir, 'messages.db');

    const turnIdentity = buildPairedTurnIdentity({
      taskId: 'task-current-state-drift',
      taskUpdatedAt: '2026-04-10T00:00:00.000Z',
      intentKind: 'reviewer-turn',
      role: 'reviewer',
    });

    try {
      _initTestDatabaseFromFile(dbPath);

      markPairedTurnRunning({
        turnIdentity,
        executorServiceId: CODEX_REVIEW_SERVICE_ID,
        executorAgentType: 'codex',
        runId: 'run-current-state-drift-1',
      });

      const rawDb = new Database(dbPath);
      rawDb.exec(
        `ALTER TABLE paired_turns ADD COLUMN state TEXT DEFAULT 'queued'`,
      );
      rawDb
        .prepare(
          `
            UPDATE paired_turns
               SET state = 'queued'
             WHERE turn_id = ?
          `,
        )
        .run(turnIdentity.turnId);
      rawDb.close();

      _initTestDatabaseFromFile(dbPath);

      expect(getPairedTurnById(turnIdentity.turnId)).toMatchObject({
        turn_id: turnIdentity.turnId,
        task_id: turnIdentity.taskId,
        task_updated_at: turnIdentity.taskUpdatedAt,
        role: 'reviewer',
        intent_kind: 'reviewer-turn',
        state: 'running',
        attempt_no: 1,
        executor_service_id: CODEX_REVIEW_SERVICE_ID,
        executor_agent_type: 'codex',
      });
      expect(getPairedTurnAttempts(turnIdentity.turnId)).toMatchObject([
        {
          attempt_no: 1,
          state: 'running',
          active_run_id: 'run-current-state-drift-1',
        },
      ]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      _initTestDatabase();
    }
  });

  it('fails init when a legacy paired_turn aggregate implies a non-contiguous attempt lineage', () => {
    const tempDir = fs.mkdtempSync(path.join('/tmp', 'ejclaw-paired-attempt-'));
    const dbPath = path.join(tempDir, 'paired-attempts.db');

    try {
      const legacyDb = new Database(dbPath);
      legacyDb.exec(`
        CREATE TABLE paired_turns (
          turn_id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          task_updated_at TEXT NOT NULL,
          role TEXT NOT NULL,
          intent_kind TEXT NOT NULL,
          state TEXT NOT NULL,
          executor_service_id TEXT,
          executor_agent_type TEXT,
          attempt_no INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT,
          last_error TEXT
        );
      `);
      legacyDb
        .prepare(
          `
            INSERT INTO paired_turns (
              turn_id,
              task_id,
              task_updated_at,
              role,
              intent_kind,
              state,
              executor_service_id,
              executor_agent_type,
              attempt_no,
              created_at,
              updated_at,
              completed_at,
              last_error
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          'legacy-task:2026-04-10T00:00:00.000Z:reviewer-turn',
          'legacy-task',
          '2026-04-10T00:00:00.000Z',
          'reviewer',
          'reviewer-turn',
          'failed',
          CODEX_REVIEW_SERVICE_ID,
          'codex',
          2,
          '2026-04-10T00:00:00.000Z',
          '2026-04-10T01:00:00.000Z',
          '2026-04-10T01:00:00.000Z',
          'legacy attempt failure',
        );
      legacyDb.close();

      expect(() => _initTestDatabaseFromFile(dbPath)).toThrow(
        /must preserve contiguous parent lineage/,
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      _initTestDatabase();
    }
  });

  it('records parent_attempt_id when a retry creates a new attempt', () => {
    const turnIdentity = buildPairedTurnIdentity({
      taskId: 'parent-attempt-task',
      taskUpdatedAt: '2026-04-10T00:00:00.000Z',
      intentKind: 'reviewer-turn',
      role: 'reviewer',
    });

    markPairedTurnRunning({
      turnIdentity,
      executorServiceId: CODEX_REVIEW_SERVICE_ID,
      runId: 'run-1',
    });
    failPairedTurn({
      turnIdentity,
      error: 'attempt 1 failed',
    });
    markPairedTurnRunning({
      turnIdentity,
      executorServiceId: CODEX_REVIEW_SERVICE_ID,
      runId: 'run-2',
    });

    expect(getPairedTurnAttempts(turnIdentity.turnId)).toEqual([
      expect.objectContaining({
        attempt_id: buildPairedTurnAttemptId(turnIdentity.turnId, 1),
        parent_attempt_id: null,
        attempt_no: 1,
        state: 'failed',
      }),
      expect.objectContaining({
        attempt_id: buildPairedTurnAttemptId(turnIdentity.turnId, 2),
        parent_attempt_id: buildPairedTurnAttemptParentId(
          turnIdentity.turnId,
          2,
        ),
        attempt_no: 2,
        state: 'running',
      }),
    ]);
  });

  it('backfills parent_attempt_id for legacy multi-attempt rows during init', () => {
    const tempDir = fs.mkdtempSync(
      path.join('/tmp', 'ejclaw-parent-attempt-backfill-'),
    );
    const dbPath = path.join(tempDir, 'parent-attempt-backfill.db');
    const turnId =
      'legacy-parent-attempt:2026-04-10T00:00:00.000Z:reviewer-turn';

    try {
      const legacyDb = new Database(dbPath);
      legacyDb.exec(`
        CREATE TABLE paired_turns (
          turn_id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          task_updated_at TEXT NOT NULL,
          role TEXT NOT NULL,
          intent_kind TEXT NOT NULL,
          state TEXT NOT NULL,
          executor_service_id TEXT,
          executor_agent_type TEXT,
          active_run_id TEXT,
          attempt_no INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT,
          last_error TEXT
        );
        CREATE TABLE paired_turn_attempts (
          turn_id TEXT NOT NULL,
          attempt_no INTEGER NOT NULL,
          task_id TEXT NOT NULL,
          task_updated_at TEXT NOT NULL,
          role TEXT NOT NULL,
          intent_kind TEXT NOT NULL,
          state TEXT NOT NULL,
          executor_service_id TEXT,
          executor_agent_type TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT,
          last_error TEXT,
          PRIMARY KEY (turn_id, attempt_no)
        );
      `);
      legacyDb
        .prepare(
          `
            INSERT INTO paired_turns (
              turn_id,
              task_id,
              task_updated_at,
              role,
              intent_kind,
              state,
              executor_service_id,
              executor_agent_type,
              attempt_no,
              created_at,
              updated_at,
              completed_at,
              last_error
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          turnId,
          'legacy-parent-attempt',
          '2026-04-10T00:00:00.000Z',
          'reviewer',
          'reviewer-turn',
          'failed',
          CODEX_REVIEW_SERVICE_ID,
          'codex',
          2,
          '2026-04-10T00:01:00.000Z',
          '2026-04-10T00:02:40.000Z',
          '2026-04-10T00:02:40.000Z',
          'attempt 2 failed',
        );
      const insertAttempt = legacyDb.prepare(
        `
          INSERT INTO paired_turn_attempts (
            turn_id,
            attempt_no,
            task_id,
            task_updated_at,
            role,
            intent_kind,
            state,
            executor_service_id,
            executor_agent_type,
            created_at,
            updated_at,
            completed_at,
            last_error
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      );
      insertAttempt.run(
        turnId,
        1,
        'legacy-parent-attempt',
        '2026-04-10T00:00:00.000Z',
        'reviewer',
        'reviewer-turn',
        'delegated',
        CODEX_REVIEW_SERVICE_ID,
        'codex',
        '2026-04-10T00:01:00.000Z',
        '2026-04-10T00:01:50.000Z',
        '2026-04-10T00:01:50.000Z',
        'attempt 1 delegated',
      );
      insertAttempt.run(
        turnId,
        2,
        'legacy-parent-attempt',
        '2026-04-10T00:00:00.000Z',
        'reviewer',
        'reviewer-turn',
        'failed',
        CODEX_REVIEW_SERVICE_ID,
        'codex',
        '2026-04-10T00:02:00.000Z',
        '2026-04-10T00:02:40.000Z',
        '2026-04-10T00:02:40.000Z',
        'attempt 2 failed',
      );
      legacyDb.close();

      _initTestDatabaseFromFile(dbPath);

      const rawDb = new Database(dbPath, { readonly: true });
      expect(
        rawDb
          .prepare(
            `
              SELECT attempt_no, attempt_id, parent_attempt_id
                FROM paired_turn_attempts
               WHERE turn_id = ?
               ORDER BY attempt_no ASC
            `,
          )
          .all(turnId),
      ).toEqual([
        {
          attempt_no: 1,
          attempt_id: buildPairedTurnAttemptId(turnId, 1),
          parent_attempt_id: null,
        },
        {
          attempt_no: 2,
          attempt_id: buildPairedTurnAttemptId(turnId, 2),
          parent_attempt_id: buildPairedTurnAttemptParentId(turnId, 2),
        },
      ]);
      rawDb.close();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      _initTestDatabase();
    }
  });

  it('fails init when legacy attempt lineage skips the previous attempt', () => {
    const tempDir = fs.mkdtempSync(
      path.join('/tmp', 'ejclaw-parent-attempt-gap-'),
    );
    const dbPath = path.join(tempDir, 'parent-attempt-gap.db');
    const turnId = 'legacy-parent-gap:2026-04-10T00:00:00.000Z:reviewer-turn';

    try {
      const legacyDb = new Database(dbPath);
      legacyDb.exec(`
        CREATE TABLE paired_turns (
          turn_id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          task_updated_at TEXT NOT NULL,
          role TEXT NOT NULL,
          intent_kind TEXT NOT NULL,
          state TEXT NOT NULL,
          executor_service_id TEXT,
          executor_agent_type TEXT,
          active_run_id TEXT,
          attempt_no INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT,
          last_error TEXT
        );
        CREATE TABLE paired_turn_attempts (
          turn_id TEXT NOT NULL,
          attempt_no INTEGER NOT NULL,
          task_id TEXT NOT NULL,
          task_updated_at TEXT NOT NULL,
          role TEXT NOT NULL,
          intent_kind TEXT NOT NULL,
          state TEXT NOT NULL,
          executor_service_id TEXT,
          executor_agent_type TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT,
          last_error TEXT,
          PRIMARY KEY (turn_id, attempt_no)
        );
      `);
      legacyDb
        .prepare(
          `
            INSERT INTO paired_turns (
              turn_id,
              task_id,
              task_updated_at,
              role,
              intent_kind,
              state,
              executor_service_id,
              executor_agent_type,
              attempt_no,
              created_at,
              updated_at,
              completed_at,
              last_error
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          turnId,
          'legacy-parent-gap',
          '2026-04-10T00:00:00.000Z',
          'reviewer',
          'reviewer-turn',
          'failed',
          CODEX_REVIEW_SERVICE_ID,
          'codex',
          3,
          '2026-04-10T00:00:00.000Z',
          '2026-04-10T00:03:00.000Z',
          '2026-04-10T00:03:00.000Z',
          'attempt 3 failed',
        );
      const insertAttempt = legacyDb.prepare(
        `
          INSERT INTO paired_turn_attempts (
            turn_id,
            attempt_no,
            task_id,
            task_updated_at,
            role,
            intent_kind,
            state,
            executor_service_id,
            executor_agent_type,
            created_at,
            updated_at,
            completed_at,
            last_error
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      );
      insertAttempt.run(
        turnId,
        1,
        'legacy-parent-gap',
        '2026-04-10T00:00:00.000Z',
        'reviewer',
        'reviewer-turn',
        'delegated',
        CODEX_REVIEW_SERVICE_ID,
        'codex',
        '2026-04-10T00:01:00.000Z',
        '2026-04-10T00:01:30.000Z',
        '2026-04-10T00:01:30.000Z',
        'attempt 1 delegated',
      );
      insertAttempt.run(
        turnId,
        3,
        'legacy-parent-gap',
        '2026-04-10T00:00:00.000Z',
        'reviewer',
        'reviewer-turn',
        'failed',
        CODEX_REVIEW_SERVICE_ID,
        'codex',
        '2026-04-10T00:03:00.000Z',
        '2026-04-10T00:03:20.000Z',
        '2026-04-10T00:03:20.000Z',
        'attempt 3 failed',
      );
      legacyDb.close();

      expect(() => _initTestDatabaseFromFile(dbPath)).toThrow(
        /invalid parent_attempt_id provenance/,
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      _initTestDatabase();
    }
  });

  it('backfills turn attempt provenance onto legacy reservations, leases, and handoffs during init', () => {
    const tempDir = fs.mkdtempSync(
      path.join('/tmp', 'ejclaw-turn-attempt-provenance-'),
    );
    const dbPath = path.join(tempDir, 'turn-attempt-provenance.db');

    try {
      const legacyDb = new Database(dbPath);
      legacyDb.exec(`
        CREATE TABLE paired_turns (
          turn_id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          task_updated_at TEXT NOT NULL,
          role TEXT NOT NULL,
          intent_kind TEXT NOT NULL,
          state TEXT NOT NULL,
          executor_service_id TEXT,
          executor_agent_type TEXT,
          attempt_no INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT,
          last_error TEXT
        );
        CREATE TABLE paired_turn_attempts (
          turn_id TEXT NOT NULL,
          attempt_no INTEGER NOT NULL,
          task_id TEXT NOT NULL,
          task_updated_at TEXT NOT NULL,
          role TEXT NOT NULL,
          intent_kind TEXT NOT NULL,
          state TEXT NOT NULL,
          executor_service_id TEXT,
          executor_agent_type TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT,
          last_error TEXT,
          PRIMARY KEY (turn_id, attempt_no)
        );
        CREATE TABLE paired_turn_reservations (
          chat_jid TEXT NOT NULL,
          task_id TEXT NOT NULL,
          task_status TEXT NOT NULL,
          round_trip_count INTEGER NOT NULL DEFAULT 0,
          task_updated_at TEXT NOT NULL,
          turn_id TEXT NOT NULL,
          turn_role TEXT NOT NULL,
          intent_kind TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          scheduled_run_id TEXT,
          consumed_run_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          consumed_at TEXT,
          PRIMARY KEY (chat_jid, task_id, task_updated_at, intent_kind)
        );
        CREATE TABLE paired_task_execution_leases (
          task_id TEXT PRIMARY KEY,
          chat_jid TEXT NOT NULL,
          role TEXT NOT NULL,
          turn_id TEXT NOT NULL,
          intent_kind TEXT NOT NULL,
          claimed_run_id TEXT NOT NULL,
          claimed_service_id TEXT NOT NULL,
          task_status TEXT NOT NULL,
          task_updated_at TEXT NOT NULL,
          claimed_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          expires_at TEXT NOT NULL
        );
        CREATE TABLE service_handoffs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          chat_jid TEXT NOT NULL,
          group_folder TEXT NOT NULL,
          source_service_id TEXT NOT NULL,
          target_service_id TEXT NOT NULL,
          paired_task_id TEXT,
          paired_task_updated_at TEXT,
          turn_id TEXT,
          turn_intent_kind TEXT,
          turn_role TEXT,
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
          `
            INSERT INTO paired_turns (
              turn_id,
              task_id,
              task_updated_at,
              role,
              intent_kind,
              state,
              executor_service_id,
              executor_agent_type,
              attempt_no,
              created_at,
              updated_at,
              completed_at,
              last_error
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          'legacy-provenance-task:2026-04-10T00:00:00.000Z:reviewer-turn',
          'legacy-provenance-task',
          '2026-04-10T00:00:00.000Z',
          'reviewer',
          'reviewer-turn',
          'running',
          'other-service',
          'codex',
          2,
          '2026-04-10T00:00:00.000Z',
          '2026-04-10T01:00:00.000Z',
          null,
          null,
        );
      const insertAttempt = legacyDb.prepare(
        `
          INSERT INTO paired_turn_attempts (
            turn_id,
            attempt_no,
            task_id,
            task_updated_at,
            role,
            intent_kind,
            state,
            executor_service_id,
            executor_agent_type,
            created_at,
            updated_at,
            completed_at,
            last_error
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      );
      insertAttempt.run(
        'legacy-provenance-task:2026-04-10T00:00:00.000Z:reviewer-turn',
        1,
        'legacy-provenance-task',
        '2026-04-10T00:00:00.000Z',
        'reviewer',
        'reviewer-turn',
        'delegated',
        'other-service',
        'codex',
        '2026-04-10T00:00:00.000Z',
        '2026-04-10T00:30:00.000Z',
        '2026-04-10T00:30:00.000Z',
        'legacy attempt 1 delegated',
      );
      insertAttempt.run(
        'legacy-provenance-task:2026-04-10T00:00:00.000Z:reviewer-turn',
        2,
        'legacy-provenance-task',
        '2026-04-10T00:00:00.000Z',
        'reviewer',
        'reviewer-turn',
        'running',
        'other-service',
        'codex',
        '2026-04-10T00:40:00.000Z',
        '2026-04-10T01:00:00.000Z',
        null,
        null,
      );
      legacyDb
        .prepare(
          `
            INSERT INTO paired_turn_reservations (
              chat_jid,
              task_id,
              task_status,
              round_trip_count,
              task_updated_at,
              turn_id,
              turn_role,
              intent_kind,
              status,
              scheduled_run_id,
              consumed_run_id,
              created_at,
              updated_at,
              consumed_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          'group@test',
          'legacy-provenance-task',
          'review_ready',
          1,
          '2026-04-10T00:00:00.000Z',
          'legacy-provenance-task:2026-04-10T00:00:00.000Z:reviewer-turn',
          'reviewer',
          'reviewer-turn',
          'completed',
          'run-scheduled',
          'run-consumed',
          '2026-04-10T00:00:00.000Z',
          '2026-04-10T01:00:00.000Z',
          '2026-04-10T01:00:00.000Z',
        );
      legacyDb
        .prepare(
          `
            INSERT INTO paired_task_execution_leases (
              task_id,
              chat_jid,
              role,
              turn_id,
              intent_kind,
              claimed_run_id,
              claimed_service_id,
              task_status,
              task_updated_at,
              claimed_at,
              updated_at,
              expires_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          'legacy-provenance-task',
          'group@test',
          'reviewer',
          'legacy-provenance-task:2026-04-10T00:00:00.000Z:reviewer-turn',
          'reviewer-turn',
          'run-active',
          'other-service',
          'review_ready',
          '2026-04-10T00:00:00.000Z',
          '2026-04-10T00:00:00.000Z',
          '2026-04-10T01:00:00.000Z',
          '2099-04-10T01:10:00.000Z',
        );
      legacyDb
        .prepare(
          `
            INSERT INTO service_handoffs (
              chat_jid,
              group_folder,
              source_service_id,
              target_service_id,
              paired_task_id,
              paired_task_updated_at,
              turn_id,
              turn_intent_kind,
              turn_role,
              source_role,
              source_agent_type,
              target_role,
              target_agent_type,
              prompt,
              status,
              intended_role,
              created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          'group@test',
          'test-group',
          CLAUDE_SERVICE_ID,
          CODEX_REVIEW_SERVICE_ID,
          'legacy-provenance-task',
          '2026-04-10T00:00:00.000Z',
          'legacy-provenance-task:2026-04-10T00:00:00.000Z:reviewer-turn',
          'reviewer-turn',
          'reviewer',
          'owner',
          'claude-code',
          'reviewer',
          'codex',
          'legacy provenance handoff',
          'pending',
          'reviewer',
          '2026-04-10T00:50:00.000Z',
        );
      legacyDb.close();

      _initTestDatabaseFromFile(dbPath);

      const rawDb = new Database(dbPath, { readonly: true });
      expect(
        rawDb
          .prepare(
            `SELECT turn_attempt_no
               FROM paired_turn_reservations
              WHERE turn_id = ?`,
          )
          .get('legacy-provenance-task:2026-04-10T00:00:00.000Z:reviewer-turn'),
      ).toEqual({ turn_attempt_no: 2 });
      expect(
        rawDb
          .prepare(
            `SELECT turn_attempt_no
               FROM paired_task_execution_leases
              WHERE turn_id = ?`,
          )
          .get('legacy-provenance-task:2026-04-10T00:00:00.000Z:reviewer-turn'),
      ).toEqual({ turn_attempt_no: 2 });
      expect(
        rawDb
          .prepare(
            `SELECT turn_attempt_no
               FROM service_handoffs
              WHERE turn_id = ?`,
          )
          .get('legacy-provenance-task:2026-04-10T00:00:00.000Z:reviewer-turn'),
      ).toEqual({ turn_attempt_no: 2 });
      rawDb.close();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      _initTestDatabase();
    }
  });

  it('preserves per-row attempt provenance when backfilling a multi-attempt legacy turn', () => {
    const tempDir = fs.mkdtempSync(
      path.join('/tmp', 'ejclaw-turn-attempt-provenance-multi-'),
    );
    const dbPath = path.join(tempDir, 'turn-attempt-provenance-multi.db');
    const turnId =
      'legacy-multi-provenance:2026-04-10T00:00:00.000Z:reviewer-turn';

    try {
      const legacyDb = new Database(dbPath);
      initializeDatabaseSchema(legacyDb);

      insertPairedTurnIdentityRow(legacyDb, {
        turnId,
        taskId: 'legacy-multi-provenance',
        taskUpdatedAt: '2026-04-10T00:00:00.000Z',
        role: 'reviewer',
        intentKind: 'reviewer-turn',
        createdAt: '2026-04-10T00:01:00.000Z',
        updatedAt: '2026-04-10T00:02:40.000Z',
      });

      const insertAttempt = legacyDb.prepare(
        `
          INSERT INTO paired_turn_attempts (
            attempt_id,
            parent_attempt_id,
            turn_id,
            attempt_no,
            task_id,
            task_updated_at,
            role,
            intent_kind,
            state,
            executor_service_id,
            executor_agent_type,
            created_at,
            updated_at,
            completed_at,
            last_error
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      );
      insertAttempt.run(
        buildPairedTurnAttemptId(turnId, 1),
        null,
        turnId,
        1,
        'legacy-multi-provenance',
        '2026-04-10T00:00:00.000Z',
        'reviewer',
        'reviewer-turn',
        'delegated',
        CODEX_REVIEW_SERVICE_ID,
        'codex',
        '2026-04-10T00:01:00.000Z',
        '2026-04-10T00:01:50.000Z',
        '2026-04-10T00:01:50.000Z',
        'attempt 1 delegated',
      );
      insertAttempt.run(
        buildPairedTurnAttemptId(turnId, 2),
        buildPairedTurnAttemptParentId(turnId, 2),
        turnId,
        2,
        'legacy-multi-provenance',
        '2026-04-10T00:00:00.000Z',
        'reviewer',
        'reviewer-turn',
        'failed',
        CODEX_REVIEW_SERVICE_ID,
        'codex',
        '2026-04-10T00:02:00.000Z',
        '2026-04-10T00:02:40.000Z',
        '2026-04-10T00:02:40.000Z',
        'attempt 2 failed',
      );

      legacyDb
        .prepare(
          `
            INSERT INTO paired_turn_reservations (
              chat_jid,
              task_id,
              task_status,
              round_trip_count,
              task_updated_at,
              turn_id,
              turn_attempt_no,
              turn_role,
              intent_kind,
              status,
              scheduled_run_id,
              consumed_run_id,
              created_at,
              updated_at,
              consumed_at
            )
            VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          'group@test',
          'legacy-multi-provenance',
          'review_ready',
          1,
          '2026-04-10T00:00:00.000Z',
          turnId,
          'reviewer',
          'reviewer-turn',
          'completed',
          'run-scheduled-1',
          'run-consumed-1',
          '2026-04-10T00:00:30.000Z',
          '2026-04-10T00:01:10.000Z',
          '2026-04-10T00:01:10.000Z',
        );

      legacyDb
        .prepare(
          `
            INSERT INTO paired_task_execution_leases (
              task_id,
              chat_jid,
              role,
              turn_id,
              turn_attempt_no,
              intent_kind,
              claimed_run_id,
              claimed_service_id,
              task_status,
              task_updated_at,
              claimed_at,
              updated_at,
              expires_at
            )
            VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          'legacy-multi-provenance',
          'group@test',
          'reviewer',
          turnId,
          'reviewer-turn',
          'run-active-1',
          CODEX_REVIEW_SERVICE_ID,
          'review_ready',
          '2026-04-10T00:00:00.000Z',
          '2026-04-10T00:01:15.000Z',
          '2026-04-10T00:01:20.000Z',
          '2099-04-10T00:11:20.000Z',
        );

      const insertHandoff = legacyDb.prepare(
        `
          INSERT INTO service_handoffs (
            chat_jid,
            group_folder,
            paired_task_id,
            paired_task_updated_at,
            turn_id,
            turn_attempt_no,
            turn_intent_kind,
            turn_role,
            source_service_id,
            target_service_id,
            source_role,
            source_agent_type,
            target_role,
            target_agent_type,
            prompt,
            status,
            intended_role,
            created_at,
            claimed_at,
            completed_at,
            last_error
          )
          VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      );
      insertHandoff.run(
        'group@test',
        'test-group',
        'legacy-multi-provenance',
        '2026-04-10T00:00:00.000Z',
        turnId,
        'reviewer-turn',
        'reviewer',
        CLAUDE_SERVICE_ID,
        CODEX_REVIEW_SERVICE_ID,
        'owner',
        'claude-code',
        'reviewer',
        'codex',
        'legacy handoff attempt 1',
        'failed',
        'reviewer',
        '2026-04-10T00:01:30.000Z',
        '2026-04-10T00:01:35.000Z',
        '2026-04-10T00:01:50.000Z',
        'attempt 1 failed',
      );
      insertHandoff.run(
        'group@test',
        'test-group',
        'legacy-multi-provenance',
        '2026-04-10T00:00:00.000Z',
        turnId,
        'reviewer-turn',
        'reviewer',
        CLAUDE_SERVICE_ID,
        CODEX_REVIEW_SERVICE_ID,
        'owner',
        'claude-code',
        'reviewer',
        'codex',
        'legacy handoff attempt 2',
        'pending',
        'reviewer',
        '2026-04-10T00:02:10.000Z',
        null,
        null,
        null,
      );
      legacyDb.close();

      _initTestDatabaseFromFile(dbPath);

      const rawDb = new Database(dbPath, { readonly: true });
      expect(
        rawDb
          .prepare(
            `
              SELECT turn_attempt_no
                FROM paired_turn_reservations
               WHERE turn_id = ?
            `,
          )
          .get(turnId),
      ).toEqual({ turn_attempt_no: 1 });
      expect(
        rawDb
          .prepare(
            `
              SELECT turn_attempt_no
                FROM paired_task_execution_leases
               WHERE turn_id = ?
            `,
          )
          .get(turnId),
      ).toEqual({ turn_attempt_no: 1 });
      expect(
        rawDb
          .prepare(
            `
              SELECT id, turn_attempt_no
                FROM service_handoffs
               WHERE turn_id = ?
               ORDER BY id ASC
            `,
          )
          .all(turnId),
      ).toEqual([
        { id: 1, turn_attempt_no: 1 },
        { id: 2, turn_attempt_no: 2 },
      ]);
      expect(
        rawDb
          .prepare(
            `
              SELECT attempt_no, parent_attempt_id
                FROM paired_turn_attempts
               WHERE turn_id = ?
               ORDER BY attempt_no ASC
            `,
          )
          .all(turnId),
      ).toEqual([
        { attempt_no: 1, parent_attempt_id: null },
        {
          attempt_no: 2,
          parent_attempt_id: buildPairedTurnAttemptParentId(turnId, 2),
        },
      ]);
      rawDb.close();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      _initTestDatabase();
    }
  });

  it('rejects mismatched turn-attempt provenance writes across attempt-backed tables', () => {
    const database = new Database(':memory:');
    const turnId =
      'trigger-provenance-task:2026-04-10T00:00:00.000Z:reviewer-turn';

    try {
      initializeDatabaseSchema(database);

      insertPairedTurnIdentityRow(database, {
        turnId,
        taskId: 'trigger-provenance-task',
        taskUpdatedAt: '2026-04-10T00:00:00.000Z',
        role: 'reviewer',
        intentKind: 'reviewer-turn',
        createdAt: '2026-04-10T00:00:00.000Z',
        updatedAt: '2026-04-10T00:00:00.000Z',
      });

      expect(() =>
        database
          .prepare(
            `
              INSERT INTO paired_turn_attempts (
                attempt_id,
                turn_id,
                attempt_no,
                task_id,
                task_updated_at,
                role,
                intent_kind,
                state,
                executor_service_id,
                executor_agent_type,
                active_run_id,
                created_at,
                updated_at,
                completed_at,
                last_error
              )
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
          )
          .run(
            buildPairedTurnAttemptId(turnId, 1),
            turnId,
            1,
            'trigger-provenance-task',
            '2026-04-10T00:00:00.000Z',
            'owner',
            'reviewer-turn',
            'running',
            CODEX_REVIEW_SERVICE_ID,
            'codex',
            'run-trigger-provenance-1',
            '2026-04-10T00:00:00.000Z',
            '2026-04-10T00:00:00.000Z',
            null,
            null,
          ),
      ).toThrow(
        /paired_turn_attempts must reference a matching paired_turns row/,
      );

      database
        .prepare(
          `
            INSERT INTO paired_turn_attempts (
              attempt_id,
              turn_id,
              attempt_no,
              task_id,
              task_updated_at,
              role,
              intent_kind,
              state,
              executor_service_id,
              executor_agent_type,
              active_run_id,
              created_at,
              updated_at,
              completed_at,
              last_error
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          buildPairedTurnAttemptId(turnId, 1),
          turnId,
          1,
          'trigger-provenance-task',
          '2026-04-10T00:00:00.000Z',
          'reviewer',
          'reviewer-turn',
          'running',
          CODEX_REVIEW_SERVICE_ID,
          'codex',
          'run-trigger-provenance-2',
          '2026-04-10T00:00:00.000Z',
          '2026-04-10T00:00:00.000Z',
          null,
          null,
        );

      expect(() =>
        database
          .prepare(
            `
              INSERT INTO paired_turn_reservations (
                chat_jid,
                task_id,
                task_status,
                round_trip_count,
                task_updated_at,
                turn_id,
                turn_attempt_id,
                turn_attempt_no,
                turn_role,
                intent_kind,
                status,
                scheduled_run_id,
                consumed_run_id,
                created_at,
                updated_at,
                consumed_at
              )
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
          )
          .run(
            'group@test',
            'trigger-provenance-task',
            'review_ready',
            1,
            '2026-04-10T00:00:00.000Z',
            turnId,
            'bad-attempt-id',
            1,
            'owner',
            'reviewer-turn',
            'completed',
            'run-scheduled-1',
            'run-consumed-1',
            '2026-04-10T00:00:10.000Z',
            '2026-04-10T00:00:20.000Z',
            '2026-04-10T00:00:20.000Z',
          ),
      ).toThrow(
        /paired_turn_reservations turn_attempt_no must reference a matching paired_turn_attempts row/,
      );

      expect(() =>
        database
          .prepare(
            `
              INSERT INTO paired_task_execution_leases (
                task_id,
                chat_jid,
                role,
                turn_id,
                turn_attempt_id,
                turn_attempt_no,
                intent_kind,
                claimed_run_id,
                claimed_service_id,
                task_status,
                task_updated_at,
                claimed_at,
                updated_at,
                expires_at
              )
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
          )
          .run(
            'trigger-provenance-task',
            'group@test',
            'reviewer',
            turnId,
            'bad-attempt-id',
            1,
            'reviewer-turn',
            'run-1',
            CODEX_REVIEW_SERVICE_ID,
            'review_ready',
            '2026-04-10T00:05:00.000Z',
            '2026-04-10T00:00:15.000Z',
            '2026-04-10T00:00:16.000Z',
            '2099-04-10T00:10:16.000Z',
          ),
      ).toThrow(
        /paired_task_execution_leases turn_attempt_no must reference a matching paired_turn_attempts row/,
      );

      expect(() =>
        database
          .prepare(
            `
              INSERT INTO service_handoffs (
                chat_jid,
                group_folder,
                paired_task_id,
                paired_task_updated_at,
                turn_id,
                turn_attempt_id,
                turn_attempt_no,
                turn_intent_kind,
                turn_role,
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
              )
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
          )
          .run(
            'group@test',
            'test-group',
            'trigger-provenance-task',
            '2026-04-10T00:05:00.000Z',
            turnId,
            'bad-attempt-id',
            1,
            'reviewer-turn',
            'reviewer',
            CLAUDE_SERVICE_ID,
            CODEX_REVIEW_SERVICE_ID,
            'owner',
            'claude-code',
            'reviewer',
            'codex',
            'trigger provenance handoff',
            'pending',
            'reviewer',
            '2026-04-10T00:00:25.000Z',
          ),
      ).toThrow(
        /service_handoffs turn_attempt_no must reference a matching paired_turn_attempts row/,
      );
    } finally {
      database.close();
    }
  });

  it('fails init when a legacy handoff keeps an invalid turn_attempt_no provenance reference', () => {
    const tempDir = fs.mkdtempSync(
      path.join('/tmp', 'ejclaw-invalid-handoff-turn-attempt-'),
    );
    const dbPath = path.join(tempDir, 'invalid-handoff-turn-attempt.db');
    const turnId =
      'legacy-invalid-handoff:2026-04-10T00:00:00.000Z:reviewer-turn';

    try {
      const legacyDb = new Database(dbPath);
      initializeDatabaseSchema(legacyDb);
      legacyDb.exec(`
        DROP TRIGGER IF EXISTS service_handoffs_validate_attempt_insert;
        DROP TRIGGER IF EXISTS service_handoffs_validate_attempt_update;
      `);

      insertPairedTurnIdentityRow(legacyDb, {
        turnId,
        taskId: 'legacy-invalid-handoff',
        taskUpdatedAt: '2026-04-10T00:00:00.000Z',
        role: 'reviewer',
        intentKind: 'reviewer-turn',
        createdAt: '2026-04-10T00:00:00.000Z',
        updatedAt: '2026-04-10T00:01:00.000Z',
      });
      legacyDb
        .prepare(
          `
            INSERT INTO paired_turn_attempts (
              attempt_id,
              turn_id,
              attempt_no,
              task_id,
              task_updated_at,
              role,
              intent_kind,
              state,
              executor_service_id,
              executor_agent_type,
              created_at,
              updated_at,
              completed_at,
              last_error
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          buildPairedTurnAttemptId(turnId, 1),
          turnId,
          1,
          'legacy-invalid-handoff',
          '2026-04-10T00:00:00.000Z',
          'reviewer',
          'reviewer-turn',
          'failed',
          CODEX_REVIEW_SERVICE_ID,
          'codex',
          '2026-04-10T00:00:00.000Z',
          '2026-04-10T00:01:00.000Z',
          '2026-04-10T00:01:00.000Z',
          'attempt failed',
        );
      legacyDb
        .prepare(
          `
            INSERT INTO service_handoffs (
              chat_jid,
              group_folder,
              paired_task_id,
              paired_task_updated_at,
              turn_id,
              turn_attempt_no,
              turn_intent_kind,
              turn_role,
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
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          'group@test',
          'test-group',
          'legacy-invalid-handoff',
          '2026-04-10T00:05:00.000Z',
          turnId,
          1,
          'reviewer-turn',
          'reviewer',
          CLAUDE_SERVICE_ID,
          CODEX_REVIEW_SERVICE_ID,
          'owner',
          'claude-code',
          'reviewer',
          'codex',
          'legacy invalid handoff',
          'failed',
          'reviewer',
          '2026-04-10T00:00:30.000Z',
        );
      legacyDb.close();

      expect(() => _initTestDatabaseFromFile(dbPath)).toThrow(
        /service_handoffs\(id=1\) has invalid paired_turn_attempt provenance/,
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      _initTestDatabase();
    }
  });

  it('fails init when an attempt keeps an invalid parent_handoff_id provenance reference', () => {
    const tempDir = fs.mkdtempSync(
      path.join('/tmp', 'ejclaw-invalid-parent-handoff-'),
    );
    const dbPath = path.join(tempDir, 'invalid-parent-handoff.db');
    const turnId =
      'legacy-invalid-parent-handoff:2026-04-10T00:00:00.000Z:reviewer-turn';
    const otherTurnId =
      'legacy-other-parent-handoff:2026-04-10T00:00:00.000Z:reviewer-turn';

    try {
      const legacyDb = new Database(dbPath);
      initializeDatabaseSchema(legacyDb);
      legacyDb.exec(`
        DROP TRIGGER IF EXISTS paired_turn_attempts_validate_insert;
        DROP TRIGGER IF EXISTS paired_turn_attempts_validate_update;
      `);

      const insertTurn = (args: {
        turnId: string;
        taskId: string;
        taskUpdatedAt: string;
        role: 'owner' | 'reviewer' | 'arbiter';
        intentKind:
          | 'owner-turn'
          | 'reviewer-turn'
          | 'arbiter-turn'
          | 'owner-follow-up'
          | 'finalize-owner-turn';
        createdAt: string;
        updatedAt: string;
      }) => insertPairedTurnIdentityRow(legacyDb, args);
      const insertAttempt = legacyDb.prepare(
        `
          INSERT INTO paired_turn_attempts (
            attempt_id,
            parent_attempt_id,
            parent_handoff_id,
            turn_id,
            attempt_no,
            task_id,
            task_updated_at,
            role,
            intent_kind,
            state,
            executor_service_id,
            executor_agent_type,
            created_at,
            updated_at,
            completed_at,
            last_error
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      );

      insertTurn({
        turnId: otherTurnId,
        taskId: 'legacy-other-parent-handoff',
        taskUpdatedAt: '2026-04-10T00:00:00.000Z',
        role: 'reviewer',
        intentKind: 'reviewer-turn',
        createdAt: '2026-04-10T00:00:00.000Z',
        updatedAt: '2026-04-10T00:00:30.000Z',
      });
      insertAttempt.run(
        buildPairedTurnAttemptId(otherTurnId, 1),
        null,
        null,
        otherTurnId,
        1,
        'legacy-other-parent-handoff',
        '2026-04-10T00:00:00.000Z',
        'reviewer',
        'reviewer-turn',
        'delegated',
        CODEX_REVIEW_SERVICE_ID,
        'codex',
        '2026-04-10T00:00:00.000Z',
        '2026-04-10T00:00:30.000Z',
        null,
        null,
      );
      legacyDb
        .prepare(
          `
            INSERT INTO service_handoffs (
              chat_jid,
              group_folder,
              paired_task_id,
              paired_task_updated_at,
              turn_id,
              turn_attempt_id,
              turn_attempt_no,
              turn_intent_kind,
              turn_role,
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
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          'group@test',
          'test-group',
          'legacy-other-parent-handoff',
          '2026-04-10T00:00:00.000Z',
          otherTurnId,
          buildPairedTurnAttemptId(otherTurnId, 1),
          1,
          'reviewer-turn',
          'reviewer',
          CLAUDE_SERVICE_ID,
          CODEX_REVIEW_SERVICE_ID,
          'owner',
          'claude-code',
          'reviewer',
          'codex',
          'wrong parent handoff',
          'failed',
          'reviewer',
          '2026-04-10T00:00:20.000Z',
        );
      const wrongHandoffId = (
        legacyDb.prepare('SELECT last_insert_rowid() AS id').get() as {
          id: number;
        }
      ).id;

      insertTurn({
        turnId,
        taskId: 'legacy-invalid-parent-handoff',
        taskUpdatedAt: '2026-04-10T00:00:00.000Z',
        role: 'reviewer',
        intentKind: 'reviewer-turn',
        createdAt: '2026-04-10T00:00:00.000Z',
        updatedAt: '2026-04-10T00:01:00.000Z',
      });
      insertAttempt.run(
        buildPairedTurnAttemptId(turnId, 1),
        null,
        null,
        turnId,
        1,
        'legacy-invalid-parent-handoff',
        '2026-04-10T00:00:00.000Z',
        'reviewer',
        'reviewer-turn',
        'failed',
        CODEX_REVIEW_SERVICE_ID,
        'codex',
        '2026-04-10T00:00:00.000Z',
        '2026-04-10T00:00:40.000Z',
        '2026-04-10T00:00:40.000Z',
        'attempt 1 failed',
      );
      insertAttempt.run(
        buildPairedTurnAttemptId(turnId, 2),
        buildPairedTurnAttemptParentId(turnId, 2),
        wrongHandoffId,
        turnId,
        2,
        'legacy-invalid-parent-handoff',
        '2026-04-10T00:00:00.000Z',
        'reviewer',
        'reviewer-turn',
        'running',
        CODEX_REVIEW_SERVICE_ID,
        'codex',
        '2026-04-10T00:01:00.000Z',
        '2026-04-10T00:01:00.000Z',
        null,
        null,
      );
      legacyDb.close();

      expect(() => _initTestDatabaseFromFile(dbPath)).toThrow(
        /invalid parent_handoff_id provenance/,
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      _initTestDatabase();
    }
  });

  it('fails init when an attempt keeps a completed parent_handoff_id provenance reference', () => {
    const tempDir = fs.mkdtempSync(
      path.join('/tmp', 'ejclaw-completed-parent-handoff-'),
    );
    const dbPath = path.join(tempDir, 'completed-parent-handoff.db');
    const turnId =
      'legacy-completed-parent-handoff:2026-04-10T00:00:00.000Z:reviewer-turn';

    try {
      const legacyDb = new Database(dbPath);
      initializeDatabaseSchema(legacyDb);
      legacyDb.exec(`
        DROP TRIGGER IF EXISTS paired_turn_attempts_validate_insert;
        DROP TRIGGER IF EXISTS paired_turn_attempts_validate_update;
      `);

      const insertTurn = (args: {
        turnId: string;
        taskId: string;
        taskUpdatedAt: string;
        role: 'owner' | 'reviewer' | 'arbiter';
        intentKind:
          | 'owner-turn'
          | 'reviewer-turn'
          | 'arbiter-turn'
          | 'owner-follow-up'
          | 'finalize-owner-turn';
        createdAt: string;
        updatedAt: string;
      }) => insertPairedTurnIdentityRow(legacyDb, args);
      const insertAttempt = legacyDb.prepare(
        `
          INSERT INTO paired_turn_attempts (
            attempt_id,
            parent_attempt_id,
            parent_handoff_id,
            turn_id,
            attempt_no,
            task_id,
            task_updated_at,
            role,
            intent_kind,
            state,
            executor_service_id,
            executor_agent_type,
            created_at,
            updated_at,
            completed_at,
            last_error
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      );

      insertTurn({
        turnId,
        taskId: 'legacy-completed-parent-handoff',
        taskUpdatedAt: '2026-04-10T00:00:00.000Z',
        role: 'reviewer',
        intentKind: 'reviewer-turn',
        createdAt: '2026-04-10T00:00:00.000Z',
        updatedAt: '2026-04-10T00:01:00.000Z',
      });
      insertAttempt.run(
        buildPairedTurnAttemptId(turnId, 1),
        null,
        null,
        turnId,
        1,
        'legacy-completed-parent-handoff',
        '2026-04-10T00:00:00.000Z',
        'reviewer',
        'reviewer-turn',
        'completed',
        CODEX_REVIEW_SERVICE_ID,
        'codex',
        '2026-04-10T00:00:00.000Z',
        '2026-04-10T00:00:40.000Z',
        '2026-04-10T00:00:40.000Z',
        null,
      );
      legacyDb
        .prepare(
          `
            INSERT INTO service_handoffs (
              chat_jid,
              group_folder,
              paired_task_id,
              paired_task_updated_at,
              turn_id,
              turn_attempt_id,
              turn_attempt_no,
              turn_intent_kind,
              turn_role,
              source_service_id,
              target_service_id,
              source_role,
              source_agent_type,
              target_role,
              target_agent_type,
              prompt,
              status,
              intended_role,
              created_at,
              completed_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          'group@test',
          'test-group',
          'legacy-completed-parent-handoff',
          '2026-04-10T00:00:00.000Z',
          turnId,
          buildPairedTurnAttemptId(turnId, 1),
          1,
          'reviewer-turn',
          'reviewer',
          CLAUDE_SERVICE_ID,
          CODEX_REVIEW_SERVICE_ID,
          'owner',
          'claude-code',
          'reviewer',
          'codex',
          'completed handoff cannot seed retry lineage',
          'completed',
          'reviewer',
          '2026-04-10T00:00:20.000Z',
          '2026-04-10T00:00:30.000Z',
        );
      const completedHandoffId = (
        legacyDb.prepare('SELECT last_insert_rowid() AS id').get() as {
          id: number;
        }
      ).id;

      insertAttempt.run(
        buildPairedTurnAttemptId(turnId, 2),
        buildPairedTurnAttemptParentId(turnId, 2),
        completedHandoffId,
        turnId,
        2,
        'legacy-completed-parent-handoff',
        '2026-04-10T00:00:00.000Z',
        'reviewer',
        'reviewer-turn',
        'running',
        CODEX_REVIEW_SERVICE_ID,
        'codex',
        '2026-04-10T00:01:00.000Z',
        '2026-04-10T00:01:00.000Z',
        null,
        null,
      );
      legacyDb.close();

      expect(() => _initTestDatabaseFromFile(dbPath)).toThrow(
        /invalid parent_handoff_id provenance/,
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      _initTestDatabase();
    }
  });

  it('fails init when an attempt keeps an invalid continuation_handoff_id provenance reference', () => {
    const tempDir = fs.mkdtempSync(
      path.join('/tmp', 'ejclaw-invalid-continuation-handoff-'),
    );
    const dbPath = path.join(tempDir, 'invalid-continuation-handoff.db');
    const turnId =
      'legacy-invalid-continuation-handoff:2026-04-10T00:00:00.000Z:reviewer-turn';
    const otherTurnId =
      'legacy-other-continuation-handoff:2026-04-10T00:00:00.000Z:reviewer-turn';

    try {
      const legacyDb = new Database(dbPath);
      initializeDatabaseSchema(legacyDb);
      legacyDb.exec(`
        DROP TRIGGER IF EXISTS paired_turn_attempts_validate_insert;
        DROP TRIGGER IF EXISTS paired_turn_attempts_validate_update;
      `);

      const insertTurn = (args: {
        turnId: string;
        taskId: string;
        taskUpdatedAt: string;
        role: 'owner' | 'reviewer' | 'arbiter';
        intentKind:
          | 'owner-turn'
          | 'reviewer-turn'
          | 'arbiter-turn'
          | 'owner-follow-up'
          | 'finalize-owner-turn';
        createdAt: string;
        updatedAt: string;
      }) =>
        insertPairedTurnIdentityRow(legacyDb, {
          turnId: args.turnId,
          taskId: args.taskId,
          taskUpdatedAt: args.taskUpdatedAt,
          role: args.role,
          intentKind: args.intentKind,
          createdAt: args.createdAt,
          updatedAt: args.updatedAt,
        });
      const insertAttempt = legacyDb.prepare(
        `
          INSERT INTO paired_turn_attempts (
            attempt_id,
            parent_attempt_id,
            parent_handoff_id,
            continuation_handoff_id,
            turn_id,
            attempt_no,
            task_id,
            task_updated_at,
            role,
            intent_kind,
            state,
            executor_service_id,
            executor_agent_type,
            created_at,
            updated_at,
            completed_at,
            last_error
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      );

      insertTurn({
        turnId: otherTurnId,
        taskId: 'legacy-other-continuation-handoff',
        taskUpdatedAt: '2026-04-10T00:00:00.000Z',
        role: 'reviewer',
        intentKind: 'reviewer-turn',
        createdAt: '2026-04-10T00:00:00.000Z',
        updatedAt: '2026-04-10T00:00:30.000Z',
      });
      insertAttempt.run(
        buildPairedTurnAttemptId(otherTurnId, 1),
        null,
        null,
        null,
        otherTurnId,
        1,
        'legacy-other-continuation-handoff',
        '2026-04-10T00:00:00.000Z',
        'reviewer',
        'reviewer-turn',
        'delegated',
        CODEX_REVIEW_SERVICE_ID,
        'codex',
        '2026-04-10T00:00:00.000Z',
        '2026-04-10T00:00:30.000Z',
        null,
        null,
      );
      legacyDb
        .prepare(
          `
            INSERT INTO service_handoffs (
              chat_jid,
              group_folder,
              paired_task_id,
              paired_task_updated_at,
              turn_id,
              turn_attempt_id,
              turn_attempt_no,
              turn_intent_kind,
              turn_role,
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
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          'group@test',
          'test-group',
          'legacy-other-continuation-handoff',
          '2026-04-10T00:00:00.000Z',
          otherTurnId,
          buildPairedTurnAttemptId(otherTurnId, 1),
          1,
          'reviewer-turn',
          'reviewer',
          CLAUDE_SERVICE_ID,
          CODEX_REVIEW_SERVICE_ID,
          'owner',
          'claude-code',
          'reviewer',
          'codex',
          'wrong continuation handoff',
          'claimed',
          'reviewer',
          '2026-04-10T00:00:20.000Z',
        );
      const wrongHandoffId = (
        legacyDb.prepare('SELECT last_insert_rowid() AS id').get() as {
          id: number;
        }
      ).id;

      insertTurn({
        turnId,
        taskId: 'legacy-invalid-continuation-handoff',
        taskUpdatedAt: '2026-04-10T00:00:00.000Z',
        role: 'reviewer',
        intentKind: 'reviewer-turn',
        createdAt: '2026-04-10T00:00:00.000Z',
        updatedAt: '2026-04-10T00:01:00.000Z',
      });
      insertAttempt.run(
        buildPairedTurnAttemptId(turnId, 1),
        null,
        null,
        wrongHandoffId,
        turnId,
        1,
        'legacy-invalid-continuation-handoff',
        '2026-04-10T00:00:00.000Z',
        'reviewer',
        'reviewer-turn',
        'running',
        CODEX_REVIEW_SERVICE_ID,
        'codex',
        '2026-04-10T00:01:00.000Z',
        '2026-04-10T00:01:00.000Z',
        null,
        null,
      );
      legacyDb.close();

      expect(() => _initTestDatabaseFromFile(dbPath)).toThrow(
        /invalid continuation_handoff_id provenance/,
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      _initTestDatabase();
    }
  });

  it('rebuilds legacy turn-attempt provenance tables with actual foreign keys on init', () => {
    const tempDir = fs.mkdtempSync(
      path.join('/tmp', 'ejclaw-turn-attempt-fk-rebuild-'),
    );
    const dbPath = path.join(tempDir, 'turn-attempt-fk-rebuild.db');

    try {
      const legacyDb = new Database(dbPath);
      legacyDb.exec(`
        CREATE TABLE paired_turns (
          turn_id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          task_updated_at TEXT NOT NULL,
          role TEXT NOT NULL,
          intent_kind TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'queued',
          executor_service_id TEXT,
          executor_agent_type TEXT,
          active_run_id TEXT,
          attempt_no INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT,
          last_error TEXT
        );
        CREATE TABLE paired_turn_attempts (
          turn_id TEXT NOT NULL,
          attempt_no INTEGER NOT NULL,
          task_id TEXT NOT NULL,
          task_updated_at TEXT NOT NULL,
          role TEXT NOT NULL,
          intent_kind TEXT NOT NULL,
          state TEXT NOT NULL,
          executor_service_id TEXT,
          executor_agent_type TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT,
          last_error TEXT,
          PRIMARY KEY (turn_id, attempt_no)
        );
        CREATE TABLE paired_turn_reservations (
          chat_jid TEXT NOT NULL,
          task_id TEXT NOT NULL,
          task_status TEXT NOT NULL,
          round_trip_count INTEGER NOT NULL DEFAULT 0,
          task_updated_at TEXT NOT NULL,
          turn_id TEXT NOT NULL,
          turn_attempt_no INTEGER,
          turn_role TEXT NOT NULL,
          intent_kind TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          scheduled_run_id TEXT,
          consumed_run_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          consumed_at TEXT,
          PRIMARY KEY (chat_jid, task_id, task_updated_at, intent_kind)
        );
        CREATE TABLE paired_task_execution_leases (
          task_id TEXT PRIMARY KEY,
          chat_jid TEXT NOT NULL,
          role TEXT NOT NULL,
          turn_id TEXT NOT NULL,
          turn_attempt_no INTEGER,
          intent_kind TEXT NOT NULL,
          claimed_run_id TEXT NOT NULL,
          claimed_service_id TEXT NOT NULL,
          task_status TEXT NOT NULL,
          task_updated_at TEXT NOT NULL,
          claimed_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          expires_at TEXT NOT NULL
        );
        CREATE TABLE service_handoffs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          chat_jid TEXT NOT NULL,
          group_folder TEXT NOT NULL,
          source_service_id TEXT NOT NULL,
          target_service_id TEXT NOT NULL,
          paired_task_id TEXT,
          paired_task_updated_at TEXT,
          turn_id TEXT,
          turn_attempt_no INTEGER,
          turn_intent_kind TEXT,
          turn_role TEXT,
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
          `
            INSERT INTO paired_turns (
              turn_id,
              task_id,
              task_updated_at,
              role,
              intent_kind,
              state,
              executor_service_id,
              executor_agent_type,
              attempt_no,
              created_at,
              updated_at,
              completed_at,
              last_error
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          'fk-rebuild-turn:2026-04-10T00:00:00.000Z:reviewer-turn',
          'fk-rebuild-task',
          '2026-04-10T00:00:00.000Z',
          'reviewer',
          'reviewer-turn',
          'failed',
          CODEX_REVIEW_SERVICE_ID,
          'codex',
          1,
          '2026-04-10T00:00:00.000Z',
          '2026-04-10T00:01:00.000Z',
          '2026-04-10T00:01:00.000Z',
          'attempt failed',
        );
      legacyDb
        .prepare(
          `
            INSERT INTO paired_turn_attempts (
              turn_id,
              attempt_no,
              task_id,
              task_updated_at,
              role,
              intent_kind,
              state,
              executor_service_id,
              executor_agent_type,
              created_at,
              updated_at,
              completed_at,
              last_error
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          'fk-rebuild-turn:2026-04-10T00:00:00.000Z:reviewer-turn',
          1,
          'fk-rebuild-task',
          '2026-04-10T00:00:00.000Z',
          'reviewer',
          'reviewer-turn',
          'failed',
          CODEX_REVIEW_SERVICE_ID,
          'codex',
          '2026-04-10T00:00:00.000Z',
          '2026-04-10T00:01:00.000Z',
          '2026-04-10T00:01:00.000Z',
          'attempt failed',
        );
      legacyDb
        .prepare(
          `
            INSERT INTO paired_turn_reservations (
              chat_jid,
              task_id,
              task_status,
              round_trip_count,
              task_updated_at,
              turn_id,
              turn_attempt_no,
              turn_role,
              intent_kind,
              status,
              scheduled_run_id,
              consumed_run_id,
              created_at,
              updated_at,
              consumed_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          'group@test',
          'fk-rebuild-task',
          'review_ready',
          1,
          '2026-04-10T00:00:00.000Z',
          'fk-rebuild-turn:2026-04-10T00:00:00.000Z:reviewer-turn',
          1,
          'reviewer',
          'reviewer-turn',
          'completed',
          'run-1',
          'run-1',
          '2026-04-10T00:00:10.000Z',
          '2026-04-10T00:00:20.000Z',
          '2026-04-10T00:00:20.000Z',
        );
      legacyDb.close();

      _initTestDatabaseFromFile(dbPath);

      const migratedDb = new Database(dbPath, { readonly: true });
      const attemptFks = migratedDb
        .prepare(`PRAGMA foreign_key_list(paired_turn_attempts)`)
        .all() as Array<{ table: string; from: string; to: string }>;
      const reservationFks = migratedDb
        .prepare(`PRAGMA foreign_key_list(paired_turn_reservations)`)
        .all() as Array<{ table: string; from: string; to: string }>;
      const leaseFks = migratedDb
        .prepare(`PRAGMA foreign_key_list(paired_task_execution_leases)`)
        .all() as Array<{ table: string; from: string; to: string }>;
      const handoffFks = migratedDb
        .prepare(`PRAGMA foreign_key_list(service_handoffs)`)
        .all() as Array<{ table: string; from: string; to: string }>;

      expect(
        attemptFks.some(
          (row) =>
            row.table === 'paired_turns' &&
            row.from === 'turn_id' &&
            row.to === 'turn_id',
        ),
      ).toBe(true);
      expect(
        attemptFks.some(
          (row) =>
            row.table === 'paired_turn_attempts' &&
            row.from === 'parent_attempt_id' &&
            row.to === 'attempt_id',
        ),
      ).toBe(true);
      expect(
        attemptFks.some(
          (row) =>
            row.table === 'service_handoffs' &&
            row.from === 'parent_handoff_id' &&
            row.to === 'id',
        ),
      ).toBe(true);
      expect(
        attemptFks.some(
          (row) =>
            row.table === 'service_handoffs' &&
            row.from === 'continuation_handoff_id' &&
            row.to === 'id',
        ),
      ).toBe(true);
      expect(
        reservationFks.some(
          (row) =>
            row.table === 'paired_turn_attempts' && row.from === 'turn_id',
        ),
      ).toBe(true);
      expect(
        leaseFks.some(
          (row) =>
            row.table === 'paired_turn_attempts' && row.from === 'turn_id',
        ),
      ).toBe(true);
      expect(
        handoffFks.some(
          (row) =>
            row.table === 'paired_turn_attempts' && row.from === 'turn_id',
        ),
      ).toBe(true);
      migratedDb.close();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      _initTestDatabase();
    }
  });

  it('uses real foreign keys to reject orphan attempt provenance when triggers are absent', () => {
    const database = new Database(':memory:');

    try {
      initializeDatabaseSchema(database);
      database.exec(`
        DROP TRIGGER IF EXISTS paired_turn_attempts_validate_insert;
        DROP TRIGGER IF EXISTS paired_turn_attempts_validate_update;
        DROP TRIGGER IF EXISTS service_handoffs_validate_attempt_insert;
        DROP TRIGGER IF EXISTS service_handoffs_validate_attempt_update;
      `);

      expect(() =>
        database
          .prepare(
            `
              INSERT INTO paired_turn_attempts (
                attempt_id,
                turn_id,
                attempt_no,
                task_id,
                task_updated_at,
                role,
                intent_kind,
                state,
                executor_service_id,
                executor_agent_type,
                created_at,
                updated_at,
                completed_at,
                last_error
              )
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
          )
          .run(
            buildPairedTurnAttemptId(
              'orphan-turn:2026-04-10T00:00:00.000Z:reviewer-turn',
              1,
            ),
            'orphan-turn:2026-04-10T00:00:00.000Z:reviewer-turn',
            1,
            'orphan-task',
            '2026-04-10T00:00:00.000Z',
            'reviewer',
            'reviewer-turn',
            'failed',
            CODEX_REVIEW_SERVICE_ID,
            'codex',
            '2026-04-10T00:00:00.000Z',
            '2026-04-10T00:01:00.000Z',
            '2026-04-10T00:01:00.000Z',
            'orphan attempt',
          ),
      ).toThrow(/FOREIGN KEY constraint failed/);

      const turnId = 'fk-enforced-turn:2026-04-10T00:00:00.000Z:reviewer-turn';
      insertPairedTurnIdentityRow(database, {
        turnId,
        taskId: 'fk-enforced-task',
        taskUpdatedAt: '2026-04-10T00:00:00.000Z',
        role: 'reviewer',
        intentKind: 'reviewer-turn',
        createdAt: '2026-04-10T00:00:00.000Z',
        updatedAt: '2026-04-10T00:01:00.000Z',
      });
      database
        .prepare(
          `
          INSERT INTO paired_turn_attempts (
            attempt_id,
            turn_id,
            attempt_no,
              task_id,
              task_updated_at,
              role,
              intent_kind,
              state,
              executor_service_id,
              executor_agent_type,
              created_at,
              updated_at,
              completed_at,
              last_error
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          buildPairedTurnAttemptId(turnId, 1),
          turnId,
          1,
          'fk-enforced-task',
          '2026-04-10T00:00:00.000Z',
          'reviewer',
          'reviewer-turn',
          'failed',
          CODEX_REVIEW_SERVICE_ID,
          'codex',
          '2026-04-10T00:00:00.000Z',
          '2026-04-10T00:01:00.000Z',
          '2026-04-10T00:01:00.000Z',
          'attempt failed',
        );
      expect(() =>
        database
          .prepare(
            `
              INSERT INTO paired_turn_attempts (
                attempt_id,
                parent_attempt_id,
                parent_handoff_id,
                turn_id,
                attempt_no,
                task_id,
                task_updated_at,
                role,
                intent_kind,
                state,
                executor_service_id,
                executor_agent_type,
                created_at,
                updated_at,
                completed_at,
                last_error
              )
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
          )
          .run(
            buildPairedTurnAttemptId(turnId, 2),
            buildPairedTurnAttemptParentId(turnId, 2),
            999,
            turnId,
            2,
            'fk-enforced-task',
            '2026-04-10T00:00:00.000Z',
            'reviewer',
            'reviewer-turn',
            'failed',
            CODEX_REVIEW_SERVICE_ID,
            'codex',
            '2026-04-10T00:02:00.000Z',
            '2026-04-10T00:02:00.000Z',
            '2026-04-10T00:02:00.000Z',
            'orphan parent handoff',
          ),
      ).toThrow(/FOREIGN KEY constraint failed/);

      expect(() =>
        database
          .prepare(
            `
              INSERT INTO service_handoffs (
                chat_jid,
                group_folder,
                paired_task_id,
                paired_task_updated_at,
                turn_id,
                turn_attempt_no,
                turn_intent_kind,
                turn_role,
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
              )
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
          )
          .run(
            'group@test',
            'test-group',
            'fk-enforced-task',
            '2026-04-10T00:00:00.000Z',
            turnId,
            2,
            'reviewer-turn',
            'reviewer',
            CLAUDE_SERVICE_ID,
            CODEX_REVIEW_SERVICE_ID,
            'owner',
            'claude-code',
            'reviewer',
            'codex',
            'orphan handoff attempt reference',
            'failed',
            'reviewer',
            '2026-04-10T00:00:30.000Z',
          ),
      ).toThrow(/FOREIGN KEY constraint failed/);
    } finally {
      database.close();
    }
  });

  it('rejects direct inserts when attempt lineage skips the previous attempt', () => {
    const database = new Database(':memory:');

    try {
      initializeDatabaseSchema(database);

      const turnIdentity = buildPairedTurnIdentity({
        taskId: 'trigger-parent-gap-task',
        taskUpdatedAt: '2026-04-10T00:00:00.000Z',
        role: 'reviewer',
        intentKind: 'reviewer-turn',
      });

      insertPairedTurnIdentityRow(database, {
        turnId: turnIdentity.turnId,
        taskId: turnIdentity.taskId,
        taskUpdatedAt: turnIdentity.taskUpdatedAt,
        role: turnIdentity.role,
        intentKind: turnIdentity.intentKind,
        createdAt: '2026-04-10T00:00:00.000Z',
        updatedAt: '2026-04-10T00:03:00.000Z',
      });

      expect(() =>
        database
          .prepare(
            `
              INSERT INTO paired_turn_attempts (
                attempt_id,
                parent_attempt_id,
                turn_id,
                attempt_no,
                task_id,
                task_updated_at,
                role,
                intent_kind,
                state,
                executor_service_id,
                executor_agent_type,
                created_at,
                updated_at,
                completed_at,
                last_error
              )
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
          )
          .run(
            buildPairedTurnAttemptId(turnIdentity.turnId, 3),
            null,
            turnIdentity.turnId,
            3,
            turnIdentity.taskId,
            turnIdentity.taskUpdatedAt,
            turnIdentity.role,
            turnIdentity.intentKind,
            'failed',
            CODEX_REVIEW_SERVICE_ID,
            'codex',
            '2026-04-10T00:03:00.000Z',
            '2026-04-10T00:03:20.000Z',
            '2026-04-10T00:03:20.000Z',
            'attempt 3 failed',
          ),
      ).toThrow(/must preserve contiguous parent lineage/);
    } finally {
      database.close();
    }
  });

  it('rejects direct inserts when parent_handoff_id does not belong to the previous attempt of the same turn', () => {
    const database = new Database(':memory:');

    try {
      initializeDatabaseSchema(database);

      const otherTurnId =
        'other-handoff-turn:2026-04-10T00:00:00.000Z:reviewer-turn';
      insertPairedTurnIdentityRow(database, {
        turnId: otherTurnId,
        taskId: 'other-handoff-task',
        taskUpdatedAt: '2026-04-10T00:00:00.000Z',
        role: 'reviewer',
        intentKind: 'reviewer-turn',
        createdAt: '2026-04-10T00:00:00.000Z',
        updatedAt: '2026-04-10T00:00:30.000Z',
      });
      database
        .prepare(
          `
            INSERT INTO paired_turn_attempts (
              attempt_id,
              turn_id,
              attempt_no,
              task_id,
              task_updated_at,
              role,
              intent_kind,
              state,
              executor_service_id,
              executor_agent_type,
              created_at,
              updated_at,
              completed_at,
              last_error
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          buildPairedTurnAttemptId(otherTurnId, 1),
          otherTurnId,
          1,
          'other-handoff-task',
          '2026-04-10T00:00:00.000Z',
          'reviewer',
          'reviewer-turn',
          'delegated',
          CODEX_REVIEW_SERVICE_ID,
          'codex',
          '2026-04-10T00:00:00.000Z',
          '2026-04-10T00:00:30.000Z',
          null,
          null,
        );
      database
        .prepare(
          `
            INSERT INTO service_handoffs (
              chat_jid,
              group_folder,
              paired_task_id,
              paired_task_updated_at,
              turn_id,
              turn_attempt_id,
              turn_attempt_no,
              turn_intent_kind,
              turn_role,
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
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          'group@test',
          'test-group',
          'other-handoff-task',
          '2026-04-10T00:00:00.000Z',
          otherTurnId,
          buildPairedTurnAttemptId(otherTurnId, 1),
          1,
          'reviewer-turn',
          'reviewer',
          CLAUDE_SERVICE_ID,
          CODEX_REVIEW_SERVICE_ID,
          'owner',
          'claude-code',
          'reviewer',
          'codex',
          'other handoff',
          'failed',
          'reviewer',
          '2026-04-10T00:00:30.000Z',
        );
      const wrongHandoffId = (
        database.prepare('SELECT last_insert_rowid() AS id').get() as {
          id: number;
        }
      ).id;

      const turnIdentity = buildPairedTurnIdentity({
        taskId: 'trigger-parent-handoff-task',
        taskUpdatedAt: '2026-04-10T00:00:00.000Z',
        role: 'reviewer',
        intentKind: 'reviewer-turn',
      });
      insertPairedTurnIdentityRow(database, {
        turnId: turnIdentity.turnId,
        taskId: turnIdentity.taskId,
        taskUpdatedAt: turnIdentity.taskUpdatedAt,
        role: turnIdentity.role,
        intentKind: turnIdentity.intentKind,
        createdAt: '2026-04-10T00:00:00.000Z',
        updatedAt: '2026-04-10T00:01:00.000Z',
      });
      database
        .prepare(
          `
            INSERT INTO paired_turn_attempts (
              attempt_id,
              turn_id,
              attempt_no,
              task_id,
              task_updated_at,
              role,
              intent_kind,
              state,
              executor_service_id,
              executor_agent_type,
              created_at,
              updated_at,
              completed_at,
              last_error
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          buildPairedTurnAttemptId(turnIdentity.turnId, 1),
          turnIdentity.turnId,
          1,
          turnIdentity.taskId,
          turnIdentity.taskUpdatedAt,
          turnIdentity.role,
          turnIdentity.intentKind,
          'failed',
          CODEX_REVIEW_SERVICE_ID,
          'codex',
          '2026-04-10T00:00:00.000Z',
          '2026-04-10T00:01:00.000Z',
          '2026-04-10T00:01:00.000Z',
          'attempt 1 failed',
        );

      expect(() =>
        database
          .prepare(
            `
              INSERT INTO paired_turn_attempts (
                attempt_id,
                parent_attempt_id,
                parent_handoff_id,
                turn_id,
                attempt_no,
                task_id,
                task_updated_at,
                role,
                intent_kind,
                state,
                executor_service_id,
                executor_agent_type,
                created_at,
                updated_at,
                completed_at,
                last_error
              )
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
          )
          .run(
            buildPairedTurnAttemptId(turnIdentity.turnId, 2),
            buildPairedTurnAttemptParentId(turnIdentity.turnId, 2),
            wrongHandoffId,
            turnIdentity.turnId,
            2,
            turnIdentity.taskId,
            turnIdentity.taskUpdatedAt,
            turnIdentity.role,
            turnIdentity.intentKind,
            'running',
            CODEX_REVIEW_SERVICE_ID,
            'codex',
            '2026-04-10T00:02:00.000Z',
            '2026-04-10T00:02:00.000Z',
            null,
            null,
          ),
      ).toThrow(
        /parent_handoff_id must reference the previous attempt handoff of the same turn/,
      );
    } finally {
      database.close();
    }
  });

  it('rejects direct inserts when parent_handoff_id points to a completed previous-attempt handoff', () => {
    const database = new Database(':memory:');

    try {
      initializeDatabaseSchema(database);

      const turnIdentity = buildPairedTurnIdentity({
        taskId: 'trigger-completed-parent-handoff-task',
        taskUpdatedAt: '2026-04-10T00:00:00.000Z',
        role: 'reviewer',
        intentKind: 'reviewer-turn',
      });
      insertPairedTurnIdentityRow(database, {
        turnId: turnIdentity.turnId,
        taskId: turnIdentity.taskId,
        taskUpdatedAt: turnIdentity.taskUpdatedAt,
        role: turnIdentity.role,
        intentKind: turnIdentity.intentKind,
        createdAt: '2026-04-10T00:00:00.000Z',
        updatedAt: '2026-04-10T00:01:00.000Z',
      });
      database
        .prepare(
          `
            INSERT INTO paired_turn_attempts (
              attempt_id,
              turn_id,
              attempt_no,
              task_id,
              task_updated_at,
              role,
              intent_kind,
              state,
              executor_service_id,
              executor_agent_type,
              created_at,
              updated_at,
              completed_at,
              last_error
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          buildPairedTurnAttemptId(turnIdentity.turnId, 1),
          turnIdentity.turnId,
          1,
          turnIdentity.taskId,
          turnIdentity.taskUpdatedAt,
          turnIdentity.role,
          turnIdentity.intentKind,
          'completed',
          CODEX_REVIEW_SERVICE_ID,
          'codex',
          '2026-04-10T00:00:00.000Z',
          '2026-04-10T00:01:00.000Z',
          '2026-04-10T00:01:00.000Z',
          null,
        );
      database
        .prepare(
          `
            INSERT INTO service_handoffs (
              chat_jid,
              group_folder,
              paired_task_id,
              paired_task_updated_at,
              turn_id,
              turn_attempt_id,
              turn_attempt_no,
              turn_intent_kind,
              turn_role,
              source_service_id,
              target_service_id,
              source_role,
              source_agent_type,
              target_role,
              target_agent_type,
              prompt,
              status,
              intended_role,
              created_at,
              completed_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          'group@test',
          'test-group',
          turnIdentity.taskId,
          turnIdentity.taskUpdatedAt,
          turnIdentity.turnId,
          buildPairedTurnAttemptId(turnIdentity.turnId, 1),
          1,
          turnIdentity.intentKind,
          turnIdentity.role,
          CLAUDE_SERVICE_ID,
          CODEX_REVIEW_SERVICE_ID,
          'owner',
          'claude-code',
          turnIdentity.role,
          'codex',
          'completed handoff cannot seed retry lineage',
          'completed',
          turnIdentity.role,
          '2026-04-10T00:00:20.000Z',
          '2026-04-10T00:00:30.000Z',
        );
      const completedHandoffId = (
        database.prepare('SELECT last_insert_rowid() AS id').get() as {
          id: number;
        }
      ).id;

      expect(() =>
        database
          .prepare(
            `
              INSERT INTO paired_turn_attempts (
                attempt_id,
                parent_attempt_id,
                parent_handoff_id,
                turn_id,
                attempt_no,
                task_id,
                task_updated_at,
                role,
                intent_kind,
                state,
                executor_service_id,
                executor_agent_type,
                created_at,
                updated_at,
                completed_at,
                last_error
              )
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
          )
          .run(
            buildPairedTurnAttemptId(turnIdentity.turnId, 2),
            buildPairedTurnAttemptParentId(turnIdentity.turnId, 2),
            completedHandoffId,
            turnIdentity.turnId,
            2,
            turnIdentity.taskId,
            turnIdentity.taskUpdatedAt,
            turnIdentity.role,
            turnIdentity.intentKind,
            'running',
            CODEX_REVIEW_SERVICE_ID,
            'codex',
            '2026-04-10T00:02:00.000Z',
            '2026-04-10T00:02:00.000Z',
            null,
            null,
          ),
      ).toThrow(
        /parent_handoff_id must reference the previous attempt handoff of the same turn/,
      );
    } finally {
      database.close();
    }
  });

  it('rejects direct inserts when continuation_handoff_id does not belong to the same attempt', () => {
    const database = new Database(':memory:');

    try {
      initializeDatabaseSchema(database);

      const otherTurnId =
        'other-continuation-handoff-turn:2026-04-10T00:00:00.000Z:reviewer-turn';
      insertPairedTurnIdentityRow(database, {
        turnId: otherTurnId,
        taskId: 'other-continuation-handoff-task',
        taskUpdatedAt: '2026-04-10T00:00:00.000Z',
        role: 'reviewer',
        intentKind: 'reviewer-turn',
        createdAt: '2026-04-10T00:00:00.000Z',
        updatedAt: '2026-04-10T00:00:30.000Z',
      });
      database
        .prepare(
          `
            INSERT INTO paired_turn_attempts (
              attempt_id,
              turn_id,
              attempt_no,
              task_id,
              task_updated_at,
              role,
              intent_kind,
              state,
              executor_service_id,
              executor_agent_type,
              created_at,
              updated_at,
              completed_at,
              last_error
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          buildPairedTurnAttemptId(otherTurnId, 1),
          otherTurnId,
          1,
          'other-continuation-handoff-task',
          '2026-04-10T00:00:00.000Z',
          'reviewer',
          'reviewer-turn',
          'delegated',
          CODEX_REVIEW_SERVICE_ID,
          'codex',
          '2026-04-10T00:00:00.000Z',
          '2026-04-10T00:00:30.000Z',
          null,
          null,
        );
      database
        .prepare(
          `
            INSERT INTO service_handoffs (
              chat_jid,
              group_folder,
              paired_task_id,
              paired_task_updated_at,
              turn_id,
              turn_attempt_id,
              turn_attempt_no,
              turn_intent_kind,
              turn_role,
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
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          'group@test',
          'test-group',
          'other-continuation-handoff-task',
          '2026-04-10T00:00:00.000Z',
          otherTurnId,
          buildPairedTurnAttemptId(otherTurnId, 1),
          1,
          'reviewer-turn',
          'reviewer',
          CLAUDE_SERVICE_ID,
          CODEX_REVIEW_SERVICE_ID,
          'owner',
          'claude-code',
          'reviewer',
          'codex',
          'other continuation handoff',
          'claimed',
          'reviewer',
          '2026-04-10T00:00:20.000Z',
        );
      const wrongContinuationHandoffId = (
        database.prepare('SELECT last_insert_rowid() AS id').get() as {
          id: number;
        }
      ).id;

      const turnIdentity = buildPairedTurnIdentity({
        taskId: 'trigger-continuation-handoff-task',
        taskUpdatedAt: '2026-04-10T00:00:00.000Z',
        role: 'reviewer',
        intentKind: 'reviewer-turn',
      });
      insertPairedTurnIdentityRow(database, {
        turnId: turnIdentity.turnId,
        taskId: turnIdentity.taskId,
        taskUpdatedAt: turnIdentity.taskUpdatedAt,
        role: turnIdentity.role,
        intentKind: turnIdentity.intentKind,
        createdAt: '2026-04-10T00:00:00.000Z',
        updatedAt: '2026-04-10T00:01:00.000Z',
      });

      expect(() =>
        database
          .prepare(
            `
              INSERT INTO paired_turn_attempts (
                attempt_id,
                continuation_handoff_id,
                turn_id,
                attempt_no,
                task_id,
                task_updated_at,
                role,
                intent_kind,
                state,
                executor_service_id,
                executor_agent_type,
                created_at,
                updated_at,
                completed_at,
                last_error
              )
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
          )
          .run(
            buildPairedTurnAttemptId(turnIdentity.turnId, 1),
            wrongContinuationHandoffId,
            turnIdentity.turnId,
            1,
            turnIdentity.taskId,
            turnIdentity.taskUpdatedAt,
            turnIdentity.role,
            turnIdentity.intentKind,
            'running',
            CODEX_REVIEW_SERVICE_ID,
            'codex',
            '2026-04-10T00:01:00.000Z',
            '2026-04-10T00:01:00.000Z',
            null,
            null,
          ),
      ).toThrow(
        /continuation_handoff_id must reference a handoff of the same attempt/,
      );
    } finally {
      database.close();
    }
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

  it('preserves legacy timestamp order when backfilling seq during init', () => {
    const tempDir = fs.mkdtempSync('/tmp/ejclaw-message-seq-order-');
    const dbPath = path.join(tempDir, 'messages.db');
    const legacyDb = new Database(dbPath);

    legacyDb.exec(`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        chat_jid TEXT NOT NULL,
        sender TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        is_from_me INTEGER NOT NULL DEFAULT 0,
        is_bot_message INTEGER NOT NULL DEFAULT 0,
        seq INTEGER
      );
    `);

    legacyDb
      .prepare(
        `INSERT INTO messages (
          id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, seq
        ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, NULL)`,
      )
      .run(
        'legacy-late',
        'dc:legacy-seq',
        'user-1',
        'User One',
        'late insert',
        '2024-01-01T00:00:02.000Z',
      );
    legacyDb
      .prepare(
        `INSERT INTO messages (
          id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, seq
        ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, NULL)`,
      )
      .run(
        'legacy-early',
        'dc:legacy-seq',
        'user-2',
        'User Two',
        'early insert',
        '2024-01-01T00:00:01.000Z',
      );
    legacyDb.close();

    _initTestDatabaseFromFile(dbPath);

    expect(
      getMessagesSinceSeq('dc:legacy-seq', 0, 'Andy').map((message) => ({
        id: message.id,
        seq: message.seq,
      })),
    ).toEqual([
      { id: 'legacy-early', seq: 1 },
      { id: 'legacy-late', seq: 2 },
    ]);
  });

  it('backfills missing legacy seq values after the existing maximum without duplicates', () => {
    const tempDir = fs.mkdtempSync('/tmp/ejclaw-message-seq-partial-');
    const dbPath = path.join(tempDir, 'messages.db');
    const legacyDb = new Database(dbPath);

    legacyDb.exec(`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        chat_jid TEXT NOT NULL,
        sender TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        is_from_me INTEGER NOT NULL DEFAULT 0,
        is_bot_message INTEGER NOT NULL DEFAULT 0,
        seq INTEGER
      );
    `);

    legacyDb
      .prepare(
        `INSERT INTO messages (
          id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, seq
        ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)`,
      )
      .run(
        'legacy-existing-seq',
        'dc:legacy-partial-seq',
        'user-1',
        'User One',
        'existing seq',
        '2024-01-01T00:00:01.000Z',
        1,
      );
    legacyDb
      .prepare(
        `INSERT INTO messages (
          id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, seq
        ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, NULL)`,
      )
      .run(
        'legacy-missing-seq',
        'dc:legacy-partial-seq',
        'user-2',
        'User Two',
        'missing seq',
        '2024-01-01T00:00:00.500Z',
      );
    legacyDb.close();

    _initTestDatabaseFromFile(dbPath);

    expect(
      getMessagesSinceSeq('dc:legacy-partial-seq', 0, 'Andy').map(
        (message) => ({
          id: message.id,
          seq: message.seq,
        }),
      ),
    ).toEqual([
      { id: 'legacy-existing-seq', seq: 1 },
      { id: 'legacy-missing-seq', seq: 2 },
    ]);
  });

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
