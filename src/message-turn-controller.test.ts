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
    expect(channel.sendAndTrack).toHaveBeenCalledWith(
      'dc:test-room',
      expect.stringContaining('첫 진행 상황'),
    );
    expect(channel.editMessage).not.toHaveBeenCalled();
    expect(deliverFinalText).toHaveBeenCalledWith('최종 답변', {
      replaceMessageId: 'progress-1',
    });

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
          auditEvent: 'final-delivery-attempt',
          deliveryRole: 'reviewer',
          serviceId: 'codex-review',
          turnId: 'task-1:2026-04-10T14:22:00.000Z:reviewer-turn',
          messageId: 'progress-1',
          deliveryMode: 'edit',
        }),
        expect.objectContaining({
          auditEvent: 'final-delivery-result',
          deliveryRole: 'reviewer',
          serviceId: 'codex-review',
          turnId: 'task-1:2026-04-10T14:22:00.000Z:reviewer-turn',
          messageId: 'progress-1',
          deliveryMode: 'edit',
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

  it('does not flush pending progress before final delivery for paired reviewer turns', async () => {
    const channel = makeChannel();
    const deliverFinalText = vi.fn().mockResolvedValue(true);
    const controller = new MessageTurnController({
      chatJid: 'dc:test-room',
      group: makeGroup(),
      runId: 'run-review-no-pending-flush',
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
      result: '오너가 대화와 관련 코드 근거를 대조해서 판정을 내리겠습니다.',
    } as any);

    await controller.handleOutput({
      status: 'success',
      phase: 'final',
      result: 'PROCEED 근거를 확인했습니다.',
    } as any);
    await controller.finish('success');

    expect(channel.sendAndTrack).not.toHaveBeenCalled();
    expect(channel.sendMessage).not.toHaveBeenCalled();
    expect(deliverFinalText).toHaveBeenCalledTimes(1);
    expect(deliverFinalText).toHaveBeenCalledWith(
      'PROCEED 근거를 확인했습니다.',
      {
        replaceMessageId: null,
      },
    );
  });

  it('passes structured final attachments to final delivery', async () => {
    const channel = makeChannel();
    const deliverFinalText = vi.fn().mockResolvedValue(true);
    const attachments = [
      {
        path: '/tmp/e2e-screenshot.png',
        name: 'e2e-screenshot.png',
        mime: 'image/png',
      },
    ];
    const controller = new MessageTurnController({
      chatJid: 'dc:test-room',
      group: makeGroup(),
      runId: 'run-review-attachments',
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
      phase: 'final',
      result: '스크린샷을 첨부했습니다.',
      output: {
        visibility: 'public',
        text: '스크린샷을 첨부했습니다.',
        attachments,
      },
    } as any);
    await controller.finish('success');

    expect(deliverFinalText).toHaveBeenCalledWith('스크린샷을 첨부했습니다.', {
      replaceMessageId: null,
      attachments,
    });
    expect(getAuditEntries()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          auditEvent: 'final-delivery-attempt',
          attachmentCount: 1,
        }),
      ]),
    );
  });

  it('sends final attachments as a fresh final message instead of replacing text-only progress', async () => {
    const channel = {
      ...makeChannel(),
      name: 'discord',
    } satisfies Channel;
    const deliverFinalText = vi.fn().mockResolvedValue(true);
    const attachments = [
      {
        path: '/tmp/ejclaw-discord-image-final.png',
        name: 'final.png',
        mime: 'image/png',
      },
    ];
    const controller = new MessageTurnController({
      chatJid: 'dc:test-room',
      group: makeGroup(),
      runId: 'run-owner-final-attachment-send',
      channel,
      idleTimeout: 1_000,
      failureFinalText: '실패',
      isClaudeCodeAgent: true,
      clearSession: vi.fn(),
      requestClose: vi.fn(),
      deliverFinalText,
      deliveryRole: 'owner',
      pairedTurnIdentity: {
        turnId: 'task-1:2026-04-10T14:22:00.000Z:owner-turn',
        taskId: 'task-1',
        taskUpdatedAt: '2026-04-10T14:22:00.000Z',
        intentKind: 'finalize-owner-turn',
        role: 'owner',
      },
    });

    await controller.start();
    await controller.handleOutput({
      status: 'success',
      phase: 'progress',
      result: '이미지 렌더링 중',
    } as any);
    await controller.handleOutput({
      status: 'success',
      phase: 'progress',
      result: '이미지 파일 쓰는 중',
    } as any);
    await flushAsync();
    await controller.handleOutput({
      status: 'success',
      phase: 'final',
      result: '이미지 렌더 완료.',
      output: {
        visibility: 'public',
        text: '이미지 렌더 완료.',
        attachments,
      },
    } as any);
    await controller.finish('success');

    expect(channel.sendAndTrack).toHaveBeenCalledTimes(1);
    expect(deliverFinalText).toHaveBeenCalledWith('이미지 렌더 완료.', {
      replaceMessageId: null,
      attachments,
    });
  });

  it('replaces the tracked progress message when an owner final arrives', async () => {
    const channel = {
      ...makeChannel(),
      name: 'discord',
    } satisfies Channel;
    const deliverFinalText = vi.fn().mockResolvedValue(true);
    const controller = new MessageTurnController({
      chatJid: 'dc:test-room',
      group: makeGroup(),
      runId: 'run-owner-final-replace',
      channel,
      idleTimeout: 1_000,
      failureFinalText: '실패',
      isClaudeCodeAgent: true,
      clearSession: vi.fn(),
      requestClose: vi.fn(),
      deliverFinalText,
      deliveryRole: 'owner',
      pairedTurnIdentity: {
        turnId: 'task-1:2026-04-10T14:22:00.000Z:owner-turn',
        taskId: 'task-1',
        taskUpdatedAt: '2026-04-10T14:22:00.000Z',
        intentKind: 'finalize-owner-turn',
        role: 'owner',
      },
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
      result: 'DONE 최종 답변',
    } as any);
    await controller.finish('success');

    expect(channel.sendAndTrack).toHaveBeenCalledTimes(1);
    expect(deliverFinalText).toHaveBeenCalledWith('DONE 최종 답변', {
      replaceMessageId: 'progress-1',
    });
  });

  it('replaces the tracked progress message when finish() replays the last owner progress as final', async () => {
    const channel = {
      ...makeChannel(),
      name: 'discord',
    } satisfies Channel;
    const deliverFinalText = vi.fn().mockResolvedValue(true);
    const controller = new MessageTurnController({
      chatJid: 'dc:test-room',
      group: makeGroup(),
      runId: 'run-owner-progress-replay',
      channel,
      idleTimeout: 1_000,
      failureFinalText: '실패',
      isClaudeCodeAgent: true,
      clearSession: vi.fn(),
      requestClose: vi.fn(),
      deliverFinalText,
      deliveryRole: 'owner',
      pairedTurnIdentity: {
        turnId: 'task-1:2026-04-10T14:22:00.000Z:owner-turn',
        taskId: 'task-1',
        taskUpdatedAt: '2026-04-10T14:22:00.000Z',
        intentKind: 'finalize-owner-turn',
        role: 'owner',
      },
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

    expect(channel.sendAndTrack).toHaveBeenCalledTimes(1);
    expect(deliverFinalText).toHaveBeenCalledWith('첫 진행 상황', {
      replaceMessageId: 'progress-1',
    });
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
    expect(channel.sendAndTrack).not.toHaveBeenCalled();
    expect(channel.sendMessage).not.toHaveBeenCalled();
    expect(deliverFinalText).not.toHaveBeenCalled();
    expect(getAuditEntries()).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          auditEvent: 'final-delivery-attempt',
        }),
      ]),
    );
  });

  it('does not flush buffered progress when final delivery is disallowed for a stale owner turn', async () => {
    const channel = makeChannel();
    const deliverFinalText = vi.fn().mockResolvedValue(true);
    const controller = new MessageTurnController({
      chatJid: 'dc:test-room',
      group: makeGroup(),
      runId: 'run-stale-owner-final-with-buffered-progress',
      channel,
      idleTimeout: 1_000,
      failureFinalText: '실패',
      isClaudeCodeAgent: true,
      clearSession: vi.fn(),
      requestClose: vi.fn(),
      deliverFinalText,
      canDeliverFinalText: () => false,
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
      result: '버퍼된 진행 상황',
      output: { visibility: 'public', text: '버퍼된 진행 상황' },
    } as any);

    await controller.handleOutput({
      status: 'success',
      phase: 'final',
      result: 'DONE 최종 답변',
      output: { visibility: 'public', text: 'DONE 최종 답변' },
    } as any);

    const finishResult = await controller.finish('success');

    expect(finishResult.deliverySucceeded).toBe(true);
    expect(channel.sendAndTrack).not.toHaveBeenCalled();
    expect(channel.sendMessage).not.toHaveBeenCalled();
    expect(deliverFinalText).not.toHaveBeenCalled();
  });

  it('does not emit a tracked progress message when a stale owner turn buffers multiple progress updates', async () => {
    const channel = makeChannel();
    const deliverFinalText = vi.fn().mockResolvedValue(true);
    const controller = new MessageTurnController({
      chatJid: 'dc:test-room',
      group: makeGroup(),
      runId: 'run-stale-owner-progress-buffer',
      channel,
      idleTimeout: 1_000,
      failureFinalText: '실패',
      isClaudeCodeAgent: true,
      clearSession: vi.fn(),
      requestClose: vi.fn(),
      deliverFinalText,
      canDeliverFinalText: () => false,
      deliveryRole: 'owner',
      pairedTurnIdentity: {
        turnId: 'paired-task:2026-04-10T00:00:00.000Z:owner-turn',
        taskId: 'paired-task',
        taskUpdatedAt: '2026-04-10T00:00:00.000Z',
        intentKind: 'owner-turn',
        role: 'owner',
      },
    });

    await controller.start();
    await controller.handleOutput({
      status: 'success',
      phase: 'progress',
      result: '첫 진행 상황',
      output: { visibility: 'public', text: '첫 진행 상황' },
    } as any);
    await controller.handleOutput({
      status: 'success',
      phase: 'progress',
      result: '둘째 진행 상황',
      output: { visibility: 'public', text: '둘째 진행 상황' },
    } as any);

    const finishResult = await controller.finish('success');

    expect(finishResult.deliverySucceeded).toBe(true);
    expect(channel.sendAndTrack).not.toHaveBeenCalled();
    expect(channel.sendMessage).not.toHaveBeenCalled();
    expect(deliverFinalText).not.toHaveBeenCalled();
  });

  it('does not edit an existing tracked progress message after a stale owner turn loses delivery ownership', async () => {
    const channel = makeChannel();
    const deliverFinalText = vi.fn().mockResolvedValue(true);
    let canDeliver = true;
    const controller = new MessageTurnController({
      chatJid: 'dc:test-room',
      group: makeGroup(),
      runId: 'run-stale-owner-progress-edit',
      channel,
      idleTimeout: 1_000,
      failureFinalText: '실패',
      isClaudeCodeAgent: true,
      clearSession: vi.fn(),
      requestClose: vi.fn(),
      deliverFinalText,
      canDeliverFinalText: () => canDeliver,
      deliveryRole: 'owner',
      pairedTurnIdentity: {
        turnId: 'paired-task:2026-04-10T00:00:00.000Z:owner-turn',
        taskId: 'paired-task',
        taskUpdatedAt: '2026-04-10T00:00:00.000Z',
        intentKind: 'owner-turn',
        role: 'owner',
      },
    });

    await controller.start();
    await controller.handleOutput({
      status: 'success',
      phase: 'progress',
      result: '첫 진행 상황',
      output: { visibility: 'public', text: '첫 진행 상황' },
    } as any);
    await controller.handleOutput({
      status: 'success',
      phase: 'progress',
      result: '둘째 진행 상황',
      output: { visibility: 'public', text: '둘째 진행 상황' },
    } as any);
    await flushAsync();
    await controller.handleOutput({
      status: 'success',
      phase: 'progress',
      result: '셋째 진행 상황',
      output: { visibility: 'public', text: '셋째 진행 상황' },
    } as any);
    await flushAsync();

    expect(channel.sendAndTrack).toHaveBeenCalledTimes(1);
    expect(channel.editMessage).toHaveBeenCalledTimes(1);

    canDeliver = false;
    await controller.handleOutput({
      status: 'success',
      phase: 'progress',
      result: '넷째 진행 상황',
      output: { visibility: 'public', text: '넷째 진행 상황' },
    } as any);
    await flushAsync();

    const finishResult = await controller.finish('success');

    expect(finishResult.deliverySucceeded).toBe(true);
    expect(channel.sendAndTrack).toHaveBeenCalledTimes(1);
    expect(channel.editMessage).toHaveBeenCalledTimes(1);
    expect(channel.sendMessage).not.toHaveBeenCalled();
    expect(deliverFinalText).not.toHaveBeenCalled();
  });

  it('replaces the tracked progress message when finish() publishes a failure final', async () => {
    const channel = {
      ...makeChannel(),
      name: 'discord',
    } satisfies Channel;
    const deliverFinalText = vi.fn().mockResolvedValue(true);
    const controller = new MessageTurnController({
      chatJid: 'dc:test-room',
      group: makeGroup(),
      runId: 'run-owner-failure-final',
      channel,
      idleTimeout: 1_000,
      failureFinalText: '실패',
      isClaudeCodeAgent: true,
      clearSession: vi.fn(),
      requestClose: vi.fn(),
      deliverFinalText,
      deliveryRole: 'owner',
      pairedTurnIdentity: {
        turnId: 'task-1:2026-04-10T14:22:00.000Z:owner-turn',
        taskId: 'task-1',
        taskUpdatedAt: '2026-04-10T14:22:00.000Z',
        intentKind: 'finalize-owner-turn',
        role: 'owner',
      },
    });

    await controller.start();
    await controller.handleOutput({
      status: 'success',
      phase: 'progress',
      result: '첫 진행 상황',
    } as any);
    await controller.handleOutput({
      status: 'error',
      phase: 'progress',
      result: '오류 직전 진행 상황',
    } as any);
    await flushAsync();

    await controller.finish('error');

    expect(channel.sendAndTrack).toHaveBeenCalledTimes(1);
    expect(deliverFinalText).toHaveBeenCalledWith('실패', {
      replaceMessageId: 'progress-1',
    });
  });
});
