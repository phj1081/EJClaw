import type { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  AGENT_MAX_OUTPUT_SIZE,
  AGENT_TIMEOUT,
  IDLE_TIMEOUT,
  LOG_LEVEL,
} from './config.js';
import { logger } from './logger.js';
import { OUTPUT_END_MARKER, OUTPUT_START_MARKER } from './agent-protocol.js';
import type { AgentInput, AgentOutput } from './agent-runner.js';
import type { RegisteredGroup } from './types.js';
import { getErrorMessage } from './utils.js';

interface RunSpawnedAgentProcessArgs {
  proc: ChildProcess;
  group: RegisteredGroup;
  input: AgentInput;
  processName: string;
  logsDir: string;
  startTime: number;
  onOutput?: (output: AgentOutput) => Promise<void>;
}

function parseLegacyAgentOutput(stdout: string): AgentOutput {
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
  return JSON.parse(jsonLine) as AgentOutput;
}

export function runSpawnedAgentProcess(
  args: RunSpawnedAgentProcessArgs,
): Promise<AgentOutput> {
  const { proc, group, input, processName, logsDir, startTime, onOutput } =
    args;
  return new Promise((resolve) => {
    const stdoutStream = proc.stdout;
    const stderrStream = proc.stderr;
    if (!stdoutStream || !stderrStream) {
      resolve({
        status: 'error',
        result: null,
        error: 'Agent process stdio pipes are unavailable',
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    // Streaming output: parse OUTPUT_START/END marker pairs as they arrive.
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();

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
      setTimeout(() => {
        if (!proc.killed) proc.kill('SIGKILL');
      }, 15000);
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    stdoutStream.on('data', (data) => {
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

      if (!onOutput) {
        return;
      }

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
    });

    stderrStream.on('data', (data) => {
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
      const isVerbose = LOG_LEVEL === 'debug' || LOG_LEVEL === 'trace';
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

      try {
        const output = parseLegacyAgentOutput(stdout);
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
