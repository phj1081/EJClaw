import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config.js', () => ({
  STATUS_CHANNEL_ID: 'status-channel',
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
  },
}));

const readDashboardStatusMessageIdMock = vi.hoisted(() =>
  vi.fn(() => 'dashboard-current'),
);

vi.mock('../status-dashboard.js', () => ({
  readDashboardStatusMessageId: readDashboardStatusMessageIdMock,
}));

import {
  deleteOwnDashboardDuplicateOnCreate,
  isDashboardTrackedSend,
} from './discord-dashboard-create-cleanup.js';

function makeDashboardMessage(overrides: {
  id?: string;
  channelId?: string;
  content?: string;
}) {
  return {
    id: overrides.id ?? 'dashboard-stale',
    channelId: overrides.channelId ?? 'status-channel',
    content: overrides.content ?? '🤖 *모델 구성*\nMemory 3.3/91.4GB',
    delete: vi.fn().mockResolvedValue(undefined),
  } as any;
}

describe('discord dashboard create cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readDashboardStatusMessageIdMock.mockReturnValue('dashboard-current');
  });

  it('detects tracked dashboard sends', () => {
    expect(
      isDashboardTrackedSend(
        'dc:status-channel',
        '🤖 *모델 구성*\nMemory 7.5/251.7GB',
      ),
    ).toBe(true);
    expect(isDashboardTrackedSend('dc:other', '🤖 *모델 구성*')).toBe(false);
    expect(isDashboardTrackedSend('dc:status-channel', 'normal')).toBe(false);
  });

  it('deletes stale own dashboard messages on create event', async () => {
    const msg = makeDashboardMessage({ id: 'dashboard-stale' });

    await deleteOwnDashboardDuplicateOnCreate({
      message: msg,
      channelName: 'discord',
      graceUntil: 0,
      now: 100,
    });

    expect(msg.delete).toHaveBeenCalledTimes(1);
  });

  it('keeps the tracked dashboard message', async () => {
    const msg = makeDashboardMessage({ id: 'dashboard-current' });

    await deleteOwnDashboardDuplicateOnCreate({
      message: msg,
      channelName: 'discord',
      graceUntil: 0,
      now: 100,
    });

    expect(msg.delete).not.toHaveBeenCalled();
  });

  it('keeps dashboard messages during tracked send grace period', async () => {
    const msg = makeDashboardMessage({ id: 'dashboard-new' });

    await deleteOwnDashboardDuplicateOnCreate({
      message: msg,
      channelName: 'discord',
      graceUntil: 200,
      now: 100,
    });

    expect(msg.delete).not.toHaveBeenCalled();
  });
});
