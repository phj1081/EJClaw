/**
 * Agent Process Runner for EJClaw
 * Spawns agent execution as direct host processes and handles IPC
 */
import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { getErrorMessage } from './utils.js';
import {
  AGENT_MAX_OUTPUT_SIZE,
  AGENT_TIMEOUT,
  IDLE_TIMEOUT,
} from './config.js';
import {
  prepareContainerSessionEnvironment,
  prepareGroupEnvironment,
} from './agent-runner-environment.js';
import { getEnv } from './env.js';
export {
  type AvailableGroup,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './agent-runner-snapshot.js';
import { logger } from './logger.js';
import { OUTPUT_END_MARKER, OUTPUT_START_MARKER } from './agent-protocol.js';
import { runReviewerContainer } from './container-runner.js';
import {
  AgentOutputPhase,
  AgentType,
  RegisteredGroup,
  RoomRoleContext,
  StructuredAgentOutput,
} from './types.js';

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
  roomRoleContext?: RoomRoleContext;
}

export interface AgentOutput {
  status: 'success' | 'error';
  result: string | null;
  output?: StructuredAgentOutput;
  phase?: AgentOutputPhase;
  agentId?: string;
  agentLabel?: string;
  agentDone?: boolean;
  newSessionId?: string;
  error?: string;
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
  // ── Reviewer container mode ─────────────────────────────────────
  // Reviewers always run inside a Docker container with read-only source
  // mount for kernel-level write protection. Docker is required.
  if (
    envOverrides?.EJCLAW_REVIEWER_RUNTIME === '1' ||
    envOverrides?.EJCLAW_ARBITER_RUNTIME === '1'
  ) {
    const ownerWorkspaceDir =
      envOverrides?.EJCLAW_WORK_DIR || group.workDir || process.cwd();

    // Prepare session directory for the container (CLAUDE.md, skills, settings)
    // so the Claude SDK inside the container has platform & paired room prompts.
    const sessionDir = envOverrides?.CLAUDE_CONFIG_DIR;
    if (sessionDir) {
      const containerRole =
        envOverrides?.EJCLAW_ARBITER_RUNTIME === '1'
          ? ('arbiter' as const)
          : ('reviewer' as const);
      prepareContainerSessionEnvironment({
        sessionDir,
        chatJid: input.chatJid,
        isMain: input.isMain,
        memoryBriefing: input.memoryBriefing,
        role: containerRole,
      });
      // For codex: also write AGENTS.md to the reviewer session dir, because
      // the container's /home/node/.claude always mounts the reviewer session.
      // Arbiter and reviewer never run simultaneously, so this is safe.
      if (containerRole === 'arbiter') {
        const reviewerSessionDir = path.join(
          path.dirname(sessionDir),
          `${group.folder}-reviewer`,
        );
        const reviewerCodexDir = path.join(reviewerSessionDir, '.codex');
        if (fs.existsSync(reviewerSessionDir)) {
          fs.mkdirSync(reviewerCodexDir, { recursive: true });
          const arbiterAgentsMd = path.join(sessionDir, '.codex', 'AGENTS.md');
          if (fs.existsSync(arbiterAgentsMd)) {
            fs.copyFileSync(
              arbiterAgentsMd,
              path.join(reviewerCodexDir, 'AGENTS.md'),
            );
          }
        }
      }
    }

    return runReviewerContainer({
      group,
      input: {
        prompt: input.prompt,
        sessionId: input.sessionId,
        groupFolder: input.groupFolder,
        chatJid: input.chatJid,
        runId: input.runId || `${Date.now()}`,
        isMain: input.isMain,
        assistantName: input.assistantName,
        roomRoleContext: input.roomRoleContext,
      },
      ownerWorkspaceDir,
      envOverrides,
      onOutput,
      onProcess: (proc, containerName) => {
        onProcess(proc, containerName, '');
      },
    });
  }

