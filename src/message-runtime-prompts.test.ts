import { describe, expect, it } from 'vitest';

import {
  buildArbiterPromptForTask,
  buildFinalizePendingPrompt,
  buildOwnerPendingPrompt,
  buildPairedTurnPrompt,
  buildReviewerPendingPrompt,
} from './message-runtime-prompts.js';
import type { NewMessage, PairedTask, PairedTurnOutput } from './types.js';

const CARRY_FORWARD_MARKER =
  '[Carried forward context from the previous task: latest owner final]';

function makeHumanMessage(
  content: string,
  timestamp: string = '2026-04-20T01:00:00.000Z',
): NewMessage {
  return {
    id: `msg-${content}`,
    chat_jid: 'group@test',
    sender: 'user@test',
    sender_name: 'User',
    content,
    timestamp,
    is_bot_message: false,
    is_from_me: false,
  };
}

function makeTurnOutput(
  outputText: string,
  role: PairedTurnOutput['role'] = 'owner',
  overrides: Partial<PairedTurnOutput> = {},
): PairedTurnOutput {
  return {
    id: 1,
    task_id: 'task-1',
    turn_number: 0,
    role,
    output_text: outputText,
    created_at: '2026-04-20T00:59:00.000Z',
    ...overrides,
  };
}

function makeTask(overrides: Partial<PairedTask> = {}): PairedTask {
  return {
    id: 'task-1',
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
    created_at: '2026-04-20T00:58:00.000Z',
    updated_at: '2026-04-20T00:59:00.000Z',
    ...overrides,
  };
}

describe('message-runtime-prompts carry-forward guidance', () => {
  it('prepends a carry-forward warning to paired turn prompts', () => {
    const prompt = buildPairedTurnPrompt({
      taskId: 'task-1',
      chatJid: 'group@test',
      timezone: 'UTC',
      missedMessages: [makeHumanMessage('새 질문')],
      labeledFallbackMessages: [makeHumanMessage('새 질문')],
      turnOutputs: [
        makeTurnOutput(`${CARRY_FORWARD_MARKER}\nDONE\n이전 owner final`),
      ],
    });

    expect(
      prompt.startsWith('System note:\nIf you see a message beginning with'),
    ).toBe(true);
    expect(prompt).toContain(CARRY_FORWARD_MARKER);
    expect(prompt).toContain(
      'Respond only to the latest human request and the current task.',
    );
  });

  it('prepends a carry-forward warning to reviewer pending prompts', () => {
    const prompt = buildReviewerPendingPrompt({
      chatJid: 'group@test',
      timezone: 'UTC',
      turnOutputs: [
        makeTurnOutput(`${CARRY_FORWARD_MARKER}\nDONE\n이전 owner final`),
      ],
      recentHumanMessages: [makeHumanMessage('이제 새 질문')],
      lastHumanMessage: '이제 새 질문',
    });

    expect(
      prompt.startsWith('System note:\nIf you see a message beginning with'),
    ).toBe(true);
    expect(prompt).toContain(
      'Do not repeat, continue, or answer that carried-forward final directly.',
    );
  });
});

