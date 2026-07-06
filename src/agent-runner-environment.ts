import fs from 'fs';
import os from 'os';
import path from 'path';
import { EJCLAW_ENV } from 'ejclaw-runners-shared';

import {
  GROUPS_DIR,
  SERVICE_ID,
  SERVICE_SESSION_SCOPE,
  TIMEZONE,
  isReviewService,
} from './config.js';
import { logger } from './logger.js';
import { readEnvFile } from './env.js';
import {
  hasDisabledSkillOverrides,
  syncDirectoryEntries,
  syncRoomSkillDirectories,
} from './agent-runner-environment-skills.js';
import {
  claimCodexAuthLease,
  findCodexAccountIndexByAuthPath,
  getActiveCodexAuthPath,
  getCodexAccountCount,
  type CodexAuthLease,
} from './codex-token-rotation.js';
import { readCodexFeatureFromFile } from './codex-config-features.js';
import { ensureClaudeSessionSettings } from './claude-session-settings.js';
import {
  getConfiguredClaudeTokens,
  getCurrentToken,
} from './token-rotation.js';
import {
  resolveGroupFolderPath,
  resolveGroupIpcPath,
  resolveServiceGroupSessionsPath,
  resolveTaskRuntimeIpcPath,
  resolveServiceTaskSessionsPath,
} from './group-folder.js';
import {
  readArbiterPrompt,
  readPairedRoomPrompt,
  readPlatformPrompt,
} from './platform-prompts.js';
import {
  getEffectiveChannelLease,
  hasReviewerLease,
} from './service-routing.js';
import type { AgentType, PairedRoomRole, RegisteredGroup } from './types.js';
import type { StoredRoomSkillOverride } from './db/rooms.js';

// writeCodexApiKeyAuth removed — Codex uses OAuth only.
// API key auth caused unintended billing.

function readOptionalPromptFile(
  projectRoot: string,
  filename: string,
): string | undefined {
  const promptPath = path.join(projectRoot, 'prompts', filename);
  if (!fs.existsSync(promptPath)) return undefined;
  const prompt = fs.readFileSync(promptPath, 'utf-8').trim();
  return prompt || undefined;
}

function ensureClaudeGlobalSettingsFile(sessionDir: string): void {
  const settingsFile = path.join(sessionDir, '.claude.json');
  if (fs.existsSync(settingsFile)) return;

  fs.writeFileSync(settingsFile, '{}\n');
}

export interface PreparedCodexSessionAuth {
  canonicalAuthPath: string;
  /**
   * Path Codex will mutate during the run. For leased accounts this is the
   * canonical auth file itself, not a persistent session copy.
   */
  sessionAuthPath: string;
  /** Directory passed to CODEX_HOME for this run. */
  codexHomeDir?: string;
  accountIndex: number | null;
  lease?: CodexAuthLease;
}

function comparablePath(value: string): string {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return path.resolve(value);
  }
}

function isSamePath(a: string, b: string): boolean {
  return comparablePath(a) === comparablePath(b);
}

function syncHostCodexConfigFiles(
  destinationCodexDir: string,
  opts?: { resetMissing?: boolean },
): void {
  const hostCodexDir = path.join(os.homedir(), '.codex');
  fs.mkdirSync(destinationCodexDir, { recursive: true });
  for (const file of ['config.toml', 'config.json']) {
    const src = path.join(hostCodexDir, file);
    const dst = path.join(destinationCodexDir, file);
    if (isSamePath(src, dst)) continue;
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dst);
    } else if (opts?.resetMissing && fs.existsSync(dst)) {
      fs.unlinkSync(dst);
    }
  }
}

function removeStaleSessionCodexAuth(sessionCodexDir: string): void {
  const authDst = path.join(sessionCodexDir, 'auth.json');
  if (fs.existsSync(authDst)) fs.unlinkSync(authDst);
}

