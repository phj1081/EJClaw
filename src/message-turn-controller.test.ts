import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./logger.js', () => {
  const mockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: (_bindings?: Record<string, unknown>) => mockLogger,
  };
  return {
    logger: mockLogger,
    createScopedLogger: (_bindings?: Record<string, unknown>) => mockLogger,
  };
});

import { MessageTurnController } from './message-turn-controller.js';
import { logger } from './logger.js';
import type { Channel, RegisteredGroup } from './types.js';
import type { PairedTurnIdentity } from './paired-turn-identity.js';

function makeGroup(): RegisteredGroup {
  return {
    name: 'Test Group',
    folder: 'test-group',
    trigger: '@Andy',
    added_at: new Date().toISOString(),
    requiresTrigger: false,
    agentType: 'claude-code',
  };
}

function makeChannel(): Channel {
  return {
    name: 'discord-review',
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn(() => true),
    ownsJid: vi.fn(() => true),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendAndTrack: vi.fn().mockResolvedValue('progress-1'),
    editMessage: vi.fn().mockResolvedValue(undefined),
    setTyping: vi.fn().mockResolvedValue(undefined),
    getOutboundAuditMeta: vi.fn(() => ({
      channelName: 'discord-review',
      botUserId: 'bot-review',
      botUsername: 'reviewer-bot',
    })),
  };
}

function makeTurnIdentity(): PairedTurnIdentity {
  return {
    turnId: 'task-1:2026-04-10T14:22:00.000Z:reviewer-turn',
    taskId: 'task-1',
    taskUpdatedAt: '2026-04-10T14:22:00.000Z',
    intentKind: 'reviewer-turn',
    role: 'reviewer',
  };
}

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function getAuditEntries(): Array<Record<string, unknown>> {
  return vi
    .mocked(logger.info)
    .mock.calls.map(([payload]) => payload)
    .filter(
      (payload): payload is Record<string, unknown> =>
        !!payload && typeof payload === 'object' && 'auditEvent' in payload,
    );
}

