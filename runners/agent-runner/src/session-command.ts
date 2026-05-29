import { query } from '@anthropic-ai/claude-agent-sdk';

import { compactBoundaryFromMessage } from './compaction-boundary.js';
import { getClaudeCliPath } from './claude-cli.js';
import { createPreCompactHook } from './runner-hooks.js';
import {
  buildCompactionOutput,
  type RunnerCompaction,
  writeOutput,
} from './output-protocol.js';

export interface RunSessionCommandArgs {
  prompt: string;
  sessionId?: string;
  cwd: string;
  sdkEnv: Record<string, string | undefined>;
  abortController: AbortController;
  assistantName?: string;
  groupDir: string;
  groupFolder: string;
  hostTasksDir: string;
  log: (message: string) => void;
}

export async function runSessionCommand({
  prompt,
  sessionId,
  cwd,
  sdkEnv,
  abortController,
  assistantName,
  groupDir,
  groupFolder,
  hostTasksDir,
  log,
}: RunSessionCommandArgs): Promise<void> {
  let slashSessionId: string | undefined;
  let compactBoundarySeen = false;
  let slashCompaction: RunnerCompaction | undefined;
  let hadError = false;
  let resultEmitted = false;

  try {
    for await (const message of query({
      prompt,
      options: {
        pathToClaudeCodeExecutable: getClaudeCliPath(log),
        cwd,
        resume: sessionId,
        systemPrompt: undefined,
        allowedTools: [],
        env: sdkEnv,
        permissionMode: 'bypassPermissions' as const,
        allowDangerouslySkipPermissions: true,
        settingSources: ['project', 'user'] as const,
        abortController,
        hooks: {
          PreCompact: [
            {
              hooks: [
                createPreCompactHook({
                  assistantName,
                  groupDir,
                  groupFolder,
                  hostTasksDir,
                  log,
                  writeOutput,
                }),
              ],
            },
          ],
        },
      },
    })) {
      const msgType =
        message.type === 'system'
          ? `system/${(message as { subtype?: string }).subtype}`
          : message.type;
      log(`[slash-cmd] type=${msgType}`);

      if (message.type === 'system' && message.subtype === 'init') {
        slashSessionId = message.session_id;
        log(`Session after slash command: ${slashSessionId}`);
      }

      const observedCompaction = compactBoundaryFromMessage(message, log);
      if (observedCompaction) {
        compactBoundarySeen = true;
        slashCompaction = observedCompaction;
      }

      if (message.type === 'result') {
        const resultSubtype = (message as { subtype?: string }).subtype;
        const textResult =
          'result' in message ? (message as { result?: string }).result : null;

        if (resultSubtype?.startsWith('error')) {
          hadError = true;
          writeOutput({
            status: 'error',
            result: null,
            error: textResult || 'Session command failed.',
            newSessionId: slashSessionId,
            ...buildCompactionOutput(slashCompaction),
          });
        } else {
          writeOutput({
            status: 'success',
            result: textResult || 'Conversation compacted.',
            newSessionId: slashSessionId,
            ...buildCompactionOutput(slashCompaction),
          });
        }
        resultEmitted = true;
      }
    }
  } catch (err) {
    hadError = true;
    const errorMsg = err instanceof Error ? err.message : String(err);
    log(`Slash command error: ${errorMsg}`);
    writeOutput({ status: 'error', result: null, error: errorMsg });
  }

  log(
    `Slash command done. compactBoundarySeen=${compactBoundarySeen}, hadError=${hadError}`,
  );

  if (!hadError && !compactBoundarySeen) {
    log(
      'WARNING: compact_boundary was not observed. Compaction may not have completed.',
    );
  }

  if (!resultEmitted && !hadError) {
    writeOutput({
      status: 'success',
      result: compactBoundarySeen
        ? 'Conversation compacted.'
        : 'Compaction requested but compact_boundary was not observed.',
      newSessionId: slashSessionId,
      ...buildCompactionOutput(slashCompaction),
    });
  } else if (!hadError) {
    writeOutput({
      status: 'success',
      result: null,
      newSessionId: slashSessionId,
      ...buildCompactionOutput(slashCompaction),
    });
  }
}
