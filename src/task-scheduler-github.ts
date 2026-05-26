import { getErrorMessage } from './utils.js';

import {
  deleteTask,
  getLatestOpenPairedTaskForChat,
  getTaskById,
  logTaskRun,
  storeChatMetadata,
  storeMessage,
  updateTask,
  updateTaskAfterRun,
} from './db.js';
import { resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import { createTaskStatusTracker } from './task-status-tracker.js';
import { extractWatchCiTarget } from './task-watch-status.js';
import {
  checkGitHubActionsRun,
  computeGitHubWatcherDelayMs,
  MAX_GITHUB_CONSECUTIVE_ERRORS,
  parseGitHubCiMetadata,
  serializeGitHubCiMetadata,
} from './github-ci.js';
import { sendScheduledMessage } from './task-scheduler-runtime.js';
import type { SchedulerDependencies } from './task-scheduler-types.js';
import type { ScheduledTask } from './types.js';

function enqueueOwnerAfterTerminalCiWatcher(args: {
  task: ScheduledTask;
  deps: SchedulerDependencies;
  completionText: string | null | undefined;
}): void {
  if (args.task.room_role !== 'owner') {
    return;
  }

  const pairedTask = getLatestOpenPairedTaskForChat(args.task.chat_jid);
  if (!pairedTask) {
    return;
  }

  const timestamp = new Date().toISOString();
  const content = [
    '[CI watcher completed]',
    args.completionText?.trim() || 'CI watcher completed.',
  ].join('\n');
  storeChatMetadata(args.task.chat_jid, timestamp, undefined, 'discord', true);
  storeMessage({
    id: `watch-ci-completed:${args.task.id}:${Date.now()}`,
    chat_jid: args.task.chat_jid,
    sender: 'ci-watcher',
    sender_name: 'CI watcher',
    content,
    timestamp,
    is_from_me: false,
    is_bot_message: false,
    message_source_kind: 'trusted_external_bot',
  });
  args.deps.queue.enqueueMessageCheck(
    args.task.chat_jid,
    resolveGroupIpcPath(args.task.group_folder),
  );
  logger.info(
    {
      taskId: args.task.id,
      chatJid: args.task.chat_jid,
      groupFolder: args.task.group_folder,
      pairedTaskId: pairedTask.id,
      pairedTaskStatus: pairedTask.status,
    },
    'Queued owner follow-up after terminal CI watcher completion',
  );
}

export async function runGithubCiTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): Promise<void> {
  const startTime = Date.now();
  const runAtIso = new Date().toISOString();
  let result: string | null = null;
  let error: string | null = null;
  let completedAndDeleted = false;
  let paused = false;
  const statusTracker = createTaskStatusTracker(task, {
    sendTrackedMessage: deps.sendTrackedMessage,
    editTrackedMessage: deps.editTrackedMessage,
  });
  const parsedMetadata = parseGitHubCiMetadata(task.ci_metadata);
  const metadata = parsedMetadata
    ? {
        ...parsedMetadata,
        poll_count: (parsedMetadata.poll_count ?? 0) + 1,
        last_checked_at: runAtIso,
      }
    : null;

  try {
    await statusTracker.update('checking');

    const check = await checkGitHubActionsRun(task);
    result = check.resultSummary;

    if (metadata) {
      metadata.consecutive_errors = 0;
    }

    if (check.terminal) {
      await statusTracker.update('completed');
      if (check.completionMessage) {
        await sendScheduledMessage(
          deps,
          task.chat_jid,
          check.completionMessage,
          task.room_role,
        );
      }
      deleteTask(task.id);
      completedAndDeleted = true;
      enqueueOwnerAfterTerminalCiWatcher({
        task,
        deps,
        completionText: check.completionMessage ?? result,
      });
      logger.info(
        {
          taskId: task.id,
          groupFolder: task.group_folder,
          durationMs: Date.now() - startTime,
        },
        'GitHub CI watcher completed and deleted',
      );
    } else {
      logger.info(
        {
          taskId: task.id,
          groupFolder: task.group_folder,
          result,
        },
        'GitHub CI watcher checked non-terminal run',
      );
    }
  } catch (err) {
    error = getErrorMessage(err);
    if (metadata) {
      metadata.consecutive_errors = (metadata.consecutive_errors ?? 0) + 1;
    }
    logger.error({ taskId: task.id, error }, 'GitHub CI watcher failed');
  }

  const durationMs = Date.now() - startTime;
  const currentTask = getTaskById(task.id);
  const nextRun = currentTask
    ? new Date(
        Date.now() + computeGitHubWatcherDelayMs(currentTask, Date.now()),
      ).toISOString()
    : null;

  if (!currentTask) {
    if (!completedAndDeleted) {
      await statusTracker.update('completed');
    }
    logger.debug(
      { taskId: task.id },
      'GitHub CI watcher deleted during execution, skipping persistence',
    );
    return;
  }

  if (metadata) {
    updateTask(task.id, { ci_metadata: serializeGitHubCiMetadata(metadata) });
  }

  if (
    error &&
    metadata &&
    (metadata.consecutive_errors ?? 0) >= MAX_GITHUB_CONSECUTIVE_ERRORS
  ) {
    paused = true;
    updateTask(task.id, { status: 'paused' });
    await deps.sendMessage(
      task.chat_jid,
      [
        `CI 감시 일시정지: ${extractWatchCiTarget(task.prompt) || task.id}`,
        `- 사유: gh api 연속 ${metadata.consecutive_errors}회 실패`,
        `- 마지막 오류: ${error.slice(0, 200)}`,
        `- 태스크 ID: \`${task.id}\``,
      ].join('\n'),
    );
  }

  if (error && !paused) {
    await statusTracker.update('retrying', nextRun);
  } else if (paused) {
    // Paused tasks keep their current status message state; the pause notice is sent separately.
  } else if (nextRun) {
    await statusTracker.update('waiting', nextRun);
  } else {
    await statusTracker.update('completed');
  }

  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: durationMs,
    status: error ? 'error' : 'success',
    result,
    error,
  });

  updateTaskAfterRun(
    task.id,
    nextRun,
    error ? `Error: ${error}` : result || 'Completed',
  );
}
