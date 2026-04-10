import fs from 'fs';
import path from 'path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { runHostEvidenceRequestMock } = vi.hoisted(() => ({
  runHostEvidenceRequestMock: vi.fn(),
}));

vi.mock('./host-evidence.js', async () => {
  const actual =
    await vi.importActual<typeof import('./host-evidence.js')>(
      './host-evidence.js',
    );
  return {
    ...actual,
    runHostEvidenceRequest: runHostEvidenceRequestMock,
  };
});

import { _initTestDatabase, _setRegisteredGroupForTests } from './db.js';
import { resolveGroupIpcPath } from './group-folder.js';
import { processTaskIpc, type IpcDeps } from './ipc.js';
import type { RegisteredGroup } from './types.js';

const OTHER_GROUP: RegisteredGroup = {
  name: 'Other',
  folder: 'other-group',
  trigger: '@Andy',
  added_at: '2024-01-01T00:00:00.000Z',
};

describe('host evidence IPC', () => {
  let deps: IpcDeps;

  beforeEach(() => {
    _initTestDatabase();
    _setRegisteredGroupForTests('other@g.us', OTHER_GROUP);
    runHostEvidenceRequestMock.mockReset();

    deps = {
      sendMessage: async () => {},
      roomBindings: () => ({ 'other@g.us': OTHER_GROUP }),
      assignRoom: () => {},
      syncGroups: async () => {},
      getAvailableGroups: () => [],
      writeGroupsSnapshot: () => {},
    };

    fs.rmSync(resolveGroupIpcPath('other-group'), {
      recursive: true,
      force: true,
    });
  });

  it('writes host evidence responses into the source group namespace', async () => {
    runHostEvidenceRequestMock.mockResolvedValue({
      ok: true,
      action: 'ejclaw_service_status',
      command: 'systemctl --user show ejclaw',
      stdout: 'ActiveState=active\nSubState=running\n',
      stderr: '',
      exitCode: 0,
    });

    await processTaskIpc(
      {
        type: 'host_evidence_request',
        requestId: 'req-1',
        action: 'ejclaw_service_status',
      },
      'other-group',
      false,
      deps,
    );

    const responsePath = path.join(
      resolveGroupIpcPath('other-group'),
      'host-evidence-responses',
      'req-1.json',
    );
    const response = JSON.parse(fs.readFileSync(responsePath, 'utf-8')) as {
      ok: boolean;
      requestId: string;
      stdout: string;
    };

    expect(runHostEvidenceRequestMock).toHaveBeenCalledWith({
      requestId: 'req-1',
      action: 'ejclaw_service_status',
      tailLines: undefined,
    });
    expect(response.requestId).toBe('req-1');
    expect(response.ok).toBe(true);
    expect(response.stdout).toContain('ActiveState=active');
  });

  it('returns an error response for unsupported actions without shelling out', async () => {
    await processTaskIpc(
      {
        type: 'host_evidence_request',
        requestId: 'req-2',
        action: 'cat /etc/shadow',
      },
      'other-group',
      false,
      deps,
    );

    const responsePath = path.join(
      resolveGroupIpcPath('other-group'),
      'host-evidence-responses',
      'req-2.json',
    );
    const response = JSON.parse(fs.readFileSync(responsePath, 'utf-8')) as {
      ok: boolean;
      error?: string;
    };

    expect(runHostEvidenceRequestMock).not.toHaveBeenCalled();
    expect(response.ok).toBe(false);
    expect(response.error).toContain('Unsupported host evidence action');
  });
});
