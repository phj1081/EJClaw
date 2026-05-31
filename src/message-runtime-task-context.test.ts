import { beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase, storeChatMetadata, storeMessage } from './db.js';
import { getTaskContextMessages } from './message-runtime-task-context.js';
import type { NewMessage, PairedTask } from './types.js';

function makeMessage(
  content: string,
  timestamp: string,
  overrides: Partial<NewMessage> = {},
): NewMessage {
  return {
    id: `msg-${content}`,
    chat_jid: 'group@test',
    sender: 'user@test',
    sender_name: 'User',
    content,
    timestamp,
    is_from_me: false,
    is_bot_message: false,
    ...overrides,
  };
}

function makeTask(overrides: Partial<PairedTask> = {}): PairedTask {
  return {
    id: 'task-context',
    chat_jid: 'group@test',
    group_folder: 'group',
    owner_service_id: 'codex-main',
    reviewer_service_id: 'claude',
    owner_agent_type: 'codex',
    reviewer_agent_type: 'claude-code',
    arbiter_agent_type: 'codex',
    title: null,
    source_ref: null,
    plan_notes: null,
    review_requested_at: null,
    round_trip_count: 1,
    owner_failure_count: 0,
    owner_step_done_streak: 0,
    finalize_step_done_count: 0,
    task_done_then_user_reopen_count: 0,
    empty_step_done_streak: 0,
    status: 'review_ready',
    arbiter_verdict: null,
    arbiter_requested_at: null,
    completion_reason: null,
    created_at: '2026-04-20T00:00:00.000Z',
    updated_at: '2026-04-20T00:30:00.000Z',
    ...overrides,
  };
}

describe('message runtime task context', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('keeps the original task request even after it falls outside the recent 20 messages', () => {
    storeChatMetadata(
      'group@test',
      'Test Group',
      '2026-04-20T00:00:00.000Z',
      'discord',
      true,
    );
    storeMessage(makeMessage('원래 사용자 요청', '2026-04-20T00:00:01.000Z'));
    for (let index = 0; index < 25; index += 1) {
      storeMessage(
        makeMessage(
          `후속 노이즈 ${index}`,
          `2026-04-20T00:${String(index + 2).padStart(2, '0')}:00.000Z`,
          { id: `noise-${index}`, is_bot_message: index % 2 === 0 },
        ),
      );
    }

    const messages = getTaskContextMessages('group@test', makeTask());

    expect(messages.map((message) => message.content)).toContain(
      '원래 사용자 요청',
    );
  });
});
