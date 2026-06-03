import { describe, expect, it } from 'vitest';

import {
  CodexSdkClient,
  createInitialCodexSdkTurnState,
  reduceCodexSdkTurnState,
  toCodexSdkInput,
  type CodexSdkThreadPort,
} from '../src/codex-sdk-client.js';

const usage = {
  input_tokens: 1,
  cached_input_tokens: 0,
  output_tokens: 2,
  reasoning_output_tokens: 0,
};

async function* events(items: unknown[]): AsyncGenerator<unknown> {
  for (const item of items) {
    yield item;
  }
}

class FakeThread implements CodexSdkThreadPort {
  id: string | null = null;
  lastInput: unknown = null;
  lastSignal: AbortSignal | undefined;

  constructor(private readonly scriptedEvents: unknown[]) {}

  async runStreamed(input: unknown, options?: { signal?: AbortSignal }) {
    this.lastInput = input;
    this.lastSignal = options?.signal;
    return { events: events(this.scriptedEvents) };
  }
}

class FakeCodex {
  readonly started: unknown[] = [];
  readonly resumed: unknown[] = [];
  readonly threads: FakeThread[] = [];

  constructor(private readonly scriptedEvents: unknown[]) {}

  startThread(options?: unknown): FakeThread {
    this.started.push(options);
    const thread = new FakeThread(this.scriptedEvents);
    this.threads.push(thread);
    return thread;
  }

  resumeThread(id: string, options?: unknown): FakeThread {
    this.resumed.push({ id, options });
    const thread = new FakeThread(this.scriptedEvents);
    thread.id = id;
    this.threads.push(thread);
    return thread;
  }
}

describe('Codex SDK runner spike', () => {
  it('maps existing app-server text/image input into Codex SDK input shape', () => {
    expect(
      toCodexSdkInput([
        { type: 'text', text: 'inspect this' },
        { type: 'localImage', path: '/tmp/screenshot.png' },
      ]),
    ).toEqual([
      { type: 'text', text: 'inspect this' },
      { type: 'local_image', path: '/tmp/screenshot.png' },
    ]);
  });

  it('reduces SDK thread events into the runner final result and thread id', () => {
    let state = createInitialCodexSdkTurnState();
    state = reduceCodexSdkTurnState(state, {
      type: 'thread.started',
      thread_id: 'thread-1',
    });
    state = reduceCodexSdkTurnState(state, { type: 'turn.started' });
    state = reduceCodexSdkTurnState(state, {
      type: 'item.completed',
      item: {
        id: 'msg-1',
        type: 'agent_message',
        text: 'STEP_DONE\n검증 완료',
      },
    });
    state = reduceCodexSdkTurnState(state, {
      type: 'turn.completed',
      usage,
    });

    expect(state).toMatchObject({
      status: 'completed',
      threadId: 'thread-1',
      finalAnswer: 'STEP_DONE\n검증 완료',
      usage,
    });
  });

  it('runs a streamed SDK turn and returns the first real thread id', async () => {
    const codex = new FakeCodex([
      { type: 'thread.started', thread_id: 'thread-42' },
      { type: 'turn.started' },
      {
        type: 'item.completed',
        item: { id: 'msg-1', type: 'agent_message', text: 'TASK_DONE\nSDK_OK' },
      },
      { type: 'turn.completed', usage },
    ]);
    const client = new CodexSdkClient({
      codex,
      env: { PATH: '/usr/bin' },
      log: () => undefined,
    });

    const handle = await client.startOrResumeThread(undefined, {
      cwd: '/repo',
      model: 'gpt-5.5',
      effort: 'high',
    });
    const turn = await client.startTurn(
      handle,
      [{ type: 'text', text: 'respond' }],
      { cwd: '/repo', model: 'gpt-5.5', effort: 'high' },
    );

    await expect(turn.wait()).resolves.toMatchObject({
      threadId: 'thread-42',
      result: 'TASK_DONE\nSDK_OK',
      state: { status: 'completed' },
    });
    expect(codex.started).toEqual([
      {
        approvalPolicy: 'never',
        model: 'gpt-5.5',
        modelReasoningEffort: 'high',
        networkAccessEnabled: true,
        sandboxMode: 'danger-full-access',
        workingDirectory: '/repo',
      },
    ]);
    expect(codex.threads[0].lastInput).toEqual([
      { type: 'text', text: 'respond' },
    ]);
  });

  it('coerces minimal effort to low because Codex SDK exec keeps tools enabled', async () => {
    const codex = new FakeCodex([
      { type: 'thread.started', thread_id: 'thread-minimal' },
      { type: 'turn.started' },
      {
        type: 'item.completed',
        item: { id: 'msg-1', type: 'agent_message', text: 'SDK_OK' },
      },
      { type: 'turn.completed', usage },
    ]);
    const client = new CodexSdkClient({ codex, log: () => undefined });

    await client.startOrResumeThread(undefined, {
      cwd: '/repo',
      effort: 'minimal',
    });

    expect(codex.started[0]).toMatchObject({ modelReasoningEffort: 'low' });
  });

  it('documents the SDK gap: mid-turn steering is not available', async () => {
    const codex = new FakeCodex([
      { type: 'thread.started', thread_id: 'thread-1' },
      { type: 'turn.started' },
      { type: 'turn.completed', usage },
    ]);
    const client = new CodexSdkClient({ codex, log: () => undefined });
    const handle = await client.startOrResumeThread('thread-1', {
      cwd: '/repo',
    });
    const turn = await client.startTurn(
      handle,
      [{ type: 'text', text: 'start' }],
      {
        cwd: '/repo',
      },
    );

    await expect(
      turn.steer([{ type: 'text', text: 'follow-up' }]),
    ).rejects.toThrow('Codex SDK runner does not support mid-turn steering');
    await expect(turn.wait()).resolves.toMatchObject({
      state: { status: 'completed' },
    });
  });
});