  // ── Host process mode (owner) ───────────────────────────────────
  const startTime = Date.now();
  const { env, groupDir, runnerDir } = prepareGroupEnvironment(
    group,
    input.isMain,
    input.chatJid,
    {
      memoryBriefing: input.memoryBriefing,
      runtimeTaskId: input.runtimeTaskId,
      useTaskScopedSession: input.useTaskScopedSession,
    },
  );

  // Apply env overrides (caller-provided)
  if (envOverrides) {
    for (const [key, value] of Object.entries(envOverrides)) {
      if (value) env[key] = value;
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

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    proc.stdin.write(JSON.stringify(input));
    proc.stdin.end();

    // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();

    proc.stdout.on('data', (data) => {
      const chunk = data.toString();

      if (!stdoutTruncated) {
        const remaining = AGENT_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            {
              group: group.name,
              chatJid: input.chatJid,
              runId: input.runId,
              size: stdout.length,
            },
            'Agent stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      if (onOutput) {
        parseBuffer += chunk;
        let startIdx: number;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break;

          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const parsed: AgentOutput = JSON.parse(jsonStr);
            if (parsed.newSessionId) {
              newSessionId = parsed.newSessionId;
            }
            hadStreamingOutput = true;
            resetTimeout();
            if (parsed.status === 'error') {
              logger.warn(
                {
                  group: group.name,
                  chatJid: input.chatJid,
                  runId: input.runId,
                  error: parsed.error,
                  newSessionId: parsed.newSessionId,
                },
                'Streamed agent error output',
              );
            }
            outputChain = outputChain.then(() => onOutput(parsed));
          } catch (err) {
            logger.warn(
              {
                group: group.name,
                chatJid: input.chatJid,
                runId: input.runId,
                error: err,
              },
              'Failed to parse streamed output chunk',
            );
          }
        }
      }
    });

