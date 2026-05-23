import type { McpStdioServerConfig } from '@anthropic-ai/claude-agent-sdk';

export interface EjclawMcpServerConfigInput {
  chatJid: string;
  groupFolder: string;
  isMain: boolean;
  agentType: string;
  roomRole: string;
  ipcDir?: string;
  hostIpcDir?: string;
}

export function buildEjclawMcpServerConfig(
  mcpServerPath: string,
  input: EjclawMcpServerConfigInput,
): McpStdioServerConfig {
  return {
    command: 'node',
    args: [mcpServerPath],
    alwaysLoad: true,
    env: {
      EJCLAW_CHAT_JID: input.chatJid,
      EJCLAW_GROUP_FOLDER: input.groupFolder,
      EJCLAW_IS_MAIN: input.isMain ? '1' : '0',
      EJCLAW_AGENT_TYPE: input.agentType,
      EJCLAW_ROOM_ROLE: input.roomRole,
      ...(input.ipcDir && {
        EJCLAW_IPC_DIR: input.ipcDir,
      }),
      ...(input.hostIpcDir && {
        EJCLAW_HOST_IPC_DIR: input.hostIpcDir,
      }),
    },
  };
}
