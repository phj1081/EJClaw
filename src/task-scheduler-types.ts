import type { ChildProcess } from 'child_process';

import type { GroupQueue } from './group-queue.js';
import type { AgentType, RegisteredGroup } from './types.js';

export interface SchedulerDependencies {
  serviceAgentType?: AgentType;
  roomBindings: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  queue: GroupQueue;
  onProcess: (
    groupJid: string,
    proc: ChildProcess,
    processName: string,
    ipcDir: string,
  ) => void;
  sendMessage: (jid: string, text: string) => Promise<void>;
  sendMessageViaReviewerBot?: (jid: string, text: string) => Promise<void>;
  sendTrackedMessage?: (jid: string, text: string) => Promise<string | null>;
  editTrackedMessage?: (
    jid: string,
    messageId: string,
    text: string,
  ) => Promise<void>;
}

export interface TaskExecutionContext {
  group: RegisteredGroup;
  groupDir: string;
  isMain: boolean;
  queueJid: string;
  runtimeIpcDir: string;
  runtimeTaskId?: string;
  sessionId?: string;
  useTaskScopedSession: boolean;
  taskAgentType: AgentType;
}
