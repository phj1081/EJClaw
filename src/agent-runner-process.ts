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
  onTerminalStreamedOutputFlushed?: (output: AgentOutput) => void;
}

interface AgentProcessStreamState {
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  parseBuffer: string;
  newSessionId: string | undefined;
  outputChain: Promise<void>;
  timedOut: boolean;
  hadStreamingOutput: boolean;
}

interface ProcessCloseContext {
  args: RunSpawnedAgentProcessArgs;
  state: AgentProcessStreamState;
  resolve: (output: AgentOutput) => void;
  configTimeout: number;
  duration: number;
  code: number | null;
  signal: NodeJS.Signals | null;
}

function isTerminalStreamedOutput(output: AgentOutput): boolean {
  return (output.phase ?? 'final') !== 'progress';
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

function logStreamedOutputDeliveryError(
  err: unknown,
  group: RegisteredGroup,
  input: AgentInput,
): void {
  logger.warn(
    {
      group: group.name,
      chatJid: input.chatJid,
      runId: input.runId,
      error: getErrorMessage(err),
    },
    'Streamed agent output delivery failed',
  );
}

function logStreamedAgentErrorOutput(
  output: AgentOutput,
  group: RegisteredGroup,
  input: AgentInput,
): void {
  if (output.status !== 'error') return;
  logger.warn(
    {
      group: group.name,
      chatJid: input.chatJid,
      runId: input.runId,
      error: output.error,
      newSessionId: output.newSessionId,
    },
    'Streamed agent error output',
  );
}

function chainStreamedOutputDelivery(args: {
  outputChain: Promise<void>;
  parsed: AgentOutput;
  onOutput: (output: AgentOutput) => Promise<void>;
  onTerminalStreamedOutputFlushed?: (output: AgentOutput) => void;
  group: RegisteredGroup;
  input: AgentInput;
}): Promise<void> {
  return args.outputChain.then(async () => {
    try {
      await args.onOutput(args.parsed);
      if (isTerminalStreamedOutput(args.parsed)) {
        args.onTerminalStreamedOutputFlushed?.(args.parsed);
      }
    } catch (err) {
      logStreamedOutputDeliveryError(err, args.group, args.input);
    }
  });
}

function writeTimeoutLog(args: {
  logsDir: string;
  input: AgentInput;
  group: RegisteredGroup;
  processName: string;
  duration: number;
  code: number | null;
  signal: NodeJS.Signals | null;
  hadStreamingOutput: boolean;
}): void {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  fs.writeFileSync(
    path.join(args.logsDir, `agent-${args.input.runId || 'adhoc'}-${ts}.log`),
    [
      `=== Agent Run Log (TIMEOUT) ===`,
      `Timestamp: ${new Date().toISOString()}`,
      `Group: ${args.group.name}`,
      `ChatJid: ${args.input.chatJid}`,
      `RunId: ${args.input.runId || 'n/a'}`,
      `Process: ${args.processName}`,
      `Duration: ${args.duration}ms`,
      `Exit Code: ${args.code}`,
      `Signal: ${args.signal}`,
      `Had Streaming Output: ${args.hadStreamingOutput}`,
    ].join('\n'),
  );
}

function appendStdoutChunk(
  state: AgentProcessStreamState,
  chunk: string,
  group: RegisteredGroup,
  input: AgentInput,
): void {
  if (state.stdoutTruncated) return;
  const remaining = AGENT_MAX_OUTPUT_SIZE - state.stdout.length;
  if (chunk.length > remaining) {
    state.stdout += chunk.slice(0, remaining);
    state.stdoutTruncated = true;
    logger.warn(
      {
        group: group.name,
        chatJid: input.chatJid,
        runId: input.runId,
        size: state.stdout.length,
      },
      'Agent stdout truncated due to size limit',
    );
  } else {
    state.stdout += chunk;
  }
}

function consumeStreamedOutputMarkers(args: {
  state: AgentProcessStreamState;
  onOutput: (output: AgentOutput) => Promise<void>;
  onTerminalStreamedOutputFlushed?: (output: AgentOutput) => void;
  group: RegisteredGroup;
  input: AgentInput;
  resetTimeout: () => void;
}): void {
  const { state, group, input } = args;
  let startIdx: number;
  while ((startIdx = state.parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
    const endIdx = state.parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
    if (endIdx === -1) break;

    const jsonStr = state.parseBuffer
      .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
      .trim();
    state.parseBuffer = state.parseBuffer.slice(
      endIdx + OUTPUT_END_MARKER.length,
    );

    try {
      const parsed: AgentOutput = JSON.parse(jsonStr);
      if (parsed.newSessionId) {
        state.newSessionId = parsed.newSessionId;
      }
      state.hadStreamingOutput = true;
      args.resetTimeout();
      logStreamedAgentErrorOutput(parsed, group, input);
      state.outputChain = chainStreamedOutputDelivery({
        outputChain: state.outputChain,
        parsed,
        onOutput: args.onOutput,
        onTerminalStreamedOutputFlushed: args.onTerminalStreamedOutputFlushed,
        group,
        input,
      });
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

function handleStderrChunk(args: {
  state: AgentProcessStreamState;
  chunk: string;
  group: RegisteredGroup;
  input: AgentInput;
  resetTimeout: () => void;
}): void {
  const { state, chunk, group, input } = args;
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
  args.resetTimeout();
  if (state.stderrTruncated) return;
  const remaining = AGENT_MAX_OUTPUT_SIZE - state.stderr.length;
  if (chunk.length > remaining) {
    state.stderr += chunk.slice(0, remaining);
    state.stderrTruncated = true;
  } else {
    state.stderr += chunk;
  }
}

function resolveTimedOutClose(ctx: ProcessCloseContext): void {
  const { args, state, resolve } = ctx;
  const { group, input, processName, logsDir } = args;
  writeTimeoutLog({
    logsDir,
    input,
    group,
    processName,
    duration: ctx.duration,
    code: ctx.code,
    signal: ctx.signal,
    hadStreamingOutput: state.hadStreamingOutput,
  });

  if (state.hadStreamingOutput) {
    logger.info(
      {
        group: group.name,
        chatJid: input.chatJid,
        runId: input.runId,
        processName,
        duration: ctx.duration,
        code: ctx.code,
        signal: ctx.signal,
      },
      'Agent timed out after output (idle cleanup)',
    );
    state.outputChain.then(() => {
      resolve({
        status: 'success',
        result: null,
        newSessionId: state.newSessionId,
      });
    });
    return;
  }

  resolve({
    status: 'error',
    result: null,
    error: `Agent timed out after ${ctx.configTimeout}ms`,
  });
}

function resolveSignalClose(ctx: ProcessCloseContext): void {
  const { args, state, resolve } = ctx;
  const { group, input, processName } = args;
  if (state.hadStreamingOutput) {
    logger.info(
      {
        group: group.name,
        chatJid: input.chatJid,
        runId: input.runId,
        processName,
        duration: ctx.duration,
        signal: ctx.signal,
      },
      'Agent terminated by signal after output delivery (normal cleanup)',
    );
    state.outputChain.then(() => {
      resolve({
        status: 'success',
        result: null,
        newSessionId: state.newSessionId,
      });
    });
    return;
  }

  logger.error(
    {
      group: group.name,
      chatJid: input.chatJid,
      runId: input.runId,
      processName,
      duration: ctx.duration,
      signal: ctx.signal,
    },
    'Agent killed by signal before producing output',
  );
  state.outputChain.then(() => {
    resolve({
      status: 'error',
      result: null,
      error: `Agent killed by ${ctx.signal} before producing output`,
    });
  });
}

function writeAgentRunLog(ctx: ProcessCloseContext): string {
  const { args, state } = ctx;
  const { group, input, logsDir } = args;
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
    `Duration: ${ctx.duration}ms`,
    `Exit Code: ${ctx.code}`,
    `Signal: ${ctx.signal}`,
    ``,
  ];

  const isError = ctx.code !== 0;
  if (isVerbose || isError) {
    logLines.push(
      `=== Input ===`,
      JSON.stringify(input, null, 2),
      ``,
      `=== Stderr ===`,
      state.stderr,
      ``,
      `=== Stdout ===`,
      state.stdout,
    );
  } else {
    logLines.push(
      `Prompt length: ${input.prompt.length} chars`,
      `Session ID: ${input.sessionId || 'new'}`,
    );
  }

  fs.writeFileSync(logFile, logLines.join('\n'));
  return logFile;
}

function resolveErrorExitClose(
  ctx: ProcessCloseContext,
  logFile: string,
): void {
  const { args, state, resolve } = ctx;
  const { group, input } = args;
  logger.error(
    {
      group: group.name,
      chatJid: input.chatJid,
      runId: input.runId,
      code: ctx.code,
      duration: ctx.duration,
      logFile,
    },
    'Agent exited with error',
  );
  state.outputChain.then(() => {
    resolve({
      status: 'error',
      result: null,
      error: `Agent exited with code ${ctx.code}: ${state.stderr.slice(-200)}`,
    });
  });
}

function resolveStreamingSuccessClose(ctx: ProcessCloseContext): void {
  const { args, state, resolve } = ctx;
  const { group, input } = args;
  state.outputChain.then(() => {
    logger.info(
      {
        group: group.name,
        chatJid: input.chatJid,
        runId: input.runId,
        duration: ctx.duration,
        newSessionId: state.newSessionId,
      },
      'Agent completed (streaming mode)',
    );
    resolve({
      status: 'success',
      result: null,
      newSessionId: state.newSessionId,
    });
  });
}

function resolveLegacyOutputClose(ctx: ProcessCloseContext): void {
  const { args, state, resolve } = ctx;
  const { group, input } = args;
  try {
    const output = parseLegacyAgentOutput(state.stdout);
    logger.info(
      {
        group: group.name,
        chatJid: input.chatJid,
        runId: input.runId,
        duration: ctx.duration,
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
}

function handleProcessClose(ctx: ProcessCloseContext): void {
  if (ctx.state.timedOut) {
    resolveTimedOutClose(ctx);
    return;
  }

  if (ctx.code === null && ctx.signal) {
    resolveSignalClose(ctx);
    return;
  }

  const logFile = writeAgentRunLog(ctx);

  if (ctx.code !== 0) {
    resolveErrorExitClose(ctx, logFile);
    return;
  }

  if (ctx.args.onOutput) {
    resolveStreamingSuccessClose(ctx);
    return;
  }

  resolveLegacyOutputClose(ctx);
}

export function runSpawnedAgentProcess(
  args: RunSpawnedAgentProcessArgs,
): Promise<AgentOutput> {
  const { proc, group, input, processName, startTime, onOutput } = args;
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

    const state: AgentProcessStreamState = {
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      // Streaming output: parse OUTPUT_START/END marker pairs as they arrive.
      parseBuffer: '',
      newSessionId: undefined,
      outputChain: Promise.resolve(),
      timedOut: false,
      hadStreamingOutput: false,
    };

    const configTimeout = group.agentConfig?.timeout || AGENT_TIMEOUT;
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      state.timedOut = true;
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

      appendStdoutChunk(state, chunk, group, input);

      if (!onOutput) {
        return;
      }

      state.parseBuffer += chunk;
      consumeStreamedOutputMarkers({
        state,
        onOutput,
        onTerminalStreamedOutputFlushed: args.onTerminalStreamedOutputFlushed,
        group,
        input,
        resetTimeout,
      });
    });

    stderrStream.on('data', (data) => {
      handleStderrChunk({
        state,
        chunk: data.toString(),
        group,
        input,
        resetTimeout,
      });
    });

    proc.on('close', (code, signal) => {
      clearTimeout(timeout);
      handleProcessClose({
        args,
        state,
        resolve,
        configTimeout,
        duration: Date.now() - startTime,
        code,
        signal,
      });
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