describe('message-runtime-prompts output-only context', () => {
  it('keeps reviewer pending prompts output-only when current task outputs exist', () => {
    const prompt = buildReviewerPendingPrompt({
      chatJid: 'group@test',
      timezone: 'UTC',
      turnOutputs: [
        makeTurnOutput('TASK_DONE\n현재 owner 결과', 'owner', {
          turn_number: 1,
          created_at: '2026-04-20T02:00:00.000Z',
        }),
      ],
      recentHumanMessages: [
        makeHumanMessage('과거 요청을 다시 기준으로 보면 안 됨'),
      ],
      lastHumanMessage: '과거 요청을 다시 기준으로 보면 안 됨',
    });

    expect(prompt).toContain('현재 owner 결과');
    expect(prompt).not.toContain('과거 요청을 다시 기준으로 보면 안 됨');
  });

  it('carries owner turn attachments into reviewer prompts as image inputs', () => {
    const prompt = buildReviewerPendingPrompt({
      chatJid: 'group@test',
      timezone: 'UTC',
      turnOutputs: [
        makeTurnOutput('TASK_DONE\n새 렌더 증거 첨부', 'owner', {
          turn_number: 1,
          created_at: '2026-04-20T02:00:00.000Z',
          attachments: [
            {
              path: '/tmp/settings-v0.1.92-deployed-390.png',
              name: 'settings-v0.1.92-deployed-390.png',
              mime: 'image/png',
            },
          ],
        }),
      ],
      recentHumanMessages: [
        makeHumanMessage(
          '원본 스크린샷\n[Image: old-phone.jpg → /tmp/old-phone.jpg]',
          '2026-04-20T01:30:00.000Z',
        ),
      ],
      lastHumanMessage: '원본 스크린샷',
      taskCreatedAt: '2026-04-20T01:00:00.000Z',
    });

    expect(prompt).toContain('새 렌더 증거 첨부');
    expect(prompt).toContain(
      '[Image: settings-v0.1.92-deployed-390.png → /tmp/settings-v0.1.92-deployed-390.png]',
    );
  });

  it('includes current task user scope in reviewer pending prompts without pulling older human messages', () => {
    const prompt = buildReviewerPendingPrompt({
      chatJid: 'group@test',
      timezone: 'UTC',
      turnOutputs: [
        makeTurnOutput('TASK_DONE\n현재 owner 결과', 'owner', {
          turn_number: 1,
          created_at: '2026-04-20T02:10:00.000Z',
        }),
      ],
      recentHumanMessages: [
        makeHumanMessage('이전 작업의 gap 요청', '2026-04-20T01:50:00.000Z'),
        makeHumanMessage(
          '뒤쪽 트레일 주변 디졸브 넣어줘',
          '2026-04-20T02:00:01.000Z',
        ),
      ],
      lastHumanMessage: '뒤쪽 트레일 주변 디졸브 넣어줘',
      taskCreatedAt: '2026-04-20T02:00:00.000Z',
    });

    expect(prompt).toContain('뒤쪽 트레일 주변 디졸브 넣어줘');
    expect(prompt).toContain('현재 owner 결과');
    expect(prompt).not.toContain('이전 작업의 gap 요청');
  });

  it('prepends a carry-forward warning to owner pending prompts', () => {
    const prompt = buildOwnerPendingPrompt({
      chatJid: 'group@test',
      timezone: 'UTC',
      turnOutputs: [
        makeTurnOutput(`${CARRY_FORWARD_MARKER}\nDONE\n이전 owner final`),
      ],
      recentHumanMessages: [makeHumanMessage('새 owner 질문')],
      lastHumanMessage: '새 owner 질문',
    });

    expect(
      prompt.startsWith('System note:\nIf you see a message beginning with'),
    ).toBe(true);
    expect(prompt).toContain(
      'Respond only to the latest human request and the current task.',
    );
  });

  it('keeps owner pending prompts output-only when reviewer feedback exists', () => {
    const prompt = buildOwnerPendingPrompt({
      chatJid: 'group@test',
      timezone: 'UTC',
      turnOutputs: [
        makeTurnOutput('TASK_DONE\n현재 owner 결과', 'owner', {
          turn_number: 1,
        }),
        makeTurnOutput('DONE_WITH_CONCERNS\n현재 reviewer 피드백', 'reviewer', {
          id: 2,
          turn_number: 2,
        }),
      ],
      recentHumanMessages: [makeHumanMessage('이전 작업의 사용자 메시지')],
      lastHumanMessage: '이전 작업의 사용자 메시지',
    });

    expect(prompt).toContain('현재 owner 결과');
    expect(prompt).toContain('현재 reviewer 피드백');
    expect(prompt).not.toContain('이전 작업의 사용자 메시지');
  });

  it('includes current task user scope in owner pending prompts without pulling older human messages', () => {
    const prompt = buildOwnerPendingPrompt({
      chatJid: 'group@test',
      timezone: 'UTC',
      turnOutputs: [
        makeTurnOutput('DONE_WITH_CONCERNS\n현재 reviewer 피드백', 'reviewer', {
          id: 2,
          turn_number: 2,
          created_at: '2026-04-20T02:11:00.000Z',
        }),
      ],
      recentHumanMessages: [
        makeHumanMessage(
          '이전 작업의 사용자 메시지',
          '2026-04-20T01:50:00.000Z',
        ),
        makeHumanMessage(
          '현재 task에서 추가한 조건',
          '2026-04-20T02:00:01.000Z',
        ),
      ],
      lastHumanMessage: '현재 task에서 추가한 조건',
      taskCreatedAt: '2026-04-20T02:00:00.000Z',
    });

    expect(prompt).toContain('현재 task에서 추가한 조건');
    expect(prompt).toContain('현재 reviewer 피드백');
    expect(prompt).not.toContain('이전 작업의 사용자 메시지');
  });
});