    let timedOut = false;
    let hadStreamingOutput = false;
    const configTimeout = group.agentConfig?.timeout || AGENT_TIMEOUT;
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        {
          group: group.name,
          chatJid: input.chatJid,
          runId: input.runId,
          processName,
        },
        'Agent timeout, sending SIGTERM',
      );
      proc.kill('SIGTERM');
      // Force kill after 15s if still alive
      setTimeout(() => {
        if (!proc.killed) proc.kill('SIGKILL');
      }, 15000);
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    proc.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (!line) continue;
        if (
          line.includes('Turn in progress') ||
          line.includes('Subagent') ||
          line.includes('Intermediate assistant') ||
          line.includes('Promoting') ||
          line.includes('Flushing') ||
          line.includes('Result #') ||
          line.includes('Query done') ||
          line.includes('Terminal') ||
          line.includes('Assistant: stop=') ||
          line.includes('Close sentinel')
        ) {
          logger.info(
            { group: group.name, chatJid: input.chatJid, runId: input.runId },
            line.replace(/^\[.*?\]\s*/, ''),
          );
        } else {
          logger.debug(
            { agent: group.folder, chatJid: input.chatJid, runId: input.runId },
            line,
          );
        }
      }
      // Stderr activity means agent is alive — reset timeout
      resetTimeout();
      if (stderrTruncated) return;
      const remaining = AGENT_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
      } else {
        stderr += chunk;
      }
    });

    proc.on('close', (code, signal) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      if (timedOut) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        fs.writeFileSync(
          path.join(logsDir, `agent-${input.runId || 'adhoc'}-${ts}.log`),
          [
            `=== Agent Run Log (TIMEOUT) ===`,
            `Timestamp: ${new Date().toISOString()}`,
            `Group: ${group.name}`,
            `ChatJid: ${input.chatJid}`,
            `RunId: ${input.runId || 'n/a'}`,
            `Process: ${processName}`,
            `Duration: ${duration}ms`,
            `Exit Code: ${code}`,
            `Signal: ${signal}`,
            `Had Streaming Output: ${hadStreamingOutput}`,
          ].join('\n'),
        );

        if (hadStreamingOutput) {
          logger.info(
            {
              group: group.name,
              chatJid: input.chatJid,
              runId: input.runId,
              processName,
              duration,
              code,
              signal,
            },
            'Agent timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            resolve({ status: 'success', result: null, newSessionId });
          });
          return;
        }

        resolve({
          status: 'error',
          result: null,
          error: `Agent timed out after ${configTimeout}ms`,
        });
        return;
      }

      // Signal kill (SIGTERM/SIGKILL) from post-close cleanup or service
      // restart.  When the agent already delivered streaming output this is
      // normal lifecycle — not an error.
      if (code === null && signal) {
        if (hadStreamingOutput) {
          logger.info(
            {
              group: group.name,
              chatJid: input.chatJid,
              runId: input.runId,
              processName,
              duration,
              signal,
            },
            'Agent terminated by signal after output delivery (normal cleanup)',
          );
          outputChain.then(() => {
            resolve({ status: 'success', result: null, newSessionId });
          });
          return;
        }
        // No output delivered before signal kill — genuine error
        logger.error(
          {
            group: group.name,
            chatJid: input.chatJid,
            runId: input.runId,
            processName,
            duration,
            signal,
          },
          'Agent killed by signal before producing output',
        );
        outputChain.then(() => {
          resolve({
            status: 'error',
            result: null,
            error: `Agent killed by ${signal} before producing output`,
          });
        });
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(
        logsDir,
        `agent-${input.runId || 'adhoc'}-${timestamp}.log`,
      );
      const isVerbose =
        process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Agent Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `ChatJid: ${input.chatJid}`,
        `GroupFolder: ${input.groupFolder}`,
        `RunId: ${input.runId || 'n/a'}`,
        `IsMain: ${input.isMain}`,
        `AgentType: ${group.agentType || 'claude-code'}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Signal: ${signal}`,
        ``,
      ];

      const isError = code !== 0;
      if (isVerbose || isError) {
        logLines.push(
          `=== Input ===`,
          JSON.stringify(input, null, 2),
          ``,
          `=== Stderr ===`,
          stderr,
          ``,
          `=== Stdout ===`,
          stdout,
        );
      } else {
        logLines.push(
          `Prompt length: ${input.prompt.length} chars`,
          `Session ID: ${input.sessionId || 'new'}`,
        );
      }

      fs.writeFileSync(logFile, logLines.join('\n'));

      if (code !== 0) {
        logger.error(
          {
            group: group.name,
            chatJid: input.chatJid,
            runId: input.runId,
            code,
            duration,
            logFile,
          },
          'Agent exited with error',
        );
        // Wait for any queued streamed-output handlers to finish so a late
        // newSessionId cannot be persisted after the caller clears a poisoned
        // session.
        outputChain.then(() => {
          resolve({
            status: 'error',
            result: null,
            error: `Agent exited with code ${code}: ${stderr.slice(-200)}`,
          });
        });
        return;
      }

      if (onOutput) {
        outputChain.then(() => {
          logger.info(
            {
              group: group.name,
              chatJid: input.chatJid,
              runId: input.runId,
              duration,
              newSessionId,
            },
            'Agent completed (streaming mode)',
          );
          resolve({ status: 'success', result: null, newSessionId });
        });
        return;
      }

      // Legacy mode: parse output from stdout
      try {
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);
        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }
        const output: AgentOutput = JSON.parse(jsonLine);
        logger.info(
          {
            group: group.name,
            chatJid: input.chatJid,
            runId: input.runId,
            duration,
            status: output.status,
          },
          'Agent completed',
        );
        resolve(output);
      } catch (err) {
        logger.error(
          {
            group: group.name,
            chatJid: input.chatJid,
            runId: input.runId,
            error: err,
          },
          'Failed to parse agent output',
        );
        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse agent output: ${getErrorMessage(err)}`,
        });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      logger.error(
        {
          group: group.name,
          chatJid: input.chatJid,
          runId: input.runId,
          processName,
          error: err,
        },
        'Agent spawn error',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Agent spawn error: ${err.message}`,
      });
    });
  });
}
