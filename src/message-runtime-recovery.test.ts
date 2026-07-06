import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./agent-runner.js', async () => {
  const mocks = await import('../test/helpers/message-runtime-mocks.js');
  return mocks.createAgentRunnerMock();
});

vi.mock('./config.js', async () => {
  const mocks = await import('../test/helpers/message-runtime-mocks.js');
  return mocks.createConfigMock();
});

vi.mock('./paired-execution-context.js', async () => {
  const mocks = await import('../test/helpers/message-runtime-mocks.js');
  return mocks.createPairedExecutionContextMock();
});

vi.mock('./db.js', async () => {
  const mocks = await import('../test/helpers/message-runtime-mocks.js');
  return mocks.createDbMock();
});

vi.mock('./service-routing.js', async () => {
  const mocks = await import('../test/helpers/message-runtime-mocks.js');
  return mocks.createServiceRoutingMock();
});

vi.mock('./logger.js', async () => {
  const mocks = await import('../test/helpers/message-runtime-mocks.js');
  return mocks.createLoggerMock();
});

vi.mock('./sender-allowlist.js', async () => {
  const mocks = await import('../test/helpers/message-runtime-mocks.js');
  return mocks.createSenderAllowlistMock();
});

vi.mock('./session-commands.js', async () => {
  const mocks = await import('../test/helpers/message-runtime-mocks.js');
  return mocks.createSessionCommandsMock();
});

import * as config from './config.js';
import * as db from './db.js';
import { resolveGroupIpcPath } from './group-folder.js';
import { createMessageRuntime } from './message-runtime.js';
import { resetPairedFollowUpScheduleState } from './paired-follow-up-scheduler.js';
import * as serviceRouting from './service-routing.js';
import {
  makeChannel,
  makeGroup,
} from '../test/helpers/message-runtime-fixtures.js';

beforeEach(() => {
  vi.resetAllMocks();
  resetPairedFollowUpScheduleState();
  vi.mocked(db.getLastBotFinalMessage).mockReturnValue([]);
  vi.mocked(serviceRouting.hasReviewerLease).mockReturnValue(false);
  vi.mocked(db.getRecentChatMessages).mockReturnValue([]);
  vi.mocked(config.isClaudeService).mockReturnValue(true);
  vi.mocked(config.isReviewService).mockReturnValue(false);
});

describe('createMessageRuntime recovery of open work items', () => {
  it('recovery queues a group when an open work item is waiting for delivery', () => {
    const chatJid = 'group@test';
    const group = makeGroup('claude-code');
    const enqueueMessageCheck = vi.fn();
    const enqueueTask = vi.fn();

    vi.mocked(db.getOpenWorkItem).mockReturnValue({
      id: 99,
      group_folder: group.folder,
      chat_jid: chatJid,
      agent_type: 'claude-code',
      service_id: 'claude',
      status: 'produced',
      start_seq: 1,
      end_seq: 1,
      result_payload: '미전달 결과',
      delivery_attempts: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      delivered_at: null,
      delivery_message_id: null,
      last_error: null,
    });

    const runtime = createMessageRuntime({
      assistantName: 'Andy',
      idleTimeout: 1_000,
      pollInterval: 1_000,
      timezone: 'UTC',
      triggerPattern: /^@Andy\b/i,
      channels: [makeChannel(chatJid)],
      queue: {
        registerProcess: vi.fn(),
        closeStdin: vi.fn(),
        notifyIdle: vi.fn(),
        enqueueMessageCheck,
        enqueueTask,
      } as any,
      getRoomBindings: () => ({ [chatJid]: group }),
      getSessions: () => ({}),
      getLastTimestamp: () => '',
      setLastTimestamp: vi.fn(),
      getLastAgentTimestamps: () => ({}),
      saveState: vi.fn(),
      persistSession: vi.fn(),
      clearSession: vi.fn(),
    });

    runtime.recoverPendingMessages();

    expect(enqueueMessageCheck).toHaveBeenCalledWith(
      chatJid,
      resolveGroupIpcPath(group.folder),
    );
    expect(enqueueTask).not.toHaveBeenCalled();
    expect(db.getMessagesSinceSeq).not.toHaveBeenCalled();
  });

  it('recovery also queues fallback delivery retries across agent types', () => {
    const chatJid = 'group@test';
    const group = makeGroup('claude-code');
    const enqueueMessageCheck = vi.fn();
    const enqueueTask = vi.fn();

    vi.mocked(db.getOpenWorkItem).mockReturnValue(undefined);
    vi.mocked(db.getOpenWorkItemForChat).mockReturnValue({
      id: 199,
      group_folder: group.folder,
      chat_jid: chatJid,
      agent_type: 'codex',
      service_id: 'codex-review',
      delivery_role: 'reviewer',
      status: 'delivery_retry',
      start_seq: 5,
      end_seq: 6,
      result_payload: '미전달 reviewer 결과',
      delivery_attempts: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      delivered_at: null,
      delivery_message_id: null,
      last_error: 'discord send failed',
    });

    const runtime = createMessageRuntime({
      assistantName: 'Andy',
      idleTimeout: 1_000,
      pollInterval: 1_000,
      timezone: 'UTC',
      triggerPattern: /^@Andy\b/i,
      channels: [makeChannel(chatJid)],
      queue: {
        registerProcess: vi.fn(),
        closeStdin: vi.fn(),
        notifyIdle: vi.fn(),
        enqueueMessageCheck,
        enqueueTask,
      } as any,
      getRoomBindings: () => ({ [chatJid]: group }),
      getSessions: () => ({}),
      getLastTimestamp: () => '',
      setLastTimestamp: vi.fn(),
      getLastAgentTimestamps: () => ({}),
      saveState: vi.fn(),
      persistSession: vi.fn(),
      clearSession: vi.fn(),
    });

    runtime.recoverPendingMessages();

    expect(db.getOpenWorkItemForChat).toHaveBeenCalledWith(chatJid, 'claude');
    expect(enqueueMessageCheck).toHaveBeenCalledWith(
      chatJid,
      resolveGroupIpcPath(group.folder),
    );
    expect(enqueueTask).not.toHaveBeenCalled();
    expect(db.getMessagesSinceSeq).not.toHaveBeenCalled();
  });
});
