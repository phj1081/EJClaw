import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  createProducedWorkItem,
  getOpenWorkItem,
  getRecentDeliveredWorkItemsForChat,
  markWorkItemDelivered,
} from './db.js';

beforeEach(() => {
  _initTestDatabase();
});

describe('work item canonical output queue', () => {
  it('supersedes stale open work items before creating a newer canonical output', () => {
    const stale = createProducedWorkItem({
      group_folder: 'discord_test',
      chat_jid: 'dc:supersede',
      agent_type: 'codex',
      service_id: 'codex-main',
      delivery_role: 'owner',
      start_seq: 1,
      end_seq: 2,
      result_payload: 'stale owner output',
    });
    const fresh = createProducedWorkItem({
      group_folder: 'discord_test',
      chat_jid: 'dc:supersede',
      agent_type: 'codex',
      service_id: 'codex-main',
      delivery_role: 'owner',
      start_seq: 3,
      end_seq: 4,
      result_payload: 'fresh owner output',
    });

    expect(fresh.id).not.toBe(stale.id);
    expect(getOpenWorkItem('dc:supersede', 'codex', 'codex-main')?.id).toBe(
      fresh.id,
    );

    markWorkItemDelivered(fresh.id, 'discord-message-id');
    expect(getRecentDeliveredWorkItemsForChat('dc:supersede', 10)).toEqual([
      expect.objectContaining({
        id: fresh.id,
        result_payload: 'fresh owner output',
      }),
    ]);
  });
});
