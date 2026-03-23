import fs from 'fs';
import os from 'os';
import path from 'path';

import { GROUPS_DIR, TIMEZONE } from './config.js';
import { isPairedRoomJid } from './db.js';
import { readEnvFile } from './env.js';
import { getCurrentToken } from './token-rotation.js';
import {
  resolveGroupFolderPath,
  resolveGroupIpcPath,
  resolveGroupSessionsPath,
  resolveTaskRuntimeIpcPath,
  resolveTaskSessionsPath,
} from './group-folder.js';
import {
  readPairedRoomPrompt,
  readPlatformPrompt,
} from './platform-prompts.js';
import type { AgentType, RegisteredGroup } from './types.js';

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
  hostIpcDir: string;
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
    (candidate) => !currentPath.includes(candidate) && fs.existsSync(candidate),
  );

  return {
    ...cleanEnv,
    PATH:
      extraPaths.length > 0
        ? `${extraPaths.join(':')}:${currentPath}`
        : currentPath,
    TZ: TIMEZONE,
    HOME: os.homedir(),
    EJCLAW_GROUP_DIR: args.groupDir,
    EJCLAW_IPC_DIR: args.groupIpcDir,
    EJCLAW_HOST_IPC_DIR: args.hostIpcDir,
    EJCLAW_GLOBAL_DIR: args.globalDir,
    ...(args.group.workDir ? { EJCLAW_WORK_DIR: args.group.workDir } : {}),
    EJCLAW_CHAT_JID: args.chatJid,
    EJCLAW_GROUP_FOLDER: args.group.folder,
    EJCLAW_IS_MAIN: args.isMain ? '1' : '0',
    EJCLAW_AGENT_TYPE: args.agentType,
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
  {
    const oauthToken =
      args.envVars.CLAUDE_CODE_OAUTH_TOKEN ||
      getCurrentToken() ||
      process.env.CLAUDE_CODE_OAUTH_TOKEN;
    if (oauthToken) {
      args.env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
    }
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
  sessionRootDir: string;
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
  const sessionCodexDir = path.join(args.sessionRootDir, '.codex');
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
    toml = toml.replace(/\n?\[mcp_servers\.ejclaw\][\s\S]*?(?=\n\[|$)/, '');
    toml = toml.replace(
      /\n?\[mcp_servers\.memento-mcp\][\s\S]*?(?=\n\[|$)/,
      '',
    );
    const mcpSection = `
[mcp_servers.ejclaw]
command = "node"
args = [${JSON.stringify(mcpServerPath)}]

[mcp_servers.ejclaw.env]
EJCLAW_IPC_DIR = ${JSON.stringify(args.env.EJCLAW_IPC_DIR)}
EJCLAW_CHAT_JID = ${JSON.stringify(args.chatJid)}
EJCLAW_GROUP_FOLDER = ${JSON.stringify(args.group.folder)}
EJCLAW_IS_MAIN = ${JSON.stringify(args.isMain ? '1' : '0')}
EJCLAW_AGENT_TYPE = ${JSON.stringify(args.env.EJCLAW_AGENT_TYPE)}
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

export interface PreparedGroupEnvironment {
  env: Record<string, string>;
  groupDir: string;
  runnerDir: string;
}

export function prepareGroupEnvironment(
  group: RegisteredGroup,
  isMain: boolean,
  chatJid: string,
  options?: {
    runtimeTaskId?: string;
    useTaskScopedSession?: boolean;
  },
): PreparedGroupEnvironment {
  const projectRoot = process.cwd();
  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const runtimeTaskId = options?.runtimeTaskId;
  const useTaskScopedSession =
    options?.useTaskScopedSession === true && Boolean(runtimeTaskId);
  const sessionRootDir =
    runtimeTaskId && useTaskScopedSession
      ? resolveTaskSessionsPath(group.folder, runtimeTaskId)
      : resolveGroupSessionsPath(group.folder);

  const groupSessionsDir = path.join(sessionRootDir, '.claude');
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  ensureClaudeSessionSettings(groupSessionsDir);

  const workDirClaude = group.workDir
    ? path.join(group.workDir, '.claude')
    : null;
  const skillSources = [
    path.join(os.homedir(), '.claude', 'skills'),
    ...(workDirClaude ? [path.join(workDirClaude, 'skills')] : []),
    path.join(projectRoot, 'runners', 'skills'),
  ];
  syncDirectoryEntries(skillSources, path.join(groupSessionsDir, 'skills'));

  const groupIpcDir = runtimeTaskId
    ? resolveTaskRuntimeIpcPath(group.folder, runtimeTaskId)
    : resolveGroupIpcPath(group.folder);
  const hostIpcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });

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

  const agentType = group.agentType || 'claude-code';
  const runnerDirName = agentType === 'codex' ? 'codex-runner' : 'agent-runner';
  const runnerDir = path.join(projectRoot, 'runners', runnerDirName);

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
    hostIpcDir,
    globalDir,
    groupSessionsDir,
    agentType,
    envVars,
  });

  if (agentType === 'codex') {
    prepareCodexSessionEnvironment({
      env,
      envVars,
      projectRoot,
      group,
      groupDir,
      sessionRootDir,
      chatJid,
      isMain,
      isPairedRoom,
    });
  } else {
    prepareClaudeEnvironment({ env, envVars, group });
  }

  return { env, groupDir, runnerDir };
}
