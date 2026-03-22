/**
 * Agent Process Runner for NanoClaw
 * Spawns agent execution as direct host processes and handles IPC
 */
import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  AGENT_MAX_OUTPUT_SIZE,
  AGENT_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  TIMEZONE,
} from './config.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import { readEnvFile } from './env.js';
import { isPairedRoomJid } from './db.js';
import {
  readPairedRoomPrompt,
  readPlatformPrompt,
} from './platform-prompts.js';
import { AgentType, RegisteredGroup } from './types.js';

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

export interface AgentInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  runId?: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  agentType?: 'claude-code' | 'codex';
}

export interface AgentOutput {
  status: 'success' | 'error';
  result: string | null;
  phase?: 'progress' | 'final';
  newSessionId?: string;
  error?: string;
}

function syncDirectoryEntries(sources: string[], destination: string): void {
  for (const source of sources) {
    if (!fs.existsSync(source)) continue;
    for (const entry of fs.readdirSync(source)) {
      const srcPath = path.join(source, entry);
      const dstPath = path.join(destination, entry);
      if (fs.statSync(srcPath).isDirectory()) {
        fs.cpSync(srcPath, dstPath, { recursive: true });
      } else {
        fs.mkdirSync(destination, { recursive: true });
        fs.copyFileSync(srcPath, dstPath);
      }
    }
  }
}

function ensureClaudeSessionSettings(groupSessionsDir: string): void {
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  if (fs.existsSync(settingsFile)) return;

  fs.writeFileSync(
    settingsFile,
    JSON.stringify(
      {
        env: {
          CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
          CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
          CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
        },
      },
      null,
      2,
    ) + '\n',
  );
}

function buildBaseRunnerEnv(args: {
  group: RegisteredGroup;
  chatJid: string;
  isMain: boolean;
  groupDir: string;
  groupIpcDir: string;
  globalDir: string;
  groupSessionsDir: string;
  agentType: AgentType;
  envVars: Record<string, string>;
}): Record<string, string> {
  const cleanEnv = { ...(process.env as Record<string, string>) };
  for (const [key, value] of Object.entries(args.envVars)) {
    if (value && !cleanEnv[key]) cleanEnv[key] = value;
  }
  delete cleanEnv.CLAUDECODE;
  delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;

  const nodeBin = path.dirname(process.execPath);
  const npmGlobalBin = path.join(os.homedir(), '.npm-global', 'bin');
  const currentPath = cleanEnv.PATH || '/usr/local/bin:/usr/bin:/bin';
  const extraPaths = [nodeBin, npmGlobalBin].filter(
    (candidate) =>
      !currentPath.includes(candidate) && fs.existsSync(candidate),
  );

  return {
    ...cleanEnv,
    PATH:
      extraPaths.length > 0
        ? `${extraPaths.join(':')}:${currentPath}`
        : currentPath,
    TZ: TIMEZONE,
    HOME: os.homedir(),
    NANOCLAW_GROUP_DIR: args.groupDir,
    NANOCLAW_IPC_DIR: args.groupIpcDir,
    NANOCLAW_GLOBAL_DIR: args.globalDir,
    ...(args.group.workDir ? { NANOCLAW_WORK_DIR: args.group.workDir } : {}),
    NANOCLAW_CHAT_JID: args.chatJid,
    NANOCLAW_GROUP_FOLDER: args.group.folder,
    NANOCLAW_IS_MAIN: args.isMain ? '1' : '0',
    NANOCLAW_AGENT_TYPE: args.agentType,
    CLAUDE_CONFIG_DIR: args.groupSessionsDir,
  };
}