function syncHostCodexSessionFiles(
  sessionCodexDir: string,
): PreparedCodexSessionAuth | null {
  const hostCodexDir = path.join(os.homedir(), '.codex');
  fs.mkdirSync(sessionCodexDir, { recursive: true });

  const authDst = path.join(sessionCodexDir, 'auth.json');
  const hasRotationAccounts = getCodexAccountCount() > 0;
  const lease = claimCodexAuthLease();

  if (lease?.authPath && fs.existsSync(lease.authPath)) {
    try {
      const codexHomeDir = path.dirname(lease.authPath);
      removeStaleSessionCodexAuth(sessionCodexDir);
      syncHostCodexConfigFiles(codexHomeDir, { resetMissing: true });
      return {
        canonicalAuthPath: lease.authPath,
        sessionAuthPath: lease.authPath,
        codexHomeDir,
        accountIndex: lease.accountIndex,
        lease,
      };
    } catch (err) {
      lease.release();
      throw err;
    }
  }
  lease?.release();

  const rotatedAuthSrc = !hasRotationAccounts ? getActiveCodexAuthPath() : null;
  const fallbackAuthSrc = path.join(hostCodexDir, 'auth.json');
  const authSrc =
    rotatedAuthSrc && fs.existsSync(rotatedAuthSrc)
      ? rotatedAuthSrc
      : !hasRotationAccounts && fs.existsSync(fallbackAuthSrc)
        ? fallbackAuthSrc
        : null;
  if (authSrc) {
    fs.copyFileSync(authSrc, authDst);
  } else if (fs.existsSync(authDst)) {
    fs.unlinkSync(authDst);
  }

  syncHostCodexConfigFiles(sessionCodexDir);

  if (
    !rotatedAuthSrc ||
    authSrc !== rotatedAuthSrc ||
    !fs.existsSync(authDst)
  ) {
    if (hasRotationAccounts) {
      throw new Error(
        'Codex rotation pool unavailable: all rotation accounts are currently dead, rate-limited, or locked; re-auth or clear stale state before launching Codex',
      );
    }
    return null;
  }

  return {
    canonicalAuthPath: rotatedAuthSrc,
    sessionAuthPath: authDst,
    accountIndex: findCodexAccountIndexByAuthPath(rotatedAuthSrc),
  };
}

