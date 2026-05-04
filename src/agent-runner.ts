import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { isUnsafeHostPairedModeEnabled } from 'ejclaw-runners-shared';

/**
 * Agent Process Runner for EJClaw
 * Spawns agent execution as direct host processes and handles IPC.
 */
import {
  prepareReadonlySessionEnvironment,
  prepareGroupEnvironment,
} from './agent-runner-environment.js';
import { runSpawnedAgentProcess } from './agent-runner-process.js';
import { getStoredRoomSkillOverrides } from './db.js';
export {
  type AvailableGroup,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './agent-runner-snapshot.js';
import { logger } from './logger.js';
import { RegisteredGroup, RoomRoleContext } from './types.js';
import type { StoredRoomSkillOverride } from './db/rooms.js';

export interface AgentInput {
  prompt: string;
  sessionId?: string;
  memoryBriefing?: string;
  groupFolder: string;
  chatJid: string;
  runId?: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  runtimeTaskId?: string;
  useTaskScopedSession?: boolean;
  assistantName?: string;
  agentType?: 'claude-code' | 'codex';
  codexGoals?: boolean;
  roomRoleContext?: RoomRoleContext;
}

export interface AgentOutput {
  status: 'success' | 'error';
  result: string | null;
  output?: import('./types.js').StructuredAgentOutput;
  phase?: import('./types.js').AgentOutputPhase;
  agentId?: string;
  agentLabel?: string;
  agentDone?: boolean;
  newSessionId?: string;
  error?: string;
}

function readRoomSkillOverridesForRunner(
  chatJid: string,
): StoredRoomSkillOverride[] {
  try {
    return getStoredRoomSkillOverrides(chatJid);
  } catch (err) {
    logger.warn(
      {
        err,
        chatJid,
      },
      'Failed to read room skill overrides; falling back to default skills',
    );
    return [];
  }
}

export async function runAgentProcess(
  group: RegisteredGroup,
  input: AgentInput,
  onProcess: (
    proc: ChildProcess,
    processName: string,
    runtimeIpcDir: string,
  ) => void,
  onOutput?: (output: AgentOutput) => Promise<void>,
  envOverrides?: Record<string, string>,
): Promise<AgentOutput> {
  const unsafeHostPairedMode = isUnsafeHostPairedModeEnabled(envOverrides);

  // ── Host process mode (owner) ───────────────────────────────────
  const startTime = Date.now();
  const skillOverrides = readRoomSkillOverridesForRunner(input.chatJid);
  const { env, groupDir, runnerDir } = prepareGroupEnvironment(
    group,
    input.isMain,
    input.chatJid,
    {
      memoryBriefing: input.memoryBriefing,
      runtimeTaskId: input.runtimeTaskId,
      useTaskScopedSession: input.useTaskScopedSession,
      skillOverrides,
    },
  );

  // Apply env overrides (caller-provided)
  if (envOverrides) {
    for (const [key, value] of Object.entries(envOverrides)) {
      if (value) env[key] = value;
    }
  }
  if (
    unsafeHostPairedMode &&
    envOverrides?.CLAUDE_CONFIG_DIR &&
    (input.roomRoleContext?.role === 'reviewer' ||
      input.roomRoleContext?.role === 'arbiter')
  ) {
    const readonlySession = prepareReadonlySessionEnvironment({
      sessionDir: envOverrides.CLAUDE_CONFIG_DIR,
      chatJid: input.chatJid,
      isMain: input.isMain,
      groupFolder: group.folder,
      agentType: group.agentType || 'claude-code',
      memoryBriefing: input.memoryBriefing,
      role: input.roomRoleContext.role,
      ipcDir: env.EJCLAW_IPC_DIR,
      hostIpcDir: env.EJCLAW_HOST_IPC_DIR,
      workDir: envOverrides.EJCLAW_WORK_DIR || env.EJCLAW_WORK_DIR,
      skillOverrides,
    });
    if ((group.agentType || 'claude-code') === 'codex') {
      env.CODEX_HOME = path.join(envOverrides.CLAUDE_CONFIG_DIR, '.codex');
      if (readonlySession.codexHomeDir) {
        env.HOME = readonlySession.codexHomeDir;
      }
    }
  }
  if (input.runId) {
    env.EJCLAW_RUN_ID = input.runId;
  }

  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const processSuffix = input.runId || `${Date.now()}`;
  const processName = `ejclaw-${safeName}-${processSuffix}`;

  // Check if runner is built
  const distEntry = path.join(runnerDir, 'dist', 'index.js');
  if (!fs.existsSync(distEntry)) {
    logger.error(
      { runnerDir, chatJid: input.chatJid, runId: input.runId },
      'Runner not built. Run: cd runners/agent-runner && bun install && bun run build',
    );
    return {
      status: 'error',
      result: null,
      error: `Runner not built at ${distEntry}. Run bun run build:runners first.`,
    };
  }

  logger.info(
    {
      group: group.name,
      chatJid: input.chatJid,
      groupFolder: input.groupFolder,
      runId: input.runId,
      processName,
      agentType: group.agentType || 'claude-code',
      isMain: input.isMain,
    },
    'Spawning agent process',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return new Promise((resolve) => {
    const proc = spawn('bun', [distEntry], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: runnerDir,
      env,
    });

    onProcess(proc, processName, env.EJCLAW_IPC_DIR);

    const runnerInput: AgentInput = {
      ...input,
      ...(group.agentConfig?.codexGoals === true ? { codexGoals: true } : {}),
    };
    proc.stdin.write(JSON.stringify(runnerInput));
    proc.stdin.end();

    runSpawnedAgentProcess({
      proc,
      group,
      input: runnerInput,
      processName,
      logsDir,
      startTime,
      onOutput,
    }).then(resolve);
  });
}
