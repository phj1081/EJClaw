import type { McpStdioServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { EJCLAW_ENV } from 'ejclaw-runners-shared';

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
      [EJCLAW_ENV.chatJid]: input.chatJid,
      [EJCLAW_ENV.groupFolder]: input.groupFolder,
      [EJCLAW_ENV.isMain]: input.isMain ? '1' : '0',
      [EJCLAW_ENV.agentType]: input.agentType,
      [EJCLAW_ENV.roomRole]: input.roomRole,
      ...(input.ipcDir && {
        [EJCLAW_ENV.ipcDir]: input.ipcDir,
      }),
      ...(input.hostIpcDir && {
        [EJCLAW_ENV.hostIpcDir]: input.hostIpcDir,
      }),
    },
  };
}
