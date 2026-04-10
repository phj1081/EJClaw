import { describe, expect, it } from 'vitest';

import {
  getInterruptedRecoveryCandidates,
  type RestartContext,
} from './restart-context.js';
import type { RegisteredGroup } from './types.js';

function makeGroup(folder: string): RegisteredGroup {
  return {
    name: folder,
    folder,
    trigger: '@Andy',
    added_at: new Date().toISOString(),
    requiresTrigger: false,
  };
}

describe('getInterruptedRecoveryCandidates', () => {
  it('returns only registered interrupted groups and deduplicates by chatJid', () => {
    const roomBindings: Record<string, RegisteredGroup> = {
      'dc:1': makeGroup('group-one'),
      'dc:2': makeGroup('group-two'),
    };

    const context: RestartContext = {
      chatJid: 'dc:main',
      summary: 'restart',
      verify: [],
      writtenAt: new Date().toISOString(),
      interruptedGroups: [
        {
          chatJid: 'dc:1',
          groupName: 'one',
          status: 'processing',
          elapsedMs: 1000,
          pendingMessages: true,
          pendingTasks: 0,
        },
        {
          chatJid: 'dc:1',
          groupName: 'one-duplicate',
          status: 'waiting',
          elapsedMs: null,
          pendingMessages: false,
          pendingTasks: 1,
        },
        {
          chatJid: 'dc:2',
          groupName: 'two',
          status: 'idle',
          elapsedMs: null,
          pendingMessages: false,
          pendingTasks: 0,
        },
        {
          chatJid: 'dc:3',
          groupName: 'missing',
          status: 'processing',
          elapsedMs: 500,
          pendingMessages: true,
          pendingTasks: 0,
        },
      ],
    };

    expect(getInterruptedRecoveryCandidates(context, roomBindings)).toEqual([
      {
        chatJid: 'dc:1',
        groupFolder: 'group-one',
        status: 'processing',
        pendingMessages: true,
        pendingTasks: 0,
      },
      {
        chatJid: 'dc:2',
        groupFolder: 'group-two',
        status: 'idle',
        pendingMessages: false,
        pendingTasks: 0,
      },
    ]);
  });

  it('returns empty when there is no explicit restart context', () => {
    expect(getInterruptedRecoveryCandidates(null, {})).toEqual([]);
  });
});
