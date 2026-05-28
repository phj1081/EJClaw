import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  ARBITER_AGENT_TYPE,
  ARBITER_MODEL_CONFIG,
  ARBITER_SERVICE_ID,
  CLAUDE_SERVICE_ID,
  CODEX_MAIN_SERVICE_ID,
  CODEX_REVIEW_SERVICE_ID,
  CURRENT_RUNTIME_AGENT_TYPE,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CODEX_MODEL,
  OWNER_AGENT_TYPE,
  OWNER_MODEL_CONFIG,
  REVIEWER_AGENT_TYPE,
  REVIEWER_MODEL_CONFIG,
  REVIEWER_SERVICE_ID_FOR_TYPE,
  SERVICE_ID,
  SERVICE_SESSION_SCOPE,
  DATA_DIR,
  WEB_DASHBOARD,
} from './config.js';
import type { AgentType } from './types.js';
import {
  collectArtifactMetadata,
  collectDeployState,
  DEPLOY_EVIDENCE_ACTIONS,
  type DeployEvidenceAction,
} from './deploy-evidence.js';
import {
  DB_EVIDENCE_ACTIONS,
  isDbEvidenceAction,
  type DbEvidenceAction,
  runDbEvidenceRequest,
} from './db-evidence.js';
import { requireDatabase } from './db/runtime-database.js';
import {
  GITHUB_EVIDENCE_ACTIONS,
  isGitHubEvidenceAction,
  runGitHubEvidenceCommand,
  type GitHubEvidenceAction,
} from './github-evidence.js';
import { resolveGroupIpcPath } from './group-folder.js';

export const HOST_EVIDENCE_ACTIONS = [
  'ejclaw_service_status',
  'ejclaw_service_logs',
  'ejclaw_role_runtime_config',
  ...DEPLOY_EVIDENCE_ACTIONS,
  ...DB_EVIDENCE_ACTIONS,
  ...GITHUB_EVIDENCE_ACTIONS,
] as const;

export type HostEvidenceAction = (typeof HOST_EVIDENCE_ACTIONS)[number];

export interface HostEvidenceRequest {
  requestId: string;
  action: HostEvidenceAction;
  tailLines?: number;
  taskId?: string;
  minutes?: number;
  limit?: number;
  repo?: string;
  prNumber?: number;
  runId?: number;
  workflowPath?: string;
  ref?: string;
  artifactKind?: string;
  sourceGroup?: string;
  isMain?: boolean;
}

export interface HostEvidenceResult {
  ok: boolean;
  action:
    | HostEvidenceAction
    | DbEvidenceAction
    | DeployEvidenceAction
    | GitHubEvidenceAction
    | 'ejclaw_room_runtime';
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  error?: string;
}

export interface HostEvidenceResponse extends HostEvidenceResult {
  requestId: string;
}

interface HostEvidenceCommandSpec {
  file: string;
  args: string[];
  commandText: string;
}

const DEFAULT_LOG_TAIL_LINES = 20;
const MAX_LOG_TAIL_LINES = 200;
const MAX_OUTPUT_CHARS = 16_000;
const COMMAND_TIMEOUT_MS = 5_000;
const COMMAND_MAX_BUFFER = 1024 * 1024;
const PROJECT_ROOT = process.cwd();

export function isHostEvidenceAction(
  value: unknown,
): value is HostEvidenceAction {
  return (
    typeof value === 'string' &&
    HOST_EVIDENCE_ACTIONS.includes(value as HostEvidenceAction)
  );
}

export function clampHostEvidenceTailLines(value?: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_LOG_TAIL_LINES;
  }
  const normalized = Math.trunc(value as number);
  return Math.min(Math.max(normalized, 1), MAX_LOG_TAIL_LINES);
}

