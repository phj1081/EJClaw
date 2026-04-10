import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RegisteredGroup } from './types.js';

const { handleSessionCommandMock } = vi.hoisted(() => ({
  handleSessionCommandMock: vi.fn(),
}));

vi.mock('./session-commands.js', () => ({
  handleSessionCommand: handleSessionCommandMock,
}));

import { handleQueuedRunGates } from './message-runtime-gating.js';

describe('message-runtime-gating', () => {
  const baseArgs = {
    chatJid: 'room-1',
    group: {
      folder: 'room-folder',
      name: 'room',
      isMain: false,
      trigger: '코덱스',
      added_at: new Date().toISOString(),
    } satisfies RegisteredGroup,
    runId: 'run-1',
    missedMessages: [],
    triggerPattern: /^코덱스/,
    timezone: 'Asia/Seoul',
    hasImplicitContinuationWindow: () => false,
    sessionCommandDeps: {} as never,
  };

  beforeEach(() => {
    handleSessionCommandMock.mockReset();
  });

  it('returns session-command results directly when a command is handled', async () => {
    handleSessionCommandMock.mockResolvedValue({
      handled: true,
      success: false,
    });

    const result = await handleQueuedRunGates(baseArgs);

    expect(result).toEqual({ handled: true, success: false });
  });

  it('falls through when no session command is handled', async () => {
    handleSessionCommandMock.mockResolvedValue({ handled: false });

    const result = await handleQueuedRunGates(baseArgs);

    expect(result).toEqual({ handled: false });
  });
});
