import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import fs from 'fs';
import { spawn } from 'child_process';

import { OUTPUT_START_MARKER, OUTPUT_END_MARKER } from './agent-protocol.js';

// Mock config
vi.mock('./config.js', () => ({
  AGENT_MAX_OUTPUT_SIZE: 10485760,
  AGENT_TIMEOUT: 1800000, // 30min
  DATA_DIR: '/tmp/ejclaw-test-data',
  GROUPS_DIR: '/tmp/ejclaw-test-groups',
  IDLE_TIMEOUT: 1800000, // 30min
  LOG_LEVEL: 'info',
  SERVICE_ID: 'claude',
  SERVICE_SESSION_SCOPE: 'claude',
  TIMEZONE: 'America/Los_Angeles',
  isReviewService: vi.fn(() => false),
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn((p: string) => {
        // Return true for runner dist entry so tests proceed past the build check
        if (typeof p === 'string' && p.includes('dist/index.js')) return true;
        return false;
      }),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      copyFileSync: vi.fn(),
      cpSync: vi.fn(),
    },
  };
});

// Mock env
vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
  getEnv: vi.fn(() => undefined),
}));

vi.mock('./service-routing.js', () => ({
  getEffectiveChannelLease: vi.fn(() => ({
    chat_jid: 'test@g.us',
    owner_service_id: 'claude',
    reviewer_service_id: 'codex-main',
    activated_at: null,
    reason: null,
    explicit: false,
  })),
  hasReviewerLease: vi.fn(() => true),
}));

vi.mock('./db.js', () => ({
  getStoredRoomSkillOverrides: vi.fn(() => []),
}));

// Create a controllable fake ChildProcess
function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

// Mock child_process.spawn
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
    exec: vi.fn(
      (_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
        if (cb) cb(null);
        return new EventEmitter();
      },
    ),
  };
});

import { runAgentProcess, AgentOutput } from './agent-runner.js';
import * as agentRunnerEnvironment from './agent-runner-environment.js';
import { getStoredRoomSkillOverrides } from './db.js';
import type { RegisteredGroup } from './types.js';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

const testInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

function emitOutputMarker(
  proc: ReturnType<typeof createFakeProcess>,
  output: AgentOutput,
) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