export function buildHostEvidenceCommand(
  request: HostEvidenceRequest,
): HostEvidenceCommandSpec {
  switch (request.action) {
    case 'ejclaw_service_status': {
      const args = [
        '--user',
        'show',
        'ejclaw',
        '-p',
        'Id',
        '-p',
        'LoadState',
        '-p',
        'ActiveState',
        '-p',
        'SubState',
        '-p',
        'ExecMainCode',
        '-p',
        'ExecMainStatus',
        '-p',
        'ExecMainStartTimestamp',
        '-p',
        'ActiveEnterTimestamp',
      ];
      return {
        file: 'systemctl',
        args,
        commandText: `systemctl ${args.join(' ')}`,
      };
    }
    case 'ejclaw_service_logs': {
      const tailLines = clampHostEvidenceTailLines(request.tailLines);
      const args = [
        '--user',
        '-u',
        'ejclaw',
        '--no-pager',
        '-n',
        String(tailLines),
      ];
      return {
        file: 'journalctl',
        args,
        commandText: `journalctl ${args.join(' ')}`,
      };
    }
    default:
      throw new Error(
        `Host evidence action has no shell command: ${request.action}`,
      );
  }
}

export function truncateHostEvidenceText(value: string | undefined): string {
  if (!value) return '';
  if (value.length <= MAX_OUTPUT_CHARS) {
    return value;
  }
  return `${value.slice(0, MAX_OUTPUT_CHARS)}\n...[truncated]`;
}

function effectiveModelForAgentType(
  agentType: AgentType | null | undefined,
  configuredModel: string | undefined,
): string | null {
  if (!agentType) {
    return null;
  }
  if (configuredModel) {
    return configuredModel;
  }
  return agentType === 'claude-code'
    ? DEFAULT_CLAUDE_MODEL
    : DEFAULT_CODEX_MODEL;
}

function ownerServiceIdForAgentType(agentType: AgentType): string {
  return agentType === 'claude-code'
    ? CLAUDE_SERVICE_ID
    : CODEX_MAIN_SERVICE_ID;
}

function buildRoleRuntimeConfigRole(
  role: 'owner' | 'reviewer' | 'arbiter',
  agentType: AgentType | null | undefined,
  modelConfig: {
    model?: string;
    effort?: string;
    fallbackEnabled: boolean;
  },
  serviceId: string | null,
): Record<string, unknown> {
  return {
    role,
    enabled: role !== 'arbiter' || Boolean(agentType),
    agent_type: agentType ?? null,
    service_id: serviceId,
    configured_model: modelConfig.model ?? null,
    effective_model: effectiveModelForAgentType(agentType, modelConfig.model),
    effort: modelConfig.effort ?? null,
    fallback_enabled: modelConfig.fallbackEnabled,
  };
}

export function buildRoleRuntimeConfigEvidence(): string {
  return JSON.stringify(
    {
      action: 'ejclaw_role_runtime_config',
      current_service: {
        service_id: SERVICE_ID,
        session_scope: SERVICE_SESSION_SCOPE,
        runtime_agent_type: CURRENT_RUNTIME_AGENT_TYPE,
      },
      defaults: {
        claude_model: DEFAULT_CLAUDE_MODEL,
        codex_model: DEFAULT_CODEX_MODEL,
      },
      services: {
        claude: CLAUDE_SERVICE_ID,
        codex_main: CODEX_MAIN_SERVICE_ID,
        codex_review: CODEX_REVIEW_SERVICE_ID,
        reviewer_for_type: REVIEWER_SERVICE_ID_FOR_TYPE,
        arbiter: ARBITER_SERVICE_ID,
      },
      roles: {
        owner: buildRoleRuntimeConfigRole(
          'owner',
          OWNER_AGENT_TYPE,
          OWNER_MODEL_CONFIG,
          ownerServiceIdForAgentType(OWNER_AGENT_TYPE),
        ),
        reviewer: buildRoleRuntimeConfigRole(
          'reviewer',
          REVIEWER_AGENT_TYPE,
          REVIEWER_MODEL_CONFIG,
          REVIEWER_SERVICE_ID_FOR_TYPE,
        ),
        arbiter: buildRoleRuntimeConfigRole(
          'arbiter',
          ARBITER_AGENT_TYPE,
          ARBITER_MODEL_CONFIG,
          ARBITER_SERVICE_ID,
        ),
      },
    },
    null,
    2,
  );
}

function execFileCapture(
  file: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        encoding: 'utf8',
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: COMMAND_MAX_BUFFER,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            Object.assign(error, {
              stdout,
              stderr,
            }),
          );
          return;
        }
        resolve({
          stdout,
          stderr,
        });
      },
    );
  });
}

function extractExitCode(error: unknown): number {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'number') {
      return code;
    }
  }
  return 1;
}

