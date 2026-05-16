import { describe, expect, it } from 'vitest';

import {
  buildFinalizePendingPrompt,
  buildOwnerPendingPrompt,
  buildPairedTurnPrompt,
  buildReviewerPendingPrompt,
} from './message-runtime-prompts.js';
import type { NewMessage, PairedTurnOutput } from './types.js';

const CARRY_FORWARD_MARKER =
  '[Carried forward context from the previous task: latest owner final]';

function makeHumanMessage(content: string): NewMessage {
  return {
    id: `msg-${content}`,
    chat_jid: 'group@test',
    sender: 'user@test',
    sender_name: 'User',
    content,
    timestamp: '2026-04-20T01:00:00.000Z',
    is_bot_message: false,
    is_from_me: false,
  };
}

function makeTurnOutput(
  outputText: string,
  role: PairedTurnOutput['role'] = 'owner',
): PairedTurnOutput {
  return {
    id: 1,
    task_id: 'task-1',
    turn_number: 0,
    role,
    output_text: outputText,
    created_at: '2026-04-20T00:59:00.000Z',
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
