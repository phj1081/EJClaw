import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import {
  formatRepoEvidenceResponse,
  REPO_EVIDENCE_ACTIONS,
  runRepoEvidenceRequestDirect,
} from './repo-evidence.js';

export function registerRepoEvidenceTool(
  server: McpServer,
  repoRoot: string,
): void {
  server.tool(
    'read_repo_evidence',
    'Read fixed git evidence directly from EJCLAW_WORK_DIR without broad shell access. Use this when reviewer/arbiter needs current branch, dirty state, recent commits, or a specific commit/ref.',
    {
      action: z
        .enum(REPO_EVIDENCE_ACTIONS)
        .describe(
          'git_status=current branch and dirty state, git_head=current HEAD, git_recent_log=recent commits, git_show_ref=show a specific ref/commit',
        ),
      ref: z
        .string()
        .optional()
        .describe('Only for git_show_ref. Defaults to HEAD.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(30)
        .optional()
        .describe('Only for git_recent_log. Defaults to 10, max 30.'),
    },
    async (args) => {
      const response = await runRepoEvidenceRequestDirect(repoRoot, {
        action: args.action,
        ref: args.ref,
        limit: args.limit,
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: formatRepoEvidenceResponse(response),
          },
        ],
        isError: !response.ok,
      };
    },
  );
}
