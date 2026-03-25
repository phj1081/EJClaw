import { getTaskById, updateTaskStatusTracking } from './db.js';
import { logger } from './logger.js';
import {
  isWatchCiTask,
  renderWatchCiStatusMessage,
  TASK_STATUS_MESSAGE_PREFIX,
  type WatcherStatusPhase,
} from './task-watch-status.js';
import type { ScheduledTask } from './types.js';

export interface TaskStatusTrackerTransport {
  sendTrackedMessage?: (jid: string, text: string) => Promise<string | null>;
  editTrackedMessage?: (
    jid: string,
    messageId: string,
    text: string,
  ) => Promise<void>;
}

export interface TaskStatusTracker {
  enabled: boolean;
  update: (phase: WatcherStatusPhase, nextRun?: string | null) => Promise<void>;
}

export function createTaskStatusTracker(
  task: ScheduledTask,
  transport: TaskStatusTrackerTransport,
): TaskStatusTracker {
  let statusMessageId = task.status_message_id;
  let statusStartedAt = task.status_started_at;
  const enabled =
    isWatchCiTask(task) &&
    typeof transport.sendTrackedMessage === 'function' &&
    typeof transport.editTrackedMessage === 'function';

  const persist = () => {
    const currentTask = getTaskById(task.id);
    if (!currentTask) return;
    updateTaskStatusTracking(task.id, {
      status_message_id: statusMessageId,
      status_started_at: statusStartedAt,
    });
  };

  const update = async (phase: WatcherStatusPhase, nextRun?: string | null) => {
    if (!enabled) return;

    const checkedAt = new Date().toISOString();
    if (!statusStartedAt) {
      statusStartedAt = checkedAt;
    }

    const payload = `${TASK_STATUS_MESSAGE_PREFIX}${renderWatchCiStatusMessage({
      task,
      phase,
      checkedAt,
      statusStartedAt,
      nextRun,
    })}`;

    if (statusMessageId) {
      try {
        await transport.editTrackedMessage!(
          task.chat_jid,
          statusMessageId,
          payload,
        );
        persist();
        return;
      } catch (err) {
        logger.debug(
          {
            taskId: task.id,
            chatJid: task.chat_jid,
            statusMessageId,
            phase,
            err,
          },
          'Failed to edit watcher status message, falling back to send',
        );
        statusMessageId = null;
        persist();
      }
    }

    const nextMessageId = await transport.sendTrackedMessage!(
      task.chat_jid,
      payload,
    );
    if (nextMessageId) {
      statusMessageId = nextMessageId;
      persist();
    }
  };

  return { enabled, update };
}
