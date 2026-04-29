import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';

import { GroupQueue, type GroupRunContext } from './group-queue.js';

// Mock config to control concurrency limit
vi.mock('./config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  DATA_DIR: '/tmp/ejclaw-test-data',
  IS_TEST_ENV: true,
  LOG_LEVEL: 'info',
  MAX_CONCURRENT_AGENTS: 2,
}));

// Mock fs operations used by closeStdin
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      renameSync: vi.fn(),
    },
  };
});

describe('GroupQueue', () => {
  let queue: GroupQueue;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    queue = new GroupQueue();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // --- Single group at a time ---

  it('only runs one agent per group at a time', async () => {
    let concurrentCount = 0;
    let maxConcurrent = 0;

    const processMessages = vi.fn(async (_groupJid: string) => {
      concurrentCount++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCount);
      // Simulate async work
      await new Promise((resolve) => setTimeout(resolve, 100));
      concurrentCount--;
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Enqueue two messages for the same group
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group1@g.us');

    // Advance timers to let the first process complete
    await vi.advanceTimersByTimeAsync(200);

    // Second enqueue should have been queued, not concurrent
    expect(maxConcurrent).toBe(1);
  });

  it('pipes follow-up messages to an active non-task process', async () => {
    const ipcDir = '/tmp/ejclaw-test-data/ipc/group-folder';
    let releaseRun!: (value: boolean) => void;
    const blocker = new Promise<boolean>((resolve) => {
      releaseRun = resolve;
    });

    const processMessages = vi.fn(async () => await blocker);

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us', ipcDir);
    await vi.advanceTimersByTimeAsync(10);

    expect(queue.sendMessage('group1@g.us', '후속 메시지')).toBe(true);
    expect(fs.mkdirSync).toHaveBeenCalledWith(`${ipcDir}/input`, {
      recursive: true,
    });
    expect(fs.writeFileSync).toHaveBeenCalled();
    expect(fs.renameSync).toHaveBeenCalled();

    releaseRun(true);
    await vi.advanceTimersByTimeAsync(10);
  });

  it('does not pipe follow-up messages after stdin close was requested', async () => {
    const ipcDir = '/tmp/ejclaw-test-data/ipc/group-folder';
    let releaseRun!: (value: boolean) => void;
    const blocker = new Promise<boolean>((resolve) => {
      releaseRun = resolve;
    });

    const processMessages = vi.fn(async () => await blocker);

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us', ipcDir);
    await vi.advanceTimersByTimeAsync(10);

    vi.mocked(fs.mkdirSync).mockClear();
    vi.mocked(fs.writeFileSync).mockClear();
    vi.mocked(fs.renameSync).mockClear();

    queue.closeStdin('group1@g.us');

    vi.mocked(fs.mkdirSync).mockClear();
    vi.mocked(fs.writeFileSync).mockClear();
    vi.mocked(fs.renameSync).mockClear();

    expect(queue.sendMessage('group1@g.us', '후속 메시지')).toBe(false);
    expect(fs.mkdirSync).not.toHaveBeenCalled();
    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(fs.renameSync).not.toHaveBeenCalled();

    releaseRun(true);
    await vi.advanceTimersByTimeAsync(10);
  });

  it('stores direct terminal text for the active run, keeps a recent run record, and clears the active slot when the run ends', async () => {
    let releaseRun!: (value: boolean) => void;
    let runId: string | undefined;
    const blocker = new Promise<boolean>((resolve) => {
      releaseRun = resolve;
    });

    queue.setProcessMessagesFn(
      async (_groupJid: string, context: GroupRunContext) => {
        runId = context.runId;
        return await blocker;
      },
    );

    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    expect(runId).toEqual(expect.any(String));

    queue.noteDirectTerminalDelivery(
      'group1@g.us',
      'reviewer',
      'DONE_WITH_CONCERNS\n리뷰 완료',
    );

    expect(
      queue.hasDirectTerminalDeliveryForRun('group1@g.us', runId!, 'reviewer'),
    ).toBe(true);
    expect(
      queue.getDirectTerminalDeliveryForRun('group1@g.us', runId!, 'reviewer'),
    ).toBe('DONE_WITH_CONCERNS\n리뷰 완료');
    expect(
      queue.hasRecordedDirectTerminalDeliveryForRun(
        'group1@g.us',
        runId!,
        'reviewer',
      ),
    ).toBe(true);

    releaseRun(true);
    await vi.advanceTimersByTimeAsync(10);

    expect(
      queue.hasDirectTerminalDeliveryForRun('group1@g.us', runId!, 'reviewer'),
    ).toBe(false);
    expect(
      queue.getDirectTerminalDeliveryForRun('group1@g.us', runId!, 'reviewer'),
    ).toBeNull();
    expect(
      queue.hasRecordedDirectTerminalDeliveryForRun(
        'group1@g.us',
        runId!,
        'reviewer',
      ),
    ).toBe(true);
  });

  it('force-terminates a lingering process after output was delivered', async () => {
    class StubbornProcess extends EventEmitter {
      exitCode: number | null = null;
      signalCode: NodeJS.Signals | null = null;
      kill = vi.fn(() => true);
    }

    const ipcDir = '/tmp/ejclaw-test-data/ipc/group-folder';
    let releaseRun!: (value: boolean) => void;
    let runId: string | undefined;
    const blocker = new Promise<boolean>((resolve) => {
      releaseRun = resolve;
    });

    const processMessages = vi.fn(
      async (_groupJid: string, context: GroupRunContext) => {
        runId = context.runId;
        return await blocker;
      },
    );

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us', ipcDir);
    await vi.advanceTimersByTimeAsync(10);

    expect(runId).toEqual(expect.any(String));

    const proc = new StubbornProcess();
    queue.registerProcess(
      'group1@g.us',
      proc as unknown as import('child_process').ChildProcess,
      'proc-1',
      ipcDir,
    );

    queue.closeStdin('group1@g.us', {
      runId,
      reason: 'output-delivered-close',
    });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');

    await vi.advanceTimersByTimeAsync(15_000);
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');

    releaseRun(true);
    await vi.advanceTimersByTimeAsync(10);
  });

  it('clears post-close termination timers once the run exits', async () => {
    class FakeProcess extends EventEmitter {
      exitCode: number | null = null;
      signalCode: NodeJS.Signals | null = null;
      kill = vi.fn(() => true);
    }

    const ipcDir = '/tmp/ejclaw-test-data/ipc/group-folder';
    let releaseRun!: (value: boolean) => void;
    const blocker = new Promise<boolean>((resolve) => {
      releaseRun = resolve;
    });

    const proc = new FakeProcess();
    const processMessages = vi.fn(
      async (_groupJid: string, context: GroupRunContext) => {
        queue.registerProcess(
          'group1@g.us',
          proc as unknown as import('child_process').ChildProcess,
          'proc-1',
          ipcDir,
        );

        queue.closeStdin('group1@g.us', {
          runId: context.runId,
          reason: 'output-delivered-close',
        });

        await blocker;
        return true;
      },
    );

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us', ipcDir);
    await vi.advanceTimersByTimeAsync(10);

    releaseRun(true);
    await vi.advanceTimersByTimeAsync(10);

    await vi.advanceTimersByTimeAsync(75_000);
    expect(proc.kill).not.toHaveBeenCalled();
  });

  // --- Global concurrency limit ---

  it('respects global concurrency limit', async () => {
    let activeCount = 0;
    let maxActive = 0;
    const completionCallbacks: Array<() => void> = [];

    const processMessages = vi.fn(async (_groupJid: string) => {
      activeCount++;
      maxActive = Math.max(maxActive, activeCount);
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      activeCount--;
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Enqueue 3 groups (limit is 2)
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group2@g.us');
    queue.enqueueMessageCheck('group3@g.us');

    // Let promises settle
    await vi.advanceTimersByTimeAsync(10);

    // Only 2 should be active (MAX_CONCURRENT_AGENTS = 2)
    expect(maxActive).toBe(2);
    expect(activeCount).toBe(2);

    // Complete one — third should start
    completionCallbacks[0]();
    await vi.advanceTimersByTimeAsync(10);

    expect(processMessages).toHaveBeenCalledTimes(3);
  });

  it('reserves one foreground slot so queued tasks do not block new messages', async () => {
    let resolveTaskOne!: () => void;
    let resolveTaskTwo!: () => void;
    let messageStarted = false;

    const processMessages = vi.fn(async (groupJid: string) => {
      if (groupJid === 'group3@g.us') {
        messageStarted = true;
      }
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    queue.enqueueTask('group1@g.us', 'task-1', async () => {
      await new Promise<void>((resolve) => {
        resolveTaskOne = resolve;
      });
    });
    await vi.advanceTimersByTimeAsync(10);

    queue.enqueueTask('group2@g.us', 'task-2', async () => {
      await new Promise<void>((resolve) => {
        resolveTaskTwo = resolve;
      });
    });
    queue.enqueueMessageCheck('group3@g.us');
    await vi.advanceTimersByTimeAsync(10);

    expect(messageStarted).toBe(true);
    expect(processMessages).toHaveBeenCalledWith('group3@g.us', {
      runId: expect.any(String),
      reason: 'messages',
    });

    resolveTaskOne!();
    await vi.advanceTimersByTimeAsync(10);
    expect(messageStarted).toBe(true);

    resolveTaskTwo!();
    await vi.advanceTimersByTimeAsync(10);
  });

  // --- Tasks prioritized over messages ---

  it('drains tasks before messages for same group', async () => {
    const executionOrder: string[] = [];
    let resolveFirst: () => void;

    const processMessages = vi.fn(async (_groupJid: string) => {
      if (executionOrder.length === 0) {
        // First call: block until we release it
        await new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
      }
      executionOrder.push('messages');
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start processing messages (takes the active slot)
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // While active, enqueue both a task and pending messages
    const taskFn = vi.fn(async () => {
      executionOrder.push('task');
    });
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    queue.enqueueMessageCheck('group1@g.us');

    // Release the first processing
    resolveFirst!();
    await vi.advanceTimersByTimeAsync(10);

    // Task should have run before the second message check
    expect(executionOrder[0]).toBe('messages'); // first call
    expect(executionOrder[1]).toBe('task'); // task runs first in drain
    // Messages would run after task completes
  });

  // --- Retry with backoff on failure ---

  it('retries with exponential backoff on failure', async () => {
    let callCount = 0;

    const processMessages = vi.fn(async () => {
      callCount++;
      return false; // failure
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');

    // First call happens immediately
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(1);

    // First retry after 5000ms (BASE_RETRY_MS * 2^0)
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(2);

    // Second retry after 10000ms (BASE_RETRY_MS * 2^1)
    await vi.advanceTimersByTimeAsync(10000);
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(3);
  });

  it('does not bypass retry backoff when new messages arrive', async () => {
    let callCount = 0;

    const processMessages = vi.fn(async () => {
      callCount++;
      return false;
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');

    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(1);

    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(1000);
    expect(callCount).toBe(1);

    await vi.advanceTimersByTimeAsync(4000);
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(2);
  });

  // --- Shutdown prevents new enqueues ---

  it('prevents new enqueues after shutdown', async () => {
    const processMessages = vi.fn(async () => true);
    queue.setProcessMessagesFn(processMessages);

    await queue.shutdown(1000);

    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(100);

    expect(processMessages).not.toHaveBeenCalled();
  });

  it('signals and terminates active agent processes during shutdown', async () => {
    class FakeProcess extends EventEmitter {
      exitCode: number | null = null;
      signalCode: NodeJS.Signals | null = null;
      kill = vi.fn((signal?: NodeJS.Signals) => {
        this.signalCode = signal ?? 'SIGTERM';
        return true;
      });
    }

    const ipcDir = '/tmp/ejclaw-test-data/ipc/group-folder';
    let releaseRun!: (value: boolean) => void;
    const blocker = new Promise<boolean>((resolve) => {
      releaseRun = resolve;
    });

    const processMessages = vi.fn(async () => await blocker);
    queue.setProcessMessagesFn(processMessages);

    queue.enqueueMessageCheck('group1@g.us', ipcDir);
    await vi.advanceTimersByTimeAsync(10);

    const proc = new FakeProcess();
    queue.registerProcess(
      'group1@g.us',
      proc as unknown as import('child_process').ChildProcess,
      'proc-1',
      ipcDir,
    );

    vi.mocked(fs.writeFileSync).mockClear();

    const shutdownPromise = queue.shutdown(1_000);
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('/input/_close'),
      '',
    );

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(2_000);
    await shutdownPromise;

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');

    releaseRun(true);
    await vi.advanceTimersByTimeAsync(10);
  });

  // --- Max retries exceeded ---

  it('stops retrying after MAX_RETRIES and resets', async () => {
    let callCount = 0;

    const processMessages = vi.fn(async () => {
      callCount++;
      return false; // always fail
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');

    // Run through all 5 retries (MAX_RETRIES = 5)
    // Initial call
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(1);

    // Retry 1: 5000ms, Retry 2: 10000ms, Retry 3: 20000ms, Retry 4: 40000ms, Retry 5: 80000ms
    const retryDelays = [5000, 10000, 20000, 40000, 80000];
    for (let i = 0; i < retryDelays.length; i++) {
      await vi.advanceTimersByTimeAsync(retryDelays[i] + 10);
      expect(callCount).toBe(i + 2);
    }

    // After 5 retries (6 total calls), should stop — no more retries
    const countAfterMaxRetries = callCount;
    await vi.advanceTimersByTimeAsync(200000); // Wait a long time
    expect(callCount).toBe(countAfterMaxRetries);
  });

  // --- Waiting groups get drained when slots free up ---

  it('drains waiting groups when active slots free up', async () => {
    const processed: string[] = [];
    const completionCallbacks: Array<() => void> = [];

    const processMessages = vi.fn(async (groupJid: string) => {
      processed.push(groupJid);
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Fill both slots
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group2@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Queue a third
    queue.enqueueMessageCheck('group3@g.us');
    await vi.advanceTimersByTimeAsync(10);

    expect(processed).toEqual(['group1@g.us', 'group2@g.us']);

    // Free up a slot
    completionCallbacks[0]();
    await vi.advanceTimersByTimeAsync(10);

    expect(processed).toContain('group3@g.us');
  });

  // --- Running task dedup (Issue #138) ---

  it('rejects duplicate enqueue of a currently-running task', async () => {
    let resolveTask: () => void;
    let taskCallCount = 0;

    const taskFn = vi.fn(async () => {
      taskCallCount++;
      await new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
    });

    // Start the task (runs immediately — slot available)
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await vi.advanceTimersByTimeAsync(10);
    expect(taskCallCount).toBe(1);

    // Scheduler poll re-discovers the same task while it's running —
    // this must be silently dropped
    const dupFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', dupFn);
    await vi.advanceTimersByTimeAsync(10);

    // Duplicate was NOT queued
    expect(dupFn).not.toHaveBeenCalled();

    // Complete the original task
    resolveTask!();
    await vi.advanceTimersByTimeAsync(10);

    // Only one execution total
    expect(taskCallCount).toBe(1);
  });

  // --- Active runs queue work without preemption ---

  it('does not preempt an active agent when a task is queued', async () => {
    const fs = await import('fs');
    let resolveProcess: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start processing (takes the active slot)
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Register a process so closeStdin has a groupFolder
    queue.registerProcess('group1@g.us', {} as any, 'agent-1', 'test-group');

    // Enqueue a task while agent is active but NOT idle
    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);

    // _close should NOT have been written (agent is working, not idle)
    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    const closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(0);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  // --- Run phase transitions ---

  it('transitions running_messages → closing_messages → idle', async () => {
    const ipcDir = '/tmp/ejclaw-test-data/ipc/group-folder';
    let releaseRun!: (value: boolean) => void;
    const blocker = new Promise<boolean>((resolve) => {
      releaseRun = resolve;
    });

    const processMessages = vi.fn(async () => await blocker);
    queue.setProcessMessagesFn(processMessages);

    queue.enqueueMessageCheck('group1@g.us', ipcDir);
    await vi.advanceTimersByTimeAsync(10);

    // While running, phase should be running_messages
    const duringRun = queue.getStatuses(['group1@g.us']);
    expect(duringRun[0].runPhase).toBe('running_messages');

    // closeStdin transitions to closing_messages
    queue.closeStdin('group1@g.us');
    const afterClose = queue.getStatuses(['group1@g.us']);
    expect(afterClose[0].runPhase).toBe('closing_messages');

    // sendMessage should fail in closing_messages
    expect(queue.sendMessage('group1@g.us', 'test')).toBe(false);

    // Complete the run — should go to idle
    releaseRun(true);
    await vi.advanceTimersByTimeAsync(10);

    const afterFinish = queue.getStatuses(['group1@g.us']);
    expect(afterFinish[0].runPhase).toBe('idle');
    expect(afterFinish[0].status).toBe('inactive');
  });

  it('closeStdin does not change phase during running_task', async () => {
    const ipcDir = '/tmp/ejclaw-test-data/ipc/group-folder';
    let resolveTask!: () => void;
    const blocker = new Promise<void>((resolve) => {
      resolveTask = resolve;
    });

    queue.enqueueTask('group1@g.us', 'task-1', async () => {
      // Register process so closeStdin has an ipcDir
      queue.registerProcess('group1@g.us', {} as any, 'agent-1', ipcDir);
      await blocker;
    });
    await vi.advanceTimersByTimeAsync(10);

    const duringTask = queue.getStatuses(['group1@g.us']);
    expect(duringTask[0].runPhase).toBe('running_task');

    // closeStdin during task — phase should stay running_task
    queue.closeStdin('group1@g.us');
    const afterClose = queue.getStatuses(['group1@g.us']);
    expect(afterClose[0].runPhase).toBe('running_task');

    resolveTask();
    await vi.advanceTimersByTimeAsync(10);

    const afterFinish = queue.getStatuses(['group1@g.us']);
    expect(afterFinish[0].runPhase).toBe('idle');
  });

  it('sendMessage returns true only in running_messages phase', async () => {
    const ipcDir = '/tmp/ejclaw-test-data/ipc/group-folder';

    // idle → false
    expect(queue.sendMessage('group1@g.us', 'test')).toBe(false);

    // running_task → false
    let resolveTask!: () => void;
    queue.enqueueTask('group1@g.us', 'task-1', async () => {
      queue.registerProcess('group1@g.us', {} as any, 'agent-1', ipcDir);
      await new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(queue.sendMessage('group1@g.us', 'test')).toBe(false);
    resolveTask();
    await vi.advanceTimersByTimeAsync(10);

    // running_messages → true
    let releaseRun!: (value: boolean) => void;
    const processMessages = vi.fn(async () => {
      return await new Promise<boolean>((resolve) => {
        releaseRun = resolve;
      });
    });
    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us', ipcDir);
    await vi.advanceTimersByTimeAsync(10);

    expect(queue.sendMessage('group1@g.us', 'msg')).toBe(true);

    // closing_messages → false
    queue.closeStdin('group1@g.us');
    expect(queue.sendMessage('group1@g.us', 'msg')).toBe(false);

    releaseRun(true);
    await vi.advanceTimersByTimeAsync(10);
  });
});