function prepareClaudeEnvironment(args: {
  env: Record<string, string>;
  envVars: Record<string, string>;
  group: RegisteredGroup;
}): void {
  if (args.envVars.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY) {
    args.env.ANTHROPIC_API_KEY =
      args.envVars.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || '';
  }
  if (args.envVars.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_AUTH_TOKEN) {
    args.env.ANTHROPIC_AUTH_TOKEN =
      args.envVars.ANTHROPIC_AUTH_TOKEN ||
      process.env.ANTHROPIC_AUTH_TOKEN ||
      '';
  }
  if (args.envVars.ANTHROPIC_BASE_URL || process.env.ANTHROPIC_BASE_URL) {
    args.env.ANTHROPIC_BASE_URL =
      args.envVars.ANTHROPIC_BASE_URL || process.env.ANTHROPIC_BASE_URL || '';
  }
  if (
    args.envVars.CLAUDE_CODE_OAUTH_TOKEN ||
    process.env.CLAUDE_CODE_OAUTH_TOKEN
  ) {
    args.env.CLAUDE_CODE_OAUTH_TOKEN =
      args.envVars.CLAUDE_CODE_OAUTH_TOKEN ||
      process.env.CLAUDE_CODE_OAUTH_TOKEN ||
      '';
  }
  for (const key of [
    'CLAUDE_MODEL',
    'CLAUDE_THINKING',
    'CLAUDE_THINKING_BUDGET',
    'CLAUDE_EFFORT',
  ]) {
    const value =
      args.envVars[key as keyof typeof args.envVars] || process.env[key];
    if (value) args.env[key] = value;
  }
  if (args.group.agentConfig?.claudeModel) {
    args.env.CLAUDE_MODEL = args.group.agentConfig.claudeModel;
  }
  if (args.group.agentConfig?.claudeEffort) {
    args.env.CLAUDE_EFFORT = args.group.agentConfig.claudeEffort;
  }
}

