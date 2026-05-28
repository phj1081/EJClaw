import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import {
  ARTIFACT_EVIDENCE_KINDS,
  DB_EVIDENCE_ACTIONS,
  DEPLOY_EVIDENCE_ACTIONS,
  formatHostEvidenceResponse,
  GITHUB_EVIDENCE_ACTIONS,
  HOST_EVIDENCE_ACTIONS,
  normalizeHostEvidenceTailLines,
  type HostEvidenceAction,
  waitForHostEvidenceResponse,
} from './host-evidence.js';

type IpcWriter = (dir: string, data: object) => string;

interface McpTextToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

interface RegisterHostEvidenceToolsOptions {
  server: McpServer;
  tasksDir: string;
  responseDir: string;
  groupFolder: string;
  writeIpcFile: IpcWriter;
}

async function requestHostEvidence(
  options: RegisterHostEvidenceToolsOptions,
  payload: Record<string, unknown> & { action: HostEvidenceAction },
): Promise<McpTextToolResult> {
  const requestId = `host-evidence-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;

  options.writeIpcFile(options.tasksDir, {
    type: 'host_evidence_request',
    requestId,
    ...payload,
    groupFolder: options.groupFolder,
    timestamp: new Date().toISOString(),
  });

  try {
    const response = await waitForHostEvidenceResponse(
      options.responseDir,
      requestId,
    );
    return {
      content: [
        {
          type: 'text' as const,
          text: formatHostEvidenceResponse(response),
        },
      ],
      isError: !response.ok,
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text' as const,
          text: error instanceof Error ? error.message : String(error),
        },
      ],
      isError: true,
    };
  }
}

export function registerHostEvidenceTools(
  options: RegisterHostEvidenceToolsOptions,
): void {
  const { server } = options;

  server.tool(
    'read_host_evidence',
    'Read host-side deployment evidence through a narrow allowlist. Use this instead of broad shell access when reviewer/arbiter needs service status, deploy state, DB state, GitHub PR state, or artifact metadata.',
    {
      action: z
        .enum(HOST_EVIDENCE_ACTIONS)
        .describe(
          'Allowlisted evidence action. Prefer specific read_db_evidence/read_deploy_evidence/read_github_evidence helpers when available.',
        ),
      tail_lines: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe('Only for ejclaw_service_logs. Defaults to 20.'),
      task_id: z.string().optional().describe('Only for DB task actions.'),
      minutes: z
        .number()
        .int()
        .min(1)
        .max(1440)
        .optional()
        .describe('Only for recent DB evidence. Defaults to 60.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe('Only for DB evidence row limits. Defaults to 20.'),
      repo: z
        .string()
        .optional()
        .describe('Only for GitHub evidence, in owner/repo form.'),
      pr_number: z.number().int().positive().optional(),
      run_id: z.number().int().positive().optional(),
      workflow_path: z
        .string()
        .optional()
        .describe(
          'Only for github_workflow_file, e.g. .github/workflows/ci.yml.',
        ),
      ref: z
        .string()
        .optional()
        .describe('Only for github_workflow_file; branch, tag, or commit SHA.'),
      artifact_kind: z.enum(ARTIFACT_EVIDENCE_KINDS).optional(),
    },
    async (args) =>
      requestHostEvidence(options, {
        action: args.action,
        tail_lines:
          args.action === 'ejclaw_service_logs'
            ? normalizeHostEvidenceTailLines(args.tail_lines)
            : undefined,
        task_id: args.task_id,
        minutes: args.minutes,
        limit: args.limit,
        repo: args.repo,
        pr_number: args.pr_number,
        run_id: args.run_id,
        workflow_path: args.workflow_path,
        ref: args.ref,
        artifact_kind: args.artifact_kind,
      }),
  );

  server.tool(
    'read_db_evidence',
    'Read fixed DB evidence presets without arbitrary SQL. Raw message/output bodies are not returned.',
    {
      action: z.enum(DB_EVIDENCE_ACTIONS),
      task_id: z
        .string()
        .optional()
        .describe('Required for paired task status/flow actions.'),
      minutes: z.number().int().min(1).max(1440).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    async (args) =>
      requestHostEvidence(options, {
        action: args.action,
        task_id: args.task_id,
        minutes: args.minutes,
        limit: args.limit,
      }),
  );

  server.tool(
    'read_deploy_evidence',
    'Read fixed deploy/artifact evidence without shell access. Returns commit, dirty state, build artifact mtimes, sizes, and hashes where applicable.',
    {
      action: z.enum(DEPLOY_EVIDENCE_ACTIONS),
      artifact_kind: z.enum(ARTIFACT_EVIDENCE_KINDS).optional(),
    },
    async (args) =>
      requestHostEvidence(options, {
        action: args.action,
        artifact_kind: args.artifact_kind,
      }),
  );

  server.tool(
    'read_github_evidence',
    'Read fixed GitHub PR/run evidence through host gh CLI without broad shell access.',
    {
      action: z.enum(GITHUB_EVIDENCE_ACTIONS),
      repo: z.string().describe('GitHub repository in owner/repo form.'),
      pr_number: z.number().int().positive().optional(),
      run_id: z.number().int().positive().optional(),
      workflow_path: z
        .string()
        .optional()
        .describe(
          'Only for github_workflow_file, e.g. .github/workflows/ci.yml.',
        ),
      ref: z
        .string()
        .optional()
        .describe('Only for github_workflow_file; branch, tag, or commit SHA.'),
    },
    async (args) =>
      requestHostEvidence(options, {
        action: args.action,
        repo: args.repo,
        pr_number: args.pr_number,
        run_id: args.run_id,
        workflow_path: args.workflow_path,
        ref: args.ref,
      }),
  );
}