describe('agent-runner timeout behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('timeout after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runAgentProcess(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output with a result
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Here is my response',
      newSessionId: 'session-123',
    });

    // Let output processing settle
    await vi.advanceTimersByTimeAsync(10);

    // Fire the hard timeout (IDLE_TIMEOUT + 30s = 1830000ms)
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event (as if agent was stopped by the timeout)
    fakeProc.emit('close', 137);

    // Let the promise resolve
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-123');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'Here is my response' }),
    );
  });

  it('timeout with no output resolves as error', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runAgentProcess(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // No output emitted — fire the hard timeout
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event
    fakeProc.emit('close', 137);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('normal exit after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runAgentProcess(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-456',
    });

    await vi.advanceTimersByTimeAsync(10);

    // Normal exit (no timeout)
    fakeProc.emit('close', 0);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-456');
  });

  it('preserves streamed progress phase metadata', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runAgentProcess(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: '생각 중...',
      phase: 'progress',
      newSessionId: 'session-progress',
    });
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: '최종 답변',
      phase: 'final',
      newSessionId: 'session-progress',
    });

    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        result: '생각 중...',
        phase: 'progress',
      }),
    );
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        result: '최종 답변',
        phase: 'final',
      }),
    );
  });

  it('passes the actual chat JID into codex runner MCP env', async () => {
    vi.useRealTimers();
    fakeProc = createFakeProcess();

    vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
      const str = String(p);
      return (
        str.includes('dist/index.js') ||
        str.includes('dist/ipc-mcp-stdio.js') ||
        str.endsWith('/.codex/config.toml')
      );
    });

    const codexGroup: RegisteredGroup = {
      ...testGroup,
      agentType: 'codex',
    };

    const resultPromise = runAgentProcess(
      codexGroup,
      testInput,
      () => {},
      async () => {},
    );

    fakeProc.emit('close', 0);
    const result = await resultPromise;
    expect(result.status).toBe('success');

    const spawnEnv = vi.mocked(spawn).mock.calls[0]?.[2]?.env as
      | Record<string, string>
      | undefined;
    expect(spawnEnv?.EJCLAW_CHAT_JID).toBe(testInput.chatJid);

    const tomlWrite = vi
      .mocked(fs.writeFileSync)
      .mock.calls.find((call) =>
        String(call[0]).endsWith('/.codex/config.toml'),
      );
    expect(String(tomlWrite?.[1])).toContain(
      `EJCLAW_CHAT_JID = ${JSON.stringify(testInput.chatJid)}`,
    );
  });

  it('uses host IPC and workdir in unsafe host paired mode reviewer sessions', async () => {
    vi.useRealTimers();
    fakeProc = createFakeProcess();
    const prepareReadonlySessionEnvironmentSpy = vi.spyOn(
      agentRunnerEnvironment,
      'prepareReadonlySessionEnvironment',
    );

    vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
      const str = String(p);
      return (
        str.includes('dist/index.js') ||
        str.includes('dist/ipc-mcp-stdio.js') ||
        str.endsWith('/.codex/config.toml')
      );
    });

    const resultPromise = runAgentProcess(
      testGroup,
      {
        ...testInput,
        roomRoleContext: {
          serviceId: 'claude',
          role: 'reviewer',
          ownerServiceId: 'codex-main',
          reviewerServiceId: 'claude',
          failoverOwner: false,
        },
      },
      () => {},
      async () => {},
      {
        EJCLAW_UNSAFE_HOST_PAIRED_MODE: '1',
        CLAUDE_CONFIG_DIR: '/tmp/host-reviewer-session',
        EJCLAW_WORK_DIR: '/tmp/paired/task-1/reviewer',
      },
    );

    fakeProc.emit('close', 0);
    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(prepareReadonlySessionEnvironmentSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionDir: '/tmp/host-reviewer-session',
        ipcDir: '/tmp/ejclaw-test-data/ipc/test-group',
        hostIpcDir: '/tmp/ejclaw-test-data/ipc/test-group',
        workDir: '/tmp/paired/task-1/reviewer',
        role: 'reviewer',
      }),
    );
  });

  it('uses role-scoped CODEX_HOME in unsafe host paired mode for codex reviewer', async () => {
    vi.useRealTimers();
    fakeProc = createFakeProcess();

    const codexGroup: RegisteredGroup = {
      ...testGroup,
      agentType: 'codex',
    };

    const resultPromise = runAgentProcess(
      codexGroup,
      {
        ...testInput,
        roomRoleContext: {
          serviceId: 'codex-review',
          role: 'reviewer',
          ownerServiceId: 'codex-main',
          reviewerServiceId: 'codex-review',
          failoverOwner: false,
        },
      },
      () => {},
      async () => {},
      {
        EJCLAW_UNSAFE_HOST_PAIRED_MODE: '1',
        CLAUDE_CONFIG_DIR: '/tmp/host-reviewer-session',
        EJCLAW_WORK_DIR: '/tmp/paired/task-1/reviewer',
      },
    );

    fakeProc.emit('close', 0);
    const result = await resultPromise;
    expect(result.status).toBe('success');

    const spawnEnv = vi.mocked(spawn).mock.calls.at(-1)?.[2]?.env as
      | Record<string, string>
      | undefined;
    expect(spawnEnv?.CODEX_HOME).toBe('/tmp/host-reviewer-session/.codex');
  });

  it('serializes roomRoleContext into the runner stdin payload', async () => {
    vi.useRealTimers();
    fakeProc = createFakeProcess();

    let stdinPayload = '';
    fakeProc.stdin.on('data', (chunk) => {
      stdinPayload += chunk.toString();
    });

    const resultPromise = runAgentProcess(
      testGroup,
      {
        ...testInput,
        roomRoleContext: {
          serviceId: 'codex-main',
          role: 'reviewer',
          ownerServiceId: 'claude',
          reviewerServiceId: 'codex-main',
          failoverOwner: false,
        },
      },
      () => {},
      async () => {},
    );

    fakeProc.emit('close', 0);
    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(JSON.parse(stdinPayload)).toMatchObject({
      prompt: 'Hello',
      roomRoleContext: {
        serviceId: 'codex-main',
        role: 'reviewer',
        ownerServiceId: 'claude',
        reviewerServiceId: 'codex-main',
        failoverOwner: false,
      },
    });
  });

  it('isolates IPC and session directories for isolated scheduled tasks', async () => {
    vi.useRealTimers();
    fakeProc = createFakeProcess();

    const resultPromise = runAgentProcess(
      testGroup,
      {
        ...testInput,
        isScheduledTask: true,
        runtimeTaskId: 'task-123',
        useTaskScopedSession: true,
      },
      () => {},
      async () => {},
    );

    fakeProc.emit('close', 0);
    const result = await resultPromise;
    expect(result.status).toBe('success');

    const spawnEnv = vi.mocked(spawn).mock.calls.at(-1)?.[2]?.env as
      | Record<string, string>
      | undefined;
    expect(spawnEnv?.EJCLAW_IPC_DIR).toBe(
      '/tmp/ejclaw-test-data/ipc/test-group/tasks/task-123',
    );
    expect(spawnEnv?.EJCLAW_HOST_IPC_DIR).toBe(
      '/tmp/ejclaw-test-data/ipc/test-group',
    );
    expect(spawnEnv?.CLAUDE_CONFIG_DIR).toBe(
      '/tmp/ejclaw-test-data/sessions/test-group/services/claude/tasks/task-123/.claude',
    );
  });

  it('writes EJCLAW_HOST_IPC_DIR into task-scoped codex MCP config', async () => {
    vi.useRealTimers();
    fakeProc = createFakeProcess();

    vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
      const str = String(p);
      return (
        str.includes('dist/index.js') ||
        str.includes('dist/ipc-mcp-stdio.js') ||
        str.endsWith('/.codex/config.toml')
      );
    });

    const codexGroup: RegisteredGroup = {
      ...testGroup,
      agentType: 'codex',
    };

    const resultPromise = runAgentProcess(
      codexGroup,
      {
        ...testInput,
        isScheduledTask: true,
        runtimeTaskId: 'task-codex-watch',
        useTaskScopedSession: false,
      },
      () => {},
      async () => {},
    );

    fakeProc.emit('close', 0);
    const result = await resultPromise;
    expect(result.status).toBe('success');

    const tomlWrite = [...vi.mocked(fs.writeFileSync).mock.calls]
      .reverse()
      .find((call) => String(call[0]).endsWith('/.codex/config.toml'));
    expect(String(tomlWrite?.[1])).toContain(
      'EJCLAW_IPC_DIR = "/tmp/ejclaw-test-data/ipc/test-group/tasks/task-codex-watch"',
    );
    expect(String(tomlWrite?.[1])).toContain(
      'EJCLAW_HOST_IPC_DIR = "/tmp/ejclaw-test-data/ipc/test-group"',
    );
  });

  it('keeps shared session history for group-context task runtimes while isolating IPC', async () => {
    vi.useRealTimers();
    fakeProc = createFakeProcess();

    const resultPromise = runAgentProcess(
      testGroup,
      {
        ...testInput,
        isScheduledTask: true,
        runtimeTaskId: 'task-watch-group',
        useTaskScopedSession: false,
      },
      () => {},
      async () => {},
    );

    fakeProc.emit('close', 0);
    const result = await resultPromise;
    expect(result.status).toBe('success');

    const spawnEnv = vi.mocked(spawn).mock.calls.at(-1)?.[2]?.env as
      | Record<string, string>
      | undefined;
    expect(spawnEnv?.EJCLAW_IPC_DIR).toBe(
      '/tmp/ejclaw-test-data/ipc/test-group/tasks/task-watch-group',
    );
    expect(spawnEnv?.EJCLAW_HOST_IPC_DIR).toBe(
      '/tmp/ejclaw-test-data/ipc/test-group',
    );
    expect(spawnEnv?.CLAUDE_CONFIG_DIR).toBe(
      '/tmp/ejclaw-test-data/sessions/test-group/services/claude/.claude',
    );
  });

  it('merges a per-group codex config overlay before injecting managed MCP servers', async () => {
    vi.useRealTimers();
    fakeProc = createFakeProcess();
    const overlayPath = '/tmp/ejclaw-test-groups/test-group/.codex/config.toml';
    const sessionConfigPath =
      '/tmp/ejclaw-test-data/sessions/test-group/services/claude/.codex/config.toml';
    let sessionToml = `model = "gpt-5.4"\n`;

    vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
      const str = String(p);
      return (
        str.includes('dist/index.js') ||
        str.includes('dist/ipc-mcp-stdio.js') ||
        str.endsWith('/.codex/config.toml') ||
        str === overlayPath
      );
    });
    vi.mocked(fs.readFileSync).mockImplementation((p: fs.PathLike | number) => {
      const str = String(p);
      if (str === overlayPath) {
        return `# room-specific overlay
[mcp_servers.ouroboros]
command = "/tmp/ouroboros/bin/ouroboros"
args = ["mcp", "serve"]

[mcp_servers.ouroboros.env]
OUROBOROS_AGENT_RUNTIME = "codex"
OUROBOROS_LLM_BACKEND = "codex"
`;
      }
      if (str === sessionConfigPath) {
        return sessionToml;
      }
      return '';
    });
    vi.mocked(fs.writeFileSync).mockImplementation(
      (p: fs.PathLike | number, data: string | NodeJS.ArrayBufferView) => {
        if (String(p) === sessionConfigPath) {
          sessionToml = String(data);
        }
      },
    );

    const codexGroup: RegisteredGroup = {
      ...testGroup,
      agentType: 'codex',
    };

    const resultPromise = runAgentProcess(
      codexGroup,
      testInput,
      () => {},
      async () => {},
    );

    fakeProc.emit('close', 0);
    const result = await resultPromise;
    expect(result.status).toBe('success');

    const tomlWrite = vi
      .mocked(fs.writeFileSync)
      .mock.calls.filter((call) => String(call[0]) === sessionConfigPath)
      .at(-1);
    const toml = String(tomlWrite?.[1]);
    expect(toml).toContain('[mcp_servers.ouroboros]');
    expect(toml).toContain('OUROBOROS_AGENT_RUNTIME = "codex"');
    expect(toml).toContain('[mcp_servers.ejclaw]');
  });

  it('waits for queued streamed output before resolving an error exit', async () => {
    let releaseOutputs: (() => void) | undefined;
    const outputsFlushed = new Promise<void>((resolve) => {
      releaseOutputs = resolve;
    });
    const onOutput = vi.fn(async () => {
      await outputsFlushed;
    });
    const resultPromise = runAgentProcess(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    emitOutputMarker(fakeProc, {
      status: 'error',
      result: null,
      error: 'No conversation found with session ID: stale',
    });
    emitOutputMarker(fakeProc, {
      status: 'error',
      result: null,
      error: 'Claude Code process exited with code 1',
      newSessionId: 'stale-session',
    });

    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 1);

    let settled = false;
    resultPromise.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(settled).toBe(false);

    releaseOutputs?.();
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(onOutput).toHaveBeenCalledTimes(2);
    expect(onOutput).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ newSessionId: 'stale-session' }),
    );
  });
});

