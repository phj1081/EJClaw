export const EJCLAW_ENV = {
  agentType: 'EJCLAW_AGENT_TYPE',
  chatJid: 'EJCLAW_CHAT_JID',
  globalDir: 'EJCLAW_GLOBAL_DIR',
  groupDir: 'EJCLAW_GROUP_DIR',
  groupFolder: 'EJCLAW_GROUP_FOLDER',
  hostIpcDir: 'EJCLAW_HOST_IPC_DIR',
  ipcDir: 'EJCLAW_IPC_DIR',
  isMain: 'EJCLAW_IS_MAIN',
  roomRole: 'EJCLAW_ROOM_ROLE',
  runId: 'EJCLAW_RUN_ID',
  runtimeTaskId: 'EJCLAW_RUNTIME_TASK_ID',
  workDir: 'EJCLAW_WORK_DIR',
} as const;

export type EjclawEnvName = (typeof EJCLAW_ENV)[keyof typeof EJCLAW_ENV];
