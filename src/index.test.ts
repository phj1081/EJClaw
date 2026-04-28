import { describe, expect, it, vi } from 'vitest';

import {
  editFormattedTrackedChannelMessage,
  isTerminalStatusMessage,
  sendFormattedTrackedChannelMessage,
} from './index.js';
import { composeDashboardContent } from './dashboard-render.js';
import { Channel } from './types.js';

function makeChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    name: 'test',
    connect: async () => {},
    sendMessage: async () => {},
    isConnected: () => true,
    ownsJid: (jid: string) => jid === 'dc:test',
    disconnect: async () => {},
    ...overrides,
  };
}

describe('index scheduler messaging helpers', () => {
  it('uses the paired verdict parser to detect terminal status messages', () => {
    expect(isTerminalStatusMessage('DONE\nfinished')).toBe(true);
    expect(
      isTerminalStatusMessage('**DONE_WITH_CONCERNS**\nneed follow-up'),
    ).toBe(true);
    expect(isTerminalStatusMessage('Approved.\nlooks good')).toBe(true);
    expect(isTerminalStatusMessage('LGTM\nship it')).toBe(true);
    expect(isTerminalStatusMessage('random prose only')).toBe(false);
  });

  it('sends formatted tracked messages through sendAndTrack', async () => {
    const sendAndTrack = vi.fn(async () => 'msg-123');
    const channel = makeChannel({ sendAndTrack });

    const messageId = await sendFormattedTrackedChannelMessage(
      [channel],
      'dc:test',
      '<internal>hidden</internal>watching ci',
    );

    expect(messageId).toBe('msg-123');
    expect(sendAndTrack).toHaveBeenCalledWith('dc:test', 'watching ci');
  });

  it('edits formatted tracked messages through editMessage', async () => {
    const editMessage = vi.fn(async () => {});
    const channel = makeChannel({ editMessage });

    await editFormattedTrackedChannelMessage(
      [channel],
      'dc:test',
      'msg-123',
      '<internal>hidden</internal>still watching',
    );

    expect(editMessage).toHaveBeenCalledWith(
      'dc:test',
      'msg-123',
      'still watching',
    );
  });

  it('skips empty messages after formatting', async () => {
    const sendMessage = vi.fn(async () => {});
    const sendAndTrack = vi.fn(async () => 'msg-123');
    const editMessage = vi.fn(async () => {});
    const channel = makeChannel({ sendMessage, sendAndTrack, editMessage });

    const trackedResult = await sendFormattedTrackedChannelMessage(
      [channel],
      'dc:test',
      '<internal>only hidden</internal>',
    );
    await editFormattedTrackedChannelMessage(
      [channel],
      'dc:test',
      'msg-123',
      '<internal>only hidden</internal>',
    );
    expect(trackedResult).toBeNull();
    expect(sendAndTrack).not.toHaveBeenCalled();
    expect(editMessage).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe('composeDashboardContent', () => {
  it('returns an empty string when all dashboard sections are disabled', () => {
    expect(
      composeDashboardContent([], new Date('2026-03-23T04:00:00+09:00')),
    ).toBe('');
  });

  it('keeps non-status sections when room status is hidden', () => {
    const content = composeDashboardContent(
      ['**사용량**\nCodex OK'],
      new Date('2026-03-23T04:00:00+09:00'),
    );

    expect(content).toContain('**사용량**');
    expect(content).not.toContain('**📊 에이전트 상태**');
  });
});