function prepareCodexSessionEnvironment(args: {
  env: Record<string, string>;
  envVars: Record<string, string>;
  projectRoot: string;
  group: RegisteredGroup;
  groupDir: string;
  chatJid: string;
  isMain: boolean;
  isPairedRoom: boolean;
}): void {
  const openaiKey =
    args.envVars.CODEX_OPENAI_API_KEY ||
    process.env.CODEX_OPENAI_API_KEY ||
    args.envVars.OPENAI_API_KEY ||
    process.env.OPENAI_API_KEY;
  if (openaiKey) args.env.OPENAI_API_KEY = openaiKey;

  const codexModel =
    args.group.agentConfig?.codexModel ||
    args.envVars.CODEX_MODEL ||
    process.env.CODEX_MODEL;
  if (codexModel) args.env.CODEX_MODEL = codexModel;

  const codexEffort =
    args.group.agentConfig?.codexEffort ||
    args.envVars.CODEX_EFFORT ||
    process.env.CODEX_EFFORT;
  if (codexEffort) args.env.CODEX_EFFORT = codexEffort;

  const hostCodexDir = path.join(os.homedir(), '.codex');
  const sessionCodexDir = path.join(
    DATA_DIR,
    'sessions',
    args.group.folder,
    '.codex',
  );
  fs.mkdirSync(sessionCodexDir, { recursive: true });

  const authSrc = path.join(hostCodexDir, 'auth.json');
  const authDst = path.join(sessionCodexDir, 'auth.json');
  if (fs.existsSync(authSrc)) fs.copyFileSync(authSrc, authDst);
  for (const file of ['config.toml', 'config.json']) {
    const src = path.join(hostCodexDir, file);
    const dst = path.join(sessionCodexDir, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dst);
    }
  }

  const overlayPath = path.join(args.groupDir, '.codex', 'config.toml');
  const sessionConfigPath = path.join(sessionCodexDir, 'config.toml');
  if (fs.existsSync(overlayPath)) {
    const overlayToml = fs.readFileSync(overlayPath, 'utf-8').trim();
    if (overlayToml) {
      const baseToml = fs.existsSync(sessionConfigPath)
        ? fs.readFileSync(sessionConfigPath, 'utf-8').trimEnd()
        : '';
      fs.writeFileSync(
        sessionConfigPath,
        [baseToml, overlayToml].filter(Boolean).join('\n\n') + '\n',
      );
    }
  }

  const sessionAgentsPath = path.join(sessionCodexDir, 'AGENTS.md');
  const sessionAgents = [
    readPlatformPrompt('codex', args.projectRoot),
    args.isPairedRoom
      ? readPairedRoomPrompt('codex', args.projectRoot)
      : undefined,
  ]
    .filter((value): value is string => Boolean(value))
    .join('\n\n---\n\n')
    .trim();
  if (sessionAgents) {
    fs.writeFileSync(sessionAgentsPath, sessionAgents + '\n');
  } else if (fs.existsSync(sessionAgentsPath)) {
    fs.unlinkSync(sessionAgentsPath);
  }

  syncDirectoryEntries(
    [
      path.join(os.homedir(), '.claude', 'skills'),
      path.join(args.projectRoot, 'runners', 'skills'),
    ],
    path.join(sessionCodexDir, 'skills'),
  );

  const mcpServerPath = path.join(
    args.projectRoot,
    'runners',
    'agent-runner',
    'dist',
    'ipc-mcp-stdio.js',
  );
  if (fs.existsSync(mcpServerPath)) {
    let toml = fs.existsSync(sessionConfigPath)
      ? fs.readFileSync(sessionConfigPath, 'utf-8')
      : '';
    toml = toml.replace(/\n?\[mcp_servers\.nanoclaw\][\s\S]*?(?=\n\[|$)/, '');
    toml = toml.replace(
      /\n?\[mcp_servers\.memento-mcp\][\s\S]*?(?=\n\[|$)/,
      '',
    );
    const mcpSection = `
[mcp_servers.nanoclaw]
command = "node"
args = [${JSON.stringify(mcpServerPath)}]

[mcp_servers.nanoclaw.env]
NANOCLAW_IPC_DIR = ${JSON.stringify(args.env.NANOCLAW_IPC_DIR)}
NANOCLAW_CHAT_JID = ${JSON.stringify(args.chatJid)}
NANOCLAW_GROUP_FOLDER = ${JSON.stringify(args.group.folder)}
NANOCLAW_IS_MAIN = ${JSON.stringify(args.isMain ? '1' : '0')}
NANOCLAW_AGENT_TYPE = ${JSON.stringify(args.env.NANOCLAW_AGENT_TYPE)}
`;
    const mementoSseUrl =
      args.envVars.MEMENTO_MCP_SSE_URL || process.env.MEMENTO_MCP_SSE_URL;
    const mementoAccessKey =
      args.envVars.MEMENTO_ACCESS_KEY || process.env.MEMENTO_ACCESS_KEY || '';
    const mementoRemotePath =
      args.envVars.MEMENTO_MCP_REMOTE_PATH ||
      process.env.MEMENTO_MCP_REMOTE_PATH ||
      'mcp-remote';
    const mementoSection = mementoSseUrl
      ? `
[mcp_servers.memento-mcp]
command = ${JSON.stringify(mementoRemotePath)}
args = [${JSON.stringify(mementoSseUrl)}, "--header", ${JSON.stringify(`Authorization:Bearer ${mementoAccessKey}`)}]
`
      : '';
    fs.writeFileSync(
      sessionConfigPath,
      toml.trimEnd() + '\n' + mcpSection + mementoSection,
    );
  }

  delete args.env.ANTHROPIC_API_KEY;
  delete args.env.ANTHROPIC_AUTH_TOKEN;
  delete args.env.ANTHROPIC_BASE_URL;
  delete args.env.CLAUDE_CODE_OAUTH_TOKEN;
  args.env.CODEX_HOME = sessionCodexDir;
}

/**
 * Prepare the group's environment: directories, sessions, env vars.
 * Returns the environment variables and paths for the runner process.
 */
function prepareGroupEnvironment(
  group: RegisteredGroup,
  isMain: boolean,
  chatJid: string,
): { env: Record<string, string>; groupDir: string; runnerDir: string } {
  const projectRoot = process.cwd();
  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  // Per-group Claude sessions directory
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  ensureClaudeSessionSettings(groupSessionsDir);

  // Sync skills into each group's .claude/ session dir
  // Sources: 1) user's global ~/.claude/skills  2) project workDir/.claude/skills  3) runners/skills/
  const workDirClaude = group.workDir
    ? path.join(group.workDir, '.claude')
    : null;
  const skillSources = [
    path.join(os.homedir(), '.claude', 'skills'),
    ...(workDirClaude ? [path.join(workDirClaude, 'skills')] : []),
    path.join(projectRoot, 'runners', 'skills'),
  ];
  syncDirectoryEntries(skillSources, path.join(groupSessionsDir, 'skills'));

  // Per-group IPC namespace
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });

  // Global memory directory (for non-main groups)
  const globalDir = path.join(GROUPS_DIR, 'global');
  const globalClaudeMdPath = path.join(globalDir, 'CLAUDE.md');
  const isPairedRoom = isPairedRoomJid(chatJid);

  const claudePlatformPrompt = readPlatformPrompt('claude-code', projectRoot);
  const claudePairedRoomPrompt = isPairedRoom
    ? readPairedRoomPrompt('claude-code', projectRoot)
    : undefined;
  const globalClaudeMemory =
    !isMain && fs.existsSync(globalClaudeMdPath)
      ? fs.readFileSync(globalClaudeMdPath, 'utf-8').trim()
      : undefined;
  const sessionClaudeMd = [
    claudePlatformPrompt,
    claudePairedRoomPrompt,
    globalClaudeMemory,
  ]
    .filter((value): value is string => Boolean(value))
    .join('\n\n---\n\n')
    .trim();
  const sessionClaudeMdPath = path.join(groupSessionsDir, 'CLAUDE.md');
  if (sessionClaudeMd) {
    fs.writeFileSync(sessionClaudeMdPath, sessionClaudeMd + '\n');
  } else if (fs.existsSync(sessionClaudeMdPath)) {
    fs.unlinkSync(sessionClaudeMdPath);
  }

  // Determine runner directory
  const agentType = group.agentType || 'claude-code';
  const runnerDirName = agentType === 'codex' ? 'codex-runner' : 'agent-runner';
  const runnerDir = path.join(projectRoot, 'runners', runnerDirName);

  // Build environment variables for the runner process
  const envVars = readEnvFile([
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_MODEL',
    'CLAUDE_THINKING',
    'CLAUDE_THINKING_BUDGET',
    'CLAUDE_EFFORT',
    'OPENAI_API_KEY',
    'CODEX_OPENAI_API_KEY',
    'CODEX_MODEL',
    'CODEX_EFFORT',
    'MEMENTO_MCP_SSE_URL',
    'MEMENTO_ACCESS_KEY',
    'MEMENTO_MCP_REMOTE_PATH',
  ]);

  const env = buildBaseRunnerEnv({
    group,
    chatJid,
    isMain,
    groupDir,
    groupIpcDir,
    globalDir,
    groupSessionsDir,
    agentType,
    envVars,
  });

  // Pass credentials directly (no proxy needed on host)
  if (agentType === 'codex') {
    prepareCodexSessionEnvironment({
      env,
      envVars,
      projectRoot,
      group,
      groupDir,
      chatJid,
      isMain,
      isPairedRoom,
    });
  } else {
    prepareClaudeEnvironment({ env, envVars, group });
  }

  return { env, groupDir, runnerDir };
}