export async function runHostEvidenceRequest(
  request: HostEvidenceRequest,
): Promise<HostEvidenceResult> {
  let commandText = '';
  try {
    if (request.action === 'ejclaw_role_runtime_config') {
      commandText = `internal:${request.action}`;
      return {
        ok: true,
        action: request.action,
        command: commandText,
        stdout: truncateHostEvidenceText(buildRoleRuntimeConfigEvidence()),
        stderr: '',
        exitCode: 0,
      };
    }

    if (isDbEvidenceAction(request.action)) {
      commandText = `internal:${request.action}`;
      return {
        ok: true,
        action: request.action,
        command: commandText,
        stdout: truncateHostEvidenceText(
          runDbEvidenceRequest(
            requireDatabase(),
            {
              action: request.action,
              taskId: request.taskId,
              minutes: request.minutes,
              limit: request.limit,
            },
            {
              sourceGroup: request.sourceGroup ?? '',
              isMain: request.isMain === true,
            },
          ),
        ),
        stderr: '',
        exitCode: 0,
      };
    }

    if (request.action === 'ejclaw_deploy_state') {
      commandText = `internal:${request.action}`;
      return {
        ok: true,
        action: request.action,
        command: commandText,
        stdout: truncateHostEvidenceText(
          await collectDeployState({
            projectRoot: PROJECT_ROOT,
            dataDir: DATA_DIR,
            dashboardStaticDir: WEB_DASHBOARD.staticDir,
          }),
        ),
        stderr: '',
        exitCode: 0,
      };
    }

    if (request.action === 'ejclaw_artifact_metadata') {
      commandText = `internal:${request.action}`;
      return {
        ok: true,
        action: request.action,
        command: commandText,
        stdout: truncateHostEvidenceText(
          collectArtifactMetadata(
            {
              projectRoot: PROJECT_ROOT,
              dataDir: DATA_DIR,
              dashboardStaticDir: WEB_DASHBOARD.staticDir,
            },
            {
              action: request.action,
              artifactKind: request.artifactKind,
            },
          ),
        ),
        stderr: '',
        exitCode: 0,
      };
    }

    if (isGitHubEvidenceAction(request.action)) {
      const githubResult = await runGitHubEvidenceCommand({
        action: request.action,
        repo: request.repo,
        prNumber: request.prNumber,
        runId: request.runId,
        workflowPath: request.workflowPath,
        ref: request.ref,
      });
      commandText = githubResult.command;
      return {
        ok: true,
        action: request.action,
        command: commandText,
        stdout: truncateHostEvidenceText(githubResult.stdout),
        stderr: truncateHostEvidenceText(githubResult.stderr),
        exitCode: 0,
      };
    }

    const command = buildHostEvidenceCommand(request);
    commandText = command.commandText;
    const { stdout, stderr } = await execFileCapture(
      command.file,
      command.args,
    );
    return {
      ok: true,
      action: request.action,
      command: commandText,
      stdout: truncateHostEvidenceText(stdout),
      stderr: truncateHostEvidenceText(stderr),
      exitCode: 0,
    };
  } catch (error) {
    const stdout =
      typeof error === 'object' && error !== null && 'stdout' in error
        ? String((error as { stdout?: unknown }).stdout ?? '')
        : '';
    const stderr =
      typeof error === 'object' && error !== null && 'stderr' in error
        ? String((error as { stderr?: unknown }).stderr ?? '')
        : '';

    return {
      ok: false,
      action: request.action,
      command:
        typeof error === 'object' && error !== null && 'command' in error
          ? String((error as { command?: unknown }).command ?? commandText)
          : commandText,
      stdout: truncateHostEvidenceText(stdout),
      stderr: truncateHostEvidenceText(stderr),
      exitCode: extractExitCode(error),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function resolveHostEvidenceResponseDir(groupFolder: string): string {
  return path.join(resolveGroupIpcPath(groupFolder), 'host-evidence-responses');
}

export function writeHostEvidenceResponse(
  groupFolder: string,
  response: HostEvidenceResponse,
): string {
  const responseDir = resolveHostEvidenceResponseDir(groupFolder);
  fs.mkdirSync(responseDir, { recursive: true });

  const outputPath = path.join(responseDir, `${response.requestId}.json`);
  const tempPath = `${outputPath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(response, null, 2));
  fs.renameSync(tempPath, outputPath);
  return outputPath;
}