describe('agent-runner room skill overrides', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.mocked(getStoredRoomSkillOverrides).mockReturnValue([]);
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes room skill overrides into runner environment setup', async () => {
    const skillOverride = {
      chatJid: testInput.chatJid,
      agentType: 'claude-code' as const,
      skillScope: 'runner',
      skillName: 'runner-off',
      enabled: false,
      createdAt: '2026-05-04T00:00:00.000Z',
      updatedAt: '2026-05-04T00:00:00.000Z',
    };
    vi.mocked(getStoredRoomSkillOverrides).mockReturnValue([skillOverride]);
    const prepareGroupEnvironmentSpy = vi.spyOn(
      agentRunnerEnvironment,
      'prepareGroupEnvironment',
    );

    const resultPromise = runAgentProcess(
      testGroup,
      testInput,
      () => {},
      async () => {},
    );

    fakeProc.emit('close', 0);
    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(getStoredRoomSkillOverrides).toHaveBeenCalledWith(testInput.chatJid);
    expect(prepareGroupEnvironmentSpy).toHaveBeenCalledWith(
      testGroup,
      testInput.isMain,
      testInput.chatJid,
      expect.objectContaining({
        skillOverrides: [skillOverride],
      }),
    );
  });
});

describe('agent-runner Codex goals', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.mocked(getStoredRoomSkillOverrides).mockReturnValue([]);
    fakeProc = createFakeProcess();
    vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
      const str = String(p);
      return (
        str.includes('dist/index.js') ||
        str.includes('dist/ipc-mcp-stdio.js') ||
        str.endsWith('/.codex/config.toml')
      );
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes Codex goal opt-in config through env and runner stdin payload', async () => {
    let stdinPayload = '';
    fakeProc.stdin.on('data', (chunk) => {
      stdinPayload += chunk.toString();
    });

    const codexGroup: RegisteredGroup = {
      ...testGroup,
      agentType: 'codex',
      agentConfig: {
        codexGoals: true,
      },
    };

    const resultPromise = runAgentProcess(
      codexGroup,
      testInput,
      () => {},
      async () => {},
    );

    fakeProc.emit('close', 0);
    const result = await resultPromise;
    expect(result.status).toBe('success');

    expect(JSON.parse(stdinPayload)).toMatchObject({
      prompt: 'Hello',
      codexGoals: true,
    });

    const spawnEnv = vi.mocked(spawn).mock.calls.at(-1)?.[2]?.env as
      | Record<string, string>
      | undefined;
    expect(spawnEnv?.CODEX_GOALS).toBe('true');
  });
});