function upsertEjclawMcpServerSection(args: {
  sessionConfigPath: string;
  mcpServerPath: string;
  ipcDir: string;
  hostIpcDir: string;
  chatJid: string;
  groupFolder: string;
  isMain: boolean;
  agentType: AgentType;
  roomRole?: PairedRoomRole;
  workDir?: string;
}): void {
  const stripEjclawMcpServerSections = (input: string): string => {
    const lines = input.split('\n');
    const kept: string[] = [];
    let skipping = false;

    for (const line of lines) {
      const trimmed = line.trim();
      const isSectionHeader = trimmed.startsWith('[') && trimmed.endsWith(']');
      const isEjclawSection = /^\[mcp_servers\.ejclaw(?:\.[^\]]+)?\]$/.test(
        trimmed,
      );

      if (isSectionHeader) {
        if (isEjclawSection) {
          skipping = true;
          continue;
        }
        if (skipping) {
          skipping = false;
        }
      }

      if (!skipping) {
        kept.push(line);
      }
    }

    return kept.join('\n').replace(/^\n+/, '');
  };

  let toml = fs.existsSync(args.sessionConfigPath)
    ? fs.readFileSync(args.sessionConfigPath, 'utf-8')
    : '';
  toml = stripEjclawMcpServerSections(toml);
  const tomlEnvLine = (name: string, value: string): string =>
    `${name} = ${JSON.stringify(value)}`;
  const mcpSection = `
[mcp_servers.ejclaw]
command = "node"
args = [${JSON.stringify(args.mcpServerPath)}]

[mcp_servers.ejclaw.env]
${tomlEnvLine(EJCLAW_ENV.ipcDir, args.ipcDir)}
${tomlEnvLine(EJCLAW_ENV.hostIpcDir, args.hostIpcDir)}
${tomlEnvLine(EJCLAW_ENV.chatJid, args.chatJid)}
${tomlEnvLine(EJCLAW_ENV.groupFolder, args.groupFolder)}
${tomlEnvLine(EJCLAW_ENV.isMain, args.isMain ? '1' : '0')}
${tomlEnvLine(EJCLAW_ENV.agentType, args.agentType)}
${args.roomRole ? `${tomlEnvLine(EJCLAW_ENV.roomRole, args.roomRole)}\n` : ''}
${args.workDir ? `${tomlEnvLine(EJCLAW_ENV.workDir, args.workDir)}\n` : ''}
`;
  fs.writeFileSync(args.sessionConfigPath, toml.trimEnd() + '\n' + mcpSection);
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
  runtimeTaskId?: string;
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
    [EJCLAW_ENV.groupDir]: args.groupDir,
    [EJCLAW_ENV.ipcDir]: args.groupIpcDir,
    [EJCLAW_ENV.hostIpcDir]: args.hostIpcDir,
    [EJCLAW_ENV.globalDir]: args.globalDir,
    ...(args.group.workDir ? { [EJCLAW_ENV.workDir]: args.group.workDir } : {}),
    [EJCLAW_ENV.chatJid]: args.chatJid,
    [EJCLAW_ENV.groupFolder]: args.group.folder,
    [EJCLAW_ENV.isMain]: args.isMain ? '1' : '0',
    [EJCLAW_ENV.agentType]: args.agentType,
    CLAUDE_CONFIG_DIR: args.groupSessionsDir,
    ...(args.runtimeTaskId
      ? { [EJCLAW_ENV.runtimeTaskId]: args.runtimeTaskId }
      : {}),
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
    // Token rotation takes priority over static .env value
    const oauthToken =
      getCurrentToken() ||
      getConfiguredClaudeTokens({
        multi:
          args.envVars.CLAUDE_CODE_OAUTH_TOKENS ||
          process.env.CLAUDE_CODE_OAUTH_TOKENS,
        single:
          args.envVars.CLAUDE_CODE_OAUTH_TOKEN ||
          process.env.CLAUDE_CODE_OAUTH_TOKEN,
      })[0];
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
  if (args.group.agentConfig?.claudeThinking) {
    args.env.CLAUDE_THINKING = args.group.agentConfig.claudeThinking;
  }
  if (args.group.agentConfig?.claudeThinkingBudget) {
    args.env.CLAUDE_THINKING_BUDGET = String(
      args.group.agentConfig.claudeThinkingBudget,
    );
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
  roomRole?: PairedRoomRole;
  isPairedRoom: boolean;
  useFailoverPromptPack: boolean;
  memoryBriefing?: string;
  skillOverrides?: StoredRoomSkillOverride[];
}): PreparedCodexSessionAuth | null {
  // API key auth intentionally removed — Codex uses OAuth only.
  // Never pass any API key to Codex child process to prevent API billing.
  delete args.env.OPENAI_API_KEY;
  delete args.env.CODEX_OPENAI_API_KEY;

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

  const sessionCodexDir = path.join(args.sessionRootDir, '.codex');
  const codexSessionAuth = syncHostCodexSessionFiles(sessionCodexDir);
  const runtimeCodexDir = codexSessionAuth?.codexHomeDir ?? sessionCodexDir;
  let configured = false;
  try {
    const overlayPath = path.join(args.groupDir, '.codex', 'config.toml');
    const sessionConfigPath = path.join(runtimeCodexDir, 'config.toml');
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

    const goalsFromConfig = readCodexFeatureFromFile(
      sessionConfigPath,
      'goals',
    );
    const codexGoals =
      args.group.agentConfig?.codexGoals ??
      (goalsFromConfig ||
        args.envVars.CODEX_GOALS === 'true' ||
        process.env.CODEX_GOALS === 'true');
    if (codexGoals) {
      args.env.CODEX_GOALS = 'true';
    } else {
      delete args.env.CODEX_GOALS;
    }

    const sessionAgentsPath = path.join(runtimeCodexDir, 'AGENTS.md');
    const sessionAgents = (
      args.useFailoverPromptPack
        ? [
            readOptionalPromptFile(
              args.projectRoot,
              'owner-common-platform.md',
            ),
            readOptionalPromptFile(
              args.projectRoot,
              'codex-review-failover-platform.md',
            ),
            args.isPairedRoom
              ? readOptionalPromptFile(
                  args.projectRoot,
                  'owner-common-paired-room.md',
                )
              : undefined,
            args.memoryBriefing,
          ]
        : [
            readPlatformPrompt('codex', args.projectRoot),
            args.isPairedRoom
              ? readOptionalPromptFile(
                  args.projectRoot,
                  'owner-common-paired-room.md',
                )
              : undefined,
            args.memoryBriefing,
          ]
    )
      .filter((value): value is string => Boolean(value))
      .join('\n\n---\n\n')
      .trim();
    if (sessionAgents) {
      fs.writeFileSync(sessionAgentsPath, sessionAgents + '\n');
    } else if (fs.existsSync(sessionAgentsPath)) {
      fs.unlinkSync(sessionAgentsPath);
    }

    // Codex reads skills from ~/.agents/skills/ (user-level) and
    // {workDir}/.agents/skills/ (project-level), NOT from .codex/skills/.
    if (hasDisabledSkillOverrides(args.skillOverrides, 'codex')) {
      const sessionHomeDir = path.join(args.sessionRootDir, 'home');
      args.env.HOME = sessionHomeDir;
      syncRoomSkillDirectories({
        sources: [
          {
            dir: path.join(os.homedir(), '.claude', 'skills'),
            scope: 'codex-user',
          },
          {
            dir: path.join(os.homedir(), '.agents', 'skills'),
            scope: 'codex-user',
          },
          {
            dir: path.join(args.projectRoot, 'runners', 'skills'),
            scope: 'runner',
          },
        ],
        destination: path.join(sessionHomeDir, '.agents', 'skills'),
        agentType: 'codex',
        overrides: args.skillOverrides,
      });
    } else {
      // Preserve the historical global sync path when no room override exists.
      const codexSkillsDir = path.join(os.homedir(), '.agents', 'skills');
      syncDirectoryEntries(
        [
          path.join(os.homedir(), '.claude', 'skills'),
          path.join(args.projectRoot, 'runners', 'skills'),
        ],
        codexSkillsDir,
      );
    }

    const mcpServerPath = path.join(
      args.projectRoot,
      'runners',
      'agent-runner',
      'dist',
      'ipc-mcp-stdio.js',
    );
    if (fs.existsSync(mcpServerPath)) {
      upsertEjclawMcpServerSection({
        sessionConfigPath,
        mcpServerPath,
        ipcDir: args.env[EJCLAW_ENV.ipcDir],
        hostIpcDir: args.env[EJCLAW_ENV.hostIpcDir],
        chatJid: args.chatJid,
        groupFolder: args.group.folder,
        isMain: args.isMain,
        agentType: 'codex',
        roomRole: args.roomRole,
        workDir:
          args.env[EJCLAW_ENV.workDir] ||
          args.group.workDir ||
          args.projectRoot,
      });
    }

    delete args.env.ANTHROPIC_API_KEY;
    delete args.env.ANTHROPIC_AUTH_TOKEN;
    delete args.env.ANTHROPIC_BASE_URL;
    delete args.env.CLAUDE_CODE_OAUTH_TOKEN;
    args.env.CODEX_HOME = runtimeCodexDir;
    configured = true;
    return codexSessionAuth;
  } finally {
    if (!configured) codexSessionAuth?.lease?.release();
  }
}