describe('message-runtime-prompts arbiter output context', () => {
  it('keeps arbiter prompts output-only when turn outputs exist', () => {
    const prompt = buildArbiterPromptForTask({
      task: makeTask({ status: 'arbiter_requested' }),
      chatJid: 'group@test',
      timezone: 'UTC',
      turnOutputs: [
        makeTurnOutput('TASK_DONE\nowner 주장', 'owner', {
          turn_number: 1,
        }),
        makeTurnOutput('DONE_WITH_CONCERNS\nreviewer 반박', 'reviewer', {
          id: 2,
          turn_number: 2,
        }),
      ],
      recentMessages: [
        makeHumanMessage('예전 유저 지시', '2026-04-20T00:50:00.000Z'),
      ],
      labeledRecentMessages: [
        makeHumanMessage('예전 유저 지시', '2026-04-20T00:50:00.000Z'),
      ],
    });

    expect(prompt).toContain('owner 주장');
    expect(prompt).toContain('reviewer 반박');
    expect(prompt).not.toContain('예전 유저 지시');
  });

  it('limits arbiter prompts to recent turn outputs', () => {
    const prompt = buildArbiterPromptForTask({
      task: makeTask({ status: 'arbiter_requested' }),
      chatJid: 'group@test',
      timezone: 'UTC',
      turnOutputs: Array.from({ length: 8 }, (_, index) => {
        const turnNumber = index + 1;
        return makeTurnOutput(
          `arbiter-context-output-${String(turnNumber).padStart(2, '0')}`,
          turnNumber % 2 === 0 ? 'reviewer' : 'owner',
          {
            id: turnNumber,
            turn_number: turnNumber,
            created_at: `2026-04-20T02:${String(turnNumber).padStart(2, '0')}:00.000Z`,
          },
        );
      }),
      recentMessages: [
        makeHumanMessage('예전 유저 지시', '2026-04-20T00:50:00.000Z'),
      ],
      labeledRecentMessages: [
        makeHumanMessage('예전 유저 지시', '2026-04-20T00:50:00.000Z'),
      ],
    });

    expect(prompt).not.toContain('arbiter-context-output-01');
    expect(prompt).not.toContain('arbiter-context-output-02');
    expect(prompt).toContain('arbiter-context-output-03');
    expect(prompt).toContain('arbiter-context-output-08');
    expect(prompt).not.toContain('예전 유저 지시');
  });

  it('includes current task user scope in arbiter prompts while keeping the output cap', () => {
    const prompt = buildArbiterPromptForTask({
      task: makeTask({
        status: 'arbiter_requested',
        created_at: '2026-04-20T02:00:00.000Z',
      }),
      chatJid: 'group@test',
      timezone: 'UTC',
      turnOutputs: Array.from({ length: 8 }, (_, index) => {
        const turnNumber = index + 1;
        return makeTurnOutput(
          `arbiter-context-output-${String(turnNumber).padStart(2, '0')}`,
          turnNumber % 2 === 0 ? 'reviewer' : 'owner',
          {
            id: turnNumber,
            turn_number: turnNumber,
            created_at: `2026-04-20T02:${String(turnNumber).padStart(2, '0')}:00.000Z`,
          },
        );
      }),
      recentMessages: [
        makeHumanMessage('이전 작업의 유저 지시', '2026-04-20T01:50:00.000Z'),
        makeHumanMessage(
          '현재 task의 트레일 디졸브 요청',
          '2026-04-20T02:00:01.000Z',
        ),
      ],
      labeledRecentMessages: [],
    });

    expect(prompt).toContain('현재 task의 트레일 디졸브 요청');
    expect(prompt).not.toContain('이전 작업의 유저 지시');
    expect(prompt).not.toContain('arbiter-context-output-01');
    expect(prompt).not.toContain('arbiter-context-output-02');
    expect(prompt).toContain('arbiter-context-output-03');
    expect(prompt).toContain('arbiter-context-output-08');
  });
});

