import fs from 'fs';
import path from 'path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { runVerificationRequestMock } = vi.hoisted(() => ({
  runVerificationRequestMock: vi.fn(),
}));

vi.mock('./verification.js', async () => {
  const actual =
    await vi.importActual<typeof import('./verification.js')>(
      './verification.js',
    );
  return {
    ...actual,
    runVerificationRequest: runVerificationRequestMock,
  };
});

import { _initTestDatabase, _setRegisteredGroupForTests } from './db.js';
import { resolveGroupIpcPath } from './group-folder.js';
import { processTaskIpc, type IpcDeps } from './ipc.js';
import type { RegisteredGroup } from './types.js';

const VERIFICATION_GROUP: RegisteredGroup = {
  name: 'Verification',
  folder: 'verification-group',
  trigger: '@Andy',
  added_at: '2024-01-01T00:00:00.000Z',
};

describe('verification IPC', () => {
  let deps: IpcDeps;

  beforeEach(() => {
    _initTestDatabase();
    _setRegisteredGroupForTests('verification@g.us', VERIFICATION_GROUP);
    runVerificationRequestMock.mockReset();

    deps = {
      sendMessage: async () => {},
      registeredGroups: () => ({ 'verification@g.us': VERIFICATION_GROUP }),
      assignRoom: () => {},
      syncGroups: async () => {},
      getAvailableGroups: () => [],
      writeGroupsSnapshot: () => {},
    };

    fs.rmSync(resolveGroupIpcPath('verification-group'), {
      recursive: true,
      force: true,
    });
  });

  it('writes verification responses into the source group namespace', async () => {
    runVerificationRequestMock.mockResolvedValue({
      ok: true,
      profile: 'typecheck',
      command: 'npm run typecheck',
      stdout: '',
      stderr: '',
      exitCode: 0,
      snapshotId: 'fs:abc123',
      runtimeVersion: 'host:bun@test',
    });

    await processTaskIpc(
      {
        type: 'verification_request',
        requestId: 'req-1',
        profile: 'typecheck',
        expected_snapshot_id: 'fs:abc123',
      },
      'verification-group',
      false,
      deps,
    );

    const responsePath = path.join(
      resolveGroupIpcPath('verification-group'),
      'verification-responses',
      'req-1.json',
    );
    const response = JSON.parse(fs.readFileSync(responsePath, 'utf-8')) as {
      ok: boolean;
      requestId: string;
      snapshotId: string;
    };

    expect(runVerificationRequestMock).toHaveBeenCalledWith({
      requestId: 'req-1',
      profile: 'typecheck',
      expectedSnapshotId: 'fs:abc123',
    });
    expect(response.requestId).toBe('req-1');
    expect(response.ok).toBe(true);
    expect(response.snapshotId).toBe('fs:abc123');
  });

  it('returns an error response for unsupported profiles without executing', async () => {
    await processTaskIpc(
      {
        type: 'verification_request',
        requestId: 'req-2',
        profile: 'rm -rf /',
      },
      'verification-group',
      false,
      deps,
    );

    const responsePath = path.join(
      resolveGroupIpcPath('verification-group'),
      'verification-responses',
      'req-2.json',
    );
    const response = JSON.parse(fs.readFileSync(responsePath, 'utf-8')) as {
      ok: boolean;
      error?: string;
    };

    expect(runVerificationRequestMock).not.toHaveBeenCalled();
    expect(response.ok).toBe(false);
    expect(response.error).toContain('Unsupported verification profile');
  });
});