export async function runAgentProcess(
  group: RegisteredGroup,
  input: AgentInput,
  onProcess: (proc: ChildProcess, processName: string) => void,
  onOutput?: (output: AgentOutput) => Promise<void>,
  envOverrides?: Record<string, string>,
): Promise<AgentOutput> {
  const startTime = Date.now();
  const { env, groupDir, runnerDir } = prepareGroupEnvironment(
    group,
    input.isMain,
    input.chatJid,
  );

  // Apply provider fallback overrides (e.g. Kimi env vars when Claude is in cooldown)
  if (envOverrides) {
    for (const [key, value] of Object.entries(envOverrides)) {
      if (value) env[key] = value;
    }
  }
  if (input.runId) {
    env.NANOCLAW_RUN_ID = input.runId;
  }

  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const processSuffix = input.runId || `${Date.now()}`;
  const processName = `nanoclaw-${safeName}-${processSuffix}`;

  // Check if runner is built
  const distEntry = path.join(runnerDir, 'dist', 'index.js');
  if (!fs.existsSync(distEntry)) {
    logger.error(
      { runnerDir, chatJid: input.chatJid, runId: input.runId },
      'Runner not built. Run: cd runners/agent-runner && npm install && npm run build',
    );
    return {
      status: 'error',
      result: null,
      error: `Runner not built at ${distEntry}. Run npm run build:runners first.`,
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
    const proc = spawn('node', [distEntry], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: runnerDir,
      env,
    });

    onProcess(proc, processName);

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
        if (line.includes('Turn in progress')) {
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

    proc.on('close', (code) => {
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
          error: `Failed to parse agent output: ${err instanceof Error ? err.message : String(err)}`,
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

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });
  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);
  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  _registeredJids?: Set<string>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });
  const visibleGroups = isMain ? groups : [];
  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      { groups: visibleGroups, lastSync: new Date().toISOString() },
      null,
      2,
    ),
  );
}
