import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./service-routing.js', () => ({
  hasReviewerLease: vi.fn(() => false),
}));

import * as serviceRouting from './service-routing.js';
import { sendScheduledMessage } from './task-scheduler-runtime.js';

describe('scheduled message delivery identity', () => {
  beforeEach(() => {
    vi.mocked(serviceRouting.hasReviewerLease).mockReturnValue(false);
  });

  it('uses the default owner identity for owner output in paired rooms', async () => {
    vi.mocked(serviceRouting.hasReviewerLease).mockReturnValue(true);
    const sendMessage = vi.fn(async () => {});
    const sendMessageViaReviewerBot = vi.fn(async () => {});

    await sendScheduledMessage(
      { sendMessage, sendMessageViaReviewerBot } as any,
      'paired@g.us',
      'owner watcher done',
      'owner',
    );

    expect(sendMessage).toHaveBeenCalledWith(
      'paired@g.us',
      'owner watcher done',
    );
    expect(sendMessageViaReviewerBot).not.toHaveBeenCalled();
  });

  it('uses the reviewer identity for claude output in paired rooms', async () => {
    vi.mocked(serviceRouting.hasReviewerLease).mockReturnValue(true);
    const sendMessage = vi.fn(async () => {});
    const sendMessageViaReviewerBot = vi.fn(async () => {});

    await sendScheduledMessage(
      { sendMessage, sendMessageViaReviewerBot } as any,
      'paired@g.us',
      'reviewer watcher done',
      'reviewer',
    );

    expect(sendMessageViaReviewerBot).toHaveBeenCalledWith(
      'paired@g.us',
      'reviewer watcher done',
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('fails closed for reviewer output when the reviewer bot is missing', async () => {
    vi.mocked(serviceRouting.hasReviewerLease).mockReturnValue(true);
    const sendMessage = vi.fn(async () => {});

    await expect(
      sendScheduledMessage(
        { sendMessage } as any,
        'paired@g.us',
        'reviewer watcher done',
        'reviewer',
      ),
    ).rejects.toThrow(/reviewer Discord bot/);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
