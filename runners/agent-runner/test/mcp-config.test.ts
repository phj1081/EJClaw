import { describe, expect, it } from 'vitest';
import { EJCLAW_ENV } from 'ejclaw-runners-shared';

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
        [EJCLAW_ENV.chatJid]: 'dc:room',
        [EJCLAW_ENV.groupFolder]: 'ejclaw',
        [EJCLAW_ENV.isMain]: '1',
        [EJCLAW_ENV.agentType]: 'claude-code',
        [EJCLAW_ENV.roomRole]: 'reviewer',
        [EJCLAW_ENV.ipcDir]: '/tmp/ipc/task',
        [EJCLAW_ENV.hostIpcDir]: '/tmp/ipc/host',
      },
    });
  });
});
