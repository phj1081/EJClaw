import { deleteTask, updateTask } from './db.js';
import { logger } from './logger.js';
import { handleHostEvidenceRequest } from './ipc-task-processor/host-evidence.js';
import { handlePersistMemory } from './ipc-task-processor/memory.js';
import {
  handleAssignRoom,
  handleRefreshGroups,
} from './ipc-task-processor/rooms.js';
import { handleScheduleTask } from './ipc-task-processor/schedule.js';
import {
  handleTaskStateMutation,
  handleUpdateTask,
} from './ipc-task-processor/tasks.js';
import type { IpcDeps, TaskIpcPayload } from './ipc-types.js';

export async function processTaskIpc(
  data: TaskIpcPayload,
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
): Promise<void> {
  switch (data.type) {
    case 'schedule_task':
      handleScheduleTask(data, sourceGroup, isMain, deps);
      break;

    case 'pause_task':
      handleTaskStateMutation(data, sourceGroup, isMain, {
        action: () => updateTask(data.taskId!, { status: 'paused' }),
        successMessage: 'Task paused via IPC',
        unauthorizedMessage: 'Unauthorized task pause attempt',
      });
      break;

    case 'resume_task':
      handleTaskStateMutation(data, sourceGroup, isMain, {
        action: () => updateTask(data.taskId!, { status: 'active' }),
        successMessage: 'Task resumed via IPC',
        unauthorizedMessage: 'Unauthorized task resume attempt',
      });
      break;

    case 'cancel_task':
      handleTaskStateMutation(data, sourceGroup, isMain, {
        action: () => deleteTask(data.taskId!),
        successMessage: 'Task cancelled via IPC',
        unauthorizedMessage: 'Unauthorized task cancel attempt',
      });
      break;

    case 'host_evidence_request':
      await handleHostEvidenceRequest(data, sourceGroup, isMain, deps);
      break;

    case 'update_task':
      handleUpdateTask(data, sourceGroup, isMain);
      break;

    case 'refresh_groups':
      await handleRefreshGroups(sourceGroup, isMain, deps);
      break;

    case 'assign_room':
      handleAssignRoom(data, sourceGroup, isMain, deps);
      break;

    case 'persist_memory':
      handlePersistMemory(data, sourceGroup);
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