describe('message-runtime-prompts prompt hygiene', () => {
  it('preserves turn output order instead of timestamp interleaving', () => {
    const prompt = buildReviewerPendingPrompt({
      chatJid: 'group@test',
      timezone: 'UTC',
      turnOutputs: [
        makeTurnOutput('owner output first', 'owner', {
          turn_number: 1,
          created_at: '2026-04-20T02:00:00.000Z',
        }),
        makeTurnOutput('reviewer output second', 'reviewer', {
          id: 2,
          turn_number: 2,
          created_at: '2026-04-20T01:00:00.000Z',
        }),
      ],
      recentHumanMessages: [],
      lastHumanMessage: null,
    });

    expect(prompt.indexOf('owner output first')).toBeLessThan(
      prompt.indexOf('reviewer output second'),
    );
  });

  it('does not prepend the warning when there is no carried-forward turn output', () => {
    const prompt = buildPairedTurnPrompt({
      taskId: 'task-1',
      chatJid: 'group@test',
      timezone: 'UTC',
      missedMessages: [makeHumanMessage('그냥 새 질문')],
      labeledFallbackMessages: [makeHumanMessage('그냥 새 질문')],
      turnOutputs: [makeTurnOutput('DONE\n일반 owner final')],
    });

    expect(
      prompt.startsWith('System note:\nIf you see a message beginning with'),
    ).toBe(false);
  });

  it('does not include previous task context in reviewer pending prompts when the current task has no outputs', () => {
    const prompt = buildReviewerPendingPrompt({
      chatJid: 'group@test',
      timezone: 'UTC',
      turnOutputs: [],
      recentHumanMessages: [makeHumanMessage('추가 질문')],
      lastHumanMessage: '추가 질문',
    });

    expect(prompt).toContain('추가 질문');
    expect(prompt).not.toContain(
      'Background from the previous completed paired task:',
    );
    expect(prompt).not.toContain('Previous task owner final:');
    expect(prompt).not.toContain('이전 owner 결론');
    expect(prompt).not.toContain('Previous task reviewer final:');
    expect(prompt).not.toContain('이전 reviewer 결론');
  });

  it('does not include previous task context in owner pending prompts when the current task has no outputs', () => {
    const prompt = buildOwnerPendingPrompt({
      chatJid: 'group@test',
      timezone: 'UTC',
      turnOutputs: [],
      recentHumanMessages: [makeHumanMessage('추가 owner 질문')],
      lastHumanMessage: '추가 owner 질문',
    });

    expect(prompt).toContain('추가 owner 질문');
    expect(prompt).not.toContain(
      'Background from the previous completed paired task:',
    );
    expect(prompt).not.toContain('Previous task owner final:');
    expect(prompt).not.toContain('이전 owner 결론');
    expect(prompt).not.toContain('Previous task reviewer final:');
    expect(prompt).not.toContain('이전 reviewer 결론');
  });

  it('does not reinject previous reviewer output into new reviewer prompts', () => {
    const prompt = buildReviewerPendingPrompt({
      chatJid: 'group@test',
      timezone: 'UTC',
      turnOutputs: [],
      recentHumanMessages: [makeHumanMessage('새 작업')],
      lastHumanMessage: '새 작업',
    });

    expect(prompt).toContain('새 작업');
    expect(prompt).not.toContain('Previous task reviewer final:');
    expect(prompt).not.toContain('검증한 것:');
    expect(prompt).not.toContain('CI pass');
    expect(prompt).not.toContain('남은 항목');
    expect(prompt).not.toContain('(관찰)');
    expect(prompt).not.toContain('(잠재)');
    expect(prompt).not.toContain('현재 시리즈 상태');
    expect(prompt).not.toContain('#129');
  });

  it('does not reinject reviewer output into finalize prompts', () => {
    const prompt = buildFinalizePendingPrompt({
      turnOutputs: [
        makeTurnOutput(
          `TASK_DONE
현재 검증:
- build pass

다음 단계:
- unrelated cleanup

누적 배포 대기 상태:
#131 pending`,
          'reviewer',
        ),
      ],
    });

    expect(prompt).not.toContain("Reviewer's final assessment:");
    expect(prompt).not.toContain('현재 검증:');
    expect(prompt).not.toContain('build pass');
    expect(prompt).not.toContain('다음 단계');
    expect(prompt).not.toContain('unrelated cleanup');
    expect(prompt).not.toContain('누적 배포 대기 상태');
    expect(prompt).not.toContain('#131');
  });
});