describe('MessageTurnController outbound audit logging', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('logs outbound progress and final audit context with role/service/turn metadata', async () => {
    const channel = makeChannel();
    const deliverFinalText = vi.fn().mockResolvedValue(true);
    const controller = new MessageTurnController({
      chatJid: 'dc:test-room',
      group: makeGroup(),
      runId: 'run-review-1',
      channel,
      idleTimeout: 1_000,
      failureFinalText: '실패',
      isClaudeCodeAgent: true,
      clearSession: vi.fn(),
      requestClose: vi.fn(),
      deliverFinalText,
      deliveryRole: 'reviewer',
      deliveryServiceId: 'codex-review',
      pairedTurnIdentity: makeTurnIdentity(),
    });

    await controller.start();
    await controller.handleOutput({
      status: 'success',
      phase: 'progress',
      result: '첫 진행 상황',
    } as any);
    await controller.handleOutput({
      status: 'success',
      phase: 'progress',
      result: '둘째 진행 상황',
    } as any);
    await flushAsync();
    await controller.handleOutput({
      status: 'success',
      phase: 'final',
      result: '최종 답변',
    } as any);
    await controller.finish('success');

    expect(channel.sendAndTrack).toHaveBeenCalledTimes(1);
    expect(channel.editMessage).toHaveBeenCalledWith(
      'dc:test-room',
      'progress-1',
      expect.stringContaining('둘째 진행 상황'),
    );
    expect(deliverFinalText).toHaveBeenCalledWith('최종 답변');

    expect(getAuditEntries()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          auditEvent: 'progress-create',
          chatJid: 'dc:test-room',
          runId: 'run-review-1',
          deliveryRole: 'reviewer',
          serviceId: 'codex-review',
          turnId: 'task-1:2026-04-10T14:22:00.000Z:reviewer-turn',
          turnRole: 'reviewer',
          channelName: 'discord-review',
          botUserId: 'bot-review',
          botUsername: 'reviewer-bot',
          messageId: 'progress-1',
        }),
        expect.objectContaining({
          auditEvent: 'progress-edit',
          deliveryRole: 'reviewer',
          serviceId: 'codex-review',
          turnId: 'task-1:2026-04-10T14:22:00.000Z:reviewer-turn',
          messageId: 'progress-1',
        }),
        expect.objectContaining({
          auditEvent: 'final-delivery-attempt',
          deliveryRole: 'reviewer',
          serviceId: 'codex-review',
          turnId: 'task-1:2026-04-10T14:22:00.000Z:reviewer-turn',
        }),
        expect.objectContaining({
          auditEvent: 'final-delivery-result',
          deliveryRole: 'reviewer',
          serviceId: 'codex-review',
          turnId: 'task-1:2026-04-10T14:22:00.000Z:reviewer-turn',
          delivered: true,
        }),
      ]),
    );
  });

  it('logs fallback progress audit when tracked message creation fails', async () => {
    const channel = makeChannel();
    const deliverFinalText = vi.fn().mockResolvedValue(true);
    vi.mocked(channel.sendAndTrack!).mockRejectedValueOnce(
      new Error('send failed'),
    );

    const controller = new MessageTurnController({
      chatJid: 'dc:test-room',
      group: makeGroup(),
      runId: 'run-review-fallback',
      channel,
      idleTimeout: 1_000,
      failureFinalText: '실패',
      isClaudeCodeAgent: true,
      clearSession: vi.fn(),
      requestClose: vi.fn(),
      deliverFinalText,
      deliveryRole: 'reviewer',
      deliveryServiceId: 'codex-review',
      pairedTurnIdentity: makeTurnIdentity(),
    });

    await controller.start();
    await controller.handleOutput({
      status: 'success',
      phase: 'progress',
      result: '첫 진행 상황',
    } as any);
    await controller.handleOutput({
      status: 'success',
      phase: 'progress',
      result: '둘째 진행 상황',
    } as any);
    await flushAsync();
    await controller.finish('success');

    expect(channel.sendMessage).toHaveBeenCalledWith(
      'dc:test-room',
      expect.stringContaining('첫 진행 상황'),
    );
    expect(getAuditEntries()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          auditEvent: 'progress-fallback-send',
          chatJid: 'dc:test-room',
          runId: 'run-review-fallback',
          deliveryRole: 'reviewer',
          serviceId: 'codex-review',
          turnId: 'task-1:2026-04-10T14:22:00.000Z:reviewer-turn',
          channelName: 'discord-review',
          botUserId: 'bot-review',
          messageId: null,
          fallbackReason: 'tracked-send-error',
        }),
      ]),
    );
  });

  it('does not replay the last progress message as a final delivery for paired reviewer turns', async () => {
    const channel = makeChannel();
    const deliverFinalText = vi.fn().mockResolvedValue(true);
    const controller = new MessageTurnController({
      chatJid: 'dc:test-room',
      group: makeGroup(),
      runId: 'run-review-no-fake-final',
      channel,
      idleTimeout: 1_000,
      failureFinalText: '실패',
      isClaudeCodeAgent: true,
      clearSession: vi.fn(),
      requestClose: vi.fn(),
      deliverFinalText,
      allowProgressReplayWithoutFinal: false,
      deliveryRole: 'reviewer',
      deliveryServiceId: 'codex-review',
      pairedTurnIdentity: makeTurnIdentity(),
    });

    await controller.start();
    await controller.handleOutput({
      status: 'success',
      phase: 'progress',
      result: '확인하겠습니다.',
    } as any);
    await controller.handleOutput({
      status: 'success',
      phase: 'progress',
      result: '근거를 다시 대조 중입니다.',
    } as any);
    await flushAsync();

    const finishResult = await controller.finish('success');

    expect(finishResult.visiblePhase).toBe('progress');
    expect(channel.sendAndTrack).toHaveBeenCalledTimes(1);
    expect(channel.editMessage).toHaveBeenCalledWith(
      'dc:test-room',
      'progress-1',
      expect.stringContaining('확인하겠습니다.'),
    );
    expect(deliverFinalText).not.toHaveBeenCalled();
    expect(getAuditEntries()).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          auditEvent: 'final-delivery-attempt',
        }),
      ]),
    );
  });

  it('suppresses replaying the last progress update as final when final delivery is disallowed', async () => {
    const channel = makeChannel();
    const deliverFinalText = vi.fn().mockResolvedValue(true);
    const controller = new MessageTurnController({
      chatJid: 'dc:test-room',
      group: makeGroup(),
      runId: 'run-stale-owner-attempt',
      channel,
      idleTimeout: 1_000,
      failureFinalText: '실패',
      isClaudeCodeAgent: true,
      clearSession: vi.fn(),
      requestClose: vi.fn(),
      deliverFinalText,
      canDeliverFinalText: () => false,
      allowProgressReplayWithoutFinal: true,
      deliveryRole: 'owner',
      pairedTurnIdentity: {
        turnId: 'paired-task:2026-04-10T00:00:00.000Z:finalize-owner-turn',
        taskId: 'paired-task',
        taskUpdatedAt: '2026-04-10T00:00:00.000Z',
        intentKind: 'finalize-owner-turn',
        role: 'owner',
      },
    });

    await controller.start();
    await controller.handleOutput({
      status: 'success',
      phase: 'progress',
      result: '작업 중 1',
      output: { visibility: 'public', text: '작업 중 1' },
    } as any);
    await controller.handleOutput({
      status: 'success',
      phase: 'progress',
      result: '작업 중 2',
      output: { visibility: 'public', text: '작업 중 2' },
    } as any);
    await flushAsync();

    const finishResult = await controller.finish('success');

    expect(finishResult.deliverySucceeded).toBe(true);
    expect(channel.sendAndTrack).toHaveBeenCalledTimes(1);
    expect(deliverFinalText).not.toHaveBeenCalled();
    expect(getAuditEntries()).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          auditEvent: 'final-delivery-attempt',
        }),
      ]),
    );
  });
});
