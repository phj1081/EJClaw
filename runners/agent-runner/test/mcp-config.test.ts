import { describe, expect, it } from 'vitest';

import { buildEjclawMcpServerConfig } from '../src/mcp-config.js';

describe('ejclaw MCP config', () => {
  it('always loads EJClaw MCP tools on turn one and preserves runtime env', () => {
    expect(
      buildEjclawMcpServerConfig('/runner/dist/ipc-mcp-stdio.js', {
        chatJid: 'dc:room',
        groupFolder: 'ejclaw',
        isMain: true,
        agentType: 'claude-code',
        roomRole: 'reviewer',
        ipcDir: '/tmp/ipc/task',
        hostIpcDir: '/tmp/ipc/host',
      }),
    ).toEqual({
      command: 'node',
      args: ['/runner/dist/ipc-mcp-stdio.js'],
      alwaysLoad: true,
      env: {
        EJCLAW_CHAT_JID: 'dc:room',
        EJCLAW_GROUP_FOLDER: 'ejclaw',
        EJCLAW_IS_MAIN: '1',
        EJCLAW_AGENT_TYPE: 'claude-code',
        EJCLAW_ROOM_ROLE: 'reviewer',
        EJCLAW_IPC_DIR: '/tmp/ipc/task',
        EJCLAW_HOST_IPC_DIR: '/tmp/ipc/host',
      },
    });
  });
});
