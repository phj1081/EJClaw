import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RegisteredGroup } from './types.js';

const {
  handleSessionCommandMock,
  hasAllowedTriggerMock,
  loggerInfoMock,
} = vi.hoisted(() => ({
  handleSessionCommandMock: vi.fn(),
  hasAllowedTriggerMock: vi.fn(),
  loggerInfoMock: vi.fn(),
}));

vi.mock('./session-commands.js', () => ({
  handleSessionCommand: handleSessionCommandMock,
}));

vi.mock('./message-runtime-rules.js', () => ({
  hasAllowedTrigger: hasAllowedTriggerMock,
}));

vi.mock('./logger.js', () => ({
  logger: {
    info: loggerInfoMock,
  },
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
    hasAllowedTriggerMock.mockReset();
    loggerInfoMock.mockReset();
  });

  it('returns session-command results directly when a command is handled', async () => {
    handleSessionCommandMock.mockResolvedValue({
      handled: true,
      success: false,
    });

    const result = await handleQueuedRunGates(baseArgs);

    expect(result).toEqual({ handled: true, success: false });
    expect(hasAllowedTriggerMock).not.toHaveBeenCalled();
  });

  it('treats missing triggers as a handled no-op', async () => {
    handleSessionCommandMock.mockResolvedValue({ handled: false });
    hasAllowedTriggerMock.mockReturnValue(false);

    const result = await handleQueuedRunGates(baseArgs);

    expect(result).toEqual({ handled: true, success: true });
    expect(loggerInfoMock).toHaveBeenCalledWith(
      { chatJid: 'room-1', group: 'room', runId: 'run-1' },
      'Skipping queued run because no allowed trigger was found',
    );
  });

  it('falls through when no session command is handled and the trigger is allowed', async () => {
    handleSessionCommandMock.mockResolvedValue({ handled: false });
    hasAllowedTriggerMock.mockReturnValue(true);

    const result = await handleQueuedRunGates(baseArgs);

    expect(result).toEqual({ handled: false });
    expect(loggerInfoMock).not.toHaveBeenCalled();
  });
});