export interface PreparedGroupEnvironment {
  env: Record<string, string>;
  groupDir: string;
  runnerDir: string;
  codexSessionAuth?: PreparedCodexSessionAuth | null;
}

export interface PreparedReadonlySessionEnvironment {
  /** Directory passed to CODEX_HOME for this read-only Codex role run. */
  codexHomeDir?: string;
  /** Optional HOME override used only for session-scoped Codex skill overrides. */
  homeDir?: string;
  codexSessionAuth?: PreparedCodexSessionAuth | null;
}

export function prepareGroupEnvironment(
  group: RegisteredGroup,
  isMain: boolean,
  chatJid: string,
  options?: {
    memoryBriefing?: string;
    runtimeTaskId?: string;
    useTaskScopedSession?: boolean;
    skillOverrides?: StoredRoomSkillOverride[];
    roomRole?: PairedRoomRole;
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
      ? resolveServiceTaskSessionsPath(
          group.folder,
          SERVICE_SESSION_SCOPE,
          runtimeTaskId,
        )
      : resolveServiceGroupSessionsPath(group.folder, SERVICE_SESSION_SCOPE);

  const groupSessionsDir = path.join(sessionRootDir, '.claude');
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  ensureClaudeSessionSettings(groupSessionsDir);

  const agentType = group.agentType || 'claude-code';
  const workDirClaude = group.workDir
    ? path.join(group.workDir, '.claude')
    : null;
  syncRoomSkillDirectories({
    sources: [
      {
        dir: path.join(os.homedir(), '.claude', 'skills'),
        scope: 'claude-user',
      },
      ...(workDirClaude
        ? [
            {
              dir: path.join(workDirClaude, 'skills'),
              scope: 'workdir' as const,
            },
          ]
        : []),
      { dir: path.join(projectRoot, 'runners', 'skills'), scope: 'runner' },
    ],
    destination: path.join(groupSessionsDir, 'skills'),
    agentType: agentType === 'glm-code' ? 'glm-code' : 'claude-code',
    overrides: options?.skillOverrides,
  });

  const groupIpcDir = runtimeTaskId
    ? resolveTaskRuntimeIpcPath(group.folder, runtimeTaskId)
    : resolveGroupIpcPath(group.folder);
  const hostIpcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });

  const globalDir = path.join(GROUPS_DIR, 'global');
  const globalClaudeMdPath = path.join(globalDir, 'CLAUDE.md');
  const isPairedRoom = hasReviewerLease(chatJid);
  const effectiveLease = getEffectiveChannelLease(chatJid);
  // Canonical lease state now exposes owner failover directly, so prefer the
  // explicit flag over the older CODEX_REVIEW_SERVICE_ID shadow heuristic.
  const useCodexReviewFailoverPromptPack =
    isReviewService(SERVICE_ID) &&
    effectiveLease.owner_failover_active === true;

  const ownerCommonPlatformPrompt = readOptionalPromptFile(
    projectRoot,
    'owner-common-platform.md',
  );
  const claudePlatformPrompt = readPlatformPrompt('claude-code', projectRoot);
  const ownerCommonPairedRoomPrompt = isPairedRoom
    ? readOptionalPromptFile(projectRoot, 'owner-common-paired-room.md')
    : undefined;
  const globalClaudeMemory =
    !isMain && fs.existsSync(globalClaudeMdPath)
      ? fs.readFileSync(globalClaudeMdPath, 'utf-8').trim()
      : undefined;
  // Owner CLAUDE.md: platform rules + owner paired room rules.
  // Reviewer paired room rules are NOT included — those belong to the
  // Read-only reviewer/arbiter session only (via prepareReadonlySessionEnvironment).
  const sessionClaudeMd = [
    ownerCommonPlatformPrompt,
    claudePlatformPrompt,
    ownerCommonPairedRoomPrompt,
    globalClaudeMemory,
    options?.memoryBriefing,
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

  const runnerDirName = agentType === 'codex' ? 'codex-runner' : 'agent-runner';
  const runnerDir = path.join(projectRoot, 'runners', runnerDirName);

  const envVars = readEnvFile([
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_OAUTH_TOKENS',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_MODEL',
    'CLAUDE_THINKING',
    'CLAUDE_THINKING_BUDGET',
    'CLAUDE_EFFORT',
    'CODEX_MODEL',
    'CODEX_EFFORT',
    'CODEX_GOALS',
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
    runtimeTaskId,
  });

  let codexSessionAuth: PreparedCodexSessionAuth | null = null;
  if (agentType === 'codex') {
    codexSessionAuth = prepareCodexSessionEnvironment({
      env,
      envVars,
      projectRoot,
      group,
      groupDir,
      sessionRootDir,
      chatJid,
      isMain,
      roomRole: options?.roomRole,
      isPairedRoom,
      useFailoverPromptPack: useCodexReviewFailoverPromptPack,
      memoryBriefing: options?.memoryBriefing,
      skillOverrides: options?.skillOverrides,
    });
  } else {
    prepareClaudeEnvironment({ env, envVars, group });
  }

  return { env, groupDir, runnerDir, codexSessionAuth };
}

