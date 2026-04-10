import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Database } from 'bun:sqlite';

describe('migrate json state step', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not migrate legacy json state during startup and leaves files in place', async () => {
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'ejclaw-migrate-json-init-'),
    );
    tempRoots.push(tempRoot);
    const storeDir = path.join(tempRoot, 'store');
    const dataDir = path.join(tempRoot, 'data');
    fs.mkdirSync(storeDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    vi.stubEnv('EJCLAW_STORE_DIR', storeDir);
    vi.stubEnv('EJCLAW_DATA_DIR', dataDir);

    fs.writeFileSync(
      path.join(dataDir, 'router_state.json'),
      JSON.stringify({ last_timestamp: '1234' }),
    );
    fs.writeFileSync(
      path.join(dataDir, 'sessions.json'),
      JSON.stringify({ 'group-a': 'session-123' }),
    );

    const { _initTestDatabase, initDatabase } = await import('../src/db.js');

    expect(() => initDatabase()).toThrow(
      /Legacy JSON state migration required before startup/,
    );
    expect(fs.existsSync(path.join(dataDir, 'router_state.json'))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, 'sessions.json'))).toBe(true);
    expect(
      fs.existsSync(path.join(dataDir, 'router_state.json.migrated')),
    ).toBe(false);
    expect(fs.existsSync(path.join(dataDir, 'sessions.json.migrated'))).toBe(
      false,
    );

    _initTestDatabase();
  });

  it('migrates router_state.json and sessions.json only via explicit setup step', async () => {
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'ejclaw-migrate-json-step-'),
    );
    tempRoots.push(tempRoot);
    const storeDir = path.join(tempRoot, 'store');
    const dataDir = path.join(tempRoot, 'data');
    fs.mkdirSync(storeDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    vi.stubEnv('EJCLAW_STORE_DIR', storeDir);
    vi.stubEnv('EJCLAW_DATA_DIR', dataDir);

    fs.writeFileSync(
      path.join(dataDir, 'router_state.json'),
      JSON.stringify({
        last_timestamp: '1234',
        last_agent_timestamp: {
          'dc:test-room': '5678',
        },
      }),
    );
    fs.writeFileSync(
      path.join(dataDir, 'sessions.json'),
      JSON.stringify({
        'group-a': 'session-123',
        'group-b': 'session-456',
      }),
    );

    const emitStatusMock = vi.fn();
    vi.doMock('./status.js', () => ({
      emitStatus: emitStatusMock,
    }));

    const { run } = await import('./migrate-json-state.js');

    await run([]);

    const db = new Database(path.join(storeDir, 'messages.db'), {
      readonly: true,
    });
    expect(
      db.prepare('SELECT key, value FROM router_state ORDER BY key').all(),
    ).toEqual([
      {
        key: 'last_agent_seq',
        value: '{"dc:test-room":"5678"}',
      },
      {
        key: 'last_seq',
        value: '1234',
      },
    ]);
    expect(
      db
        .prepare(
          `SELECT group_folder, agent_type, session_id
             FROM sessions
            ORDER BY group_folder`,
        )
        .all(),
    ).toEqual([
      {
        group_folder: 'group-a',
        agent_type: 'claude-code',
        session_id: 'session-123',
      },
      {
        group_folder: 'group-b',
        agent_type: 'claude-code',
        session_id: 'session-456',
      },
    ]);
    db.close();

    expect(fs.existsSync(path.join(dataDir, 'router_state.json'))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, 'sessions.json'))).toBe(false);
    expect(
      fs.existsSync(path.join(dataDir, 'router_state.json.migrated')),
    ).toBe(true);
    expect(fs.existsSync(path.join(dataDir, 'sessions.json.migrated'))).toBe(
      true,
    );
    expect(emitStatusMock).toHaveBeenLastCalledWith(
      'MIGRATE_JSON_STATE',
      expect.objectContaining({
        MIGRATED_ROUTER_STATE_KEYS: 2,
        MIGRATED_SESSIONS: 2,
        RENAMED_ROUTER_STATE_JSON: true,
        RENAMED_SESSIONS_JSON: true,
        STATUS: 'success',
      }),
    );
  });
});