/**
 * Prepare a role-scoped session directory for a host-based read-only reviewer
 * or arbiter run.
 *
 * Writes CLAUDE.md (platform + paired room prompts + global memory + briefing),
 * syncs skills, and ensures settings.json exist — the same steps that
 * `prepareGroupEnvironment` does for regular host-mode agents, but targeted at
 * an externally provided session directory.
 */
export function prepareReadonlySessionEnvironment(args: {
  sessionDir: string;
  chatJid: string;
  isMain: boolean;
  groupFolder: string;
  agentType: AgentType;
  memoryBriefing?: string;
  role?: 'reviewer' | 'arbiter';
  ipcDir?: string;
  hostIpcDir?: string;
  workDir?: string;
  skillOverrides?: StoredRoomSkillOverride[];
}): PreparedReadonlySessionEnvironment {
  const {
    sessionDir,
    chatJid,
    isMain,
    groupFolder,
    agentType,
    memoryBriefing,
    role = 'reviewer',
    ipcDir = '/workspace/ipc',
    hostIpcDir = ipcDir,
    workDir = '/workspace/project',
    skillOverrides,
  } = args;
  const projectRoot = process.cwd();
  let codexSessionAuth: PreparedCodexSessionAuth | null = null;
  let runtimeCodexHomeDir: string | undefined;

  fs.mkdirSync(sessionDir, { recursive: true });
  ensureClaudeSessionSettings(sessionDir);
  ensureClaudeGlobalSettingsFile(sessionDir);

  // Sync skills from host
  syncRoomSkillDirectories({
    sources: [
      {
        dir: path.join(os.homedir(), '.claude', 'skills'),
        scope: agentType === 'codex' ? 'codex-user' : 'claude-user',
      },
      { dir: path.join(projectRoot, 'runners', 'skills'), scope: 'runner' },
    ],
    destination: path.join(sessionDir, 'skills'),
    agentType,
    overrides: skillOverrides,
  });
  const skillHomeDir =
    agentType === 'codex' && hasDisabledSkillOverrides(skillOverrides, 'codex')
      ? sessionDir
      : undefined;
  if (skillHomeDir) {
    syncRoomSkillDirectories({
      sources: [
        {
          dir: path.join(os.homedir(), '.claude', 'skills'),
          scope: 'codex-user',
        },
        {
          dir: path.join(os.homedir(), '.agents', 'skills'),
          scope: 'codex-user',
        },
        { dir: path.join(projectRoot, 'runners', 'skills'), scope: 'runner' },
      ],
      destination: path.join(skillHomeDir, '.agents', 'skills'),
      agentType,
      overrides: skillOverrides,
    });
  }

  // Build CLAUDE.md with role-appropriate prompts (reviewer or arbiter)
  const claudePlatformPrompt = readPlatformPrompt('claude-code', projectRoot);
  const claudePairedRoomPrompt = hasReviewerLease(chatJid)
    ? role === 'arbiter'
      ? readArbiterPrompt(projectRoot)
      : readPairedRoomPrompt('claude-code', projectRoot)
    : undefined;
  const globalDir = path.join(GROUPS_DIR, 'global');
  const globalClaudeMdPath = path.join(globalDir, 'CLAUDE.md');
  const globalClaudeMemory =
    !isMain && fs.existsSync(globalClaudeMdPath)
      ? fs.readFileSync(globalClaudeMdPath, 'utf-8').trim()
      : undefined;

  const sessionClaudeMd = [
    claudePlatformPrompt,
    claudePairedRoomPrompt,
    globalClaudeMemory,
    memoryBriefing,
  ]
    .filter((value): value is string => Boolean(value))
    .join('\n\n---\n\n')
    .trim();

  const sessionClaudeMdPath = path.join(sessionDir, 'CLAUDE.md');
  if (sessionClaudeMd) {
    fs.writeFileSync(sessionClaudeMdPath, sessionClaudeMd + '\n');
    if (agentType === 'codex') {
      const sessionCodexDir = path.join(sessionDir, '.codex');
      codexSessionAuth = syncHostCodexSessionFiles(sessionCodexDir);
      const runtimeCodexDir = codexSessionAuth?.codexHomeDir ?? sessionCodexDir;
      runtimeCodexHomeDir = runtimeCodexDir;
      fs.writeFileSync(
        path.join(runtimeCodexDir, 'AGENTS.md'),
        sessionClaudeMd + '\n',
      );
      const sessionConfigPath = path.join(runtimeCodexDir, 'config.toml');
      const mcpServerPath = path.join(
        projectRoot,
        'runners',
        'agent-runner',
        'dist',
        'ipc-mcp-stdio.js',
      );
      if (fs.existsSync(mcpServerPath)) {
        upsertEjclawMcpServerSection({
          sessionConfigPath,
          mcpServerPath,
          ipcDir,
          hostIpcDir,
          chatJid,
          groupFolder,
          isMain,
          agentType,
          roomRole: role,
          workDir,
        });
      }
    } else {
      fs.rmSync(path.join(sessionDir, '.codex'), {
        recursive: true,
        force: true,
      });
    }
    logger.info(
      {
        sessionDir,
        claudeMdSize: sessionClaudeMd.length,
        hasPlatform: !!claudePlatformPrompt,
        hasPairedRoom: !!claudePairedRoomPrompt,
        hasGlobalMemory: !!globalClaudeMemory,
        hasMemoryBriefing: !!memoryBriefing,
      },
      'Readonly session CLAUDE.md written',
    );
  } else if (fs.existsSync(sessionClaudeMdPath)) {
    fs.unlinkSync(sessionClaudeMdPath);
  }
  return {
    codexHomeDir: runtimeCodexHomeDir,
    homeDir: skillHomeDir,
    codexSessionAuth,
  };
}
