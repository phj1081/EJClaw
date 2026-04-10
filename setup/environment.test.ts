import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Database } from 'bun:sqlite';
import { detectAssignedRooms, run as runEnvironment } from './environment.js';

/**
 * Tests for the environment check step.
 *
 * Verifies: config detection, platform helpers, DB queries.
 */

describe('environment detection', () => {
  it('detects platform correctly', async () => {
    const { getPlatform } = await import('./platform.js');
    const platform = getPlatform();
    expect(['macos', 'linux', 'unknown']).toContain(platform);
  });
});

describe('assigned rooms detection', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns false when the database does not exist', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ejclaw-env-'));
    tempDirs.push(tempDir);

    expect(
      detectAssignedRooms({ dbPath: path.join(tempDir, 'messages.db') }),
    ).toBe(false);
  });

  it('returns false for an empty room_settings table', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ejclaw-env-'));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, 'messages.db');
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE room_settings (chat_jid TEXT PRIMARY KEY)`);
    db.close();

    expect(detectAssignedRooms({ dbPath })).toBe(false);
  });

  it('returns true when canonical room assignments exist', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ejclaw-env-'));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, 'messages.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE room_settings (
        chat_jid TEXT PRIMARY KEY,
        room_mode TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    db.prepare(
      `INSERT INTO room_settings (chat_jid, room_mode, updated_at)
       VALUES (?, ?, ?)`,
    ).run('dc:room-1', 'single', '2024-01-01T00:00:00.000Z');
    db.close();

    expect(detectAssignedRooms({ dbPath })).toBe(true);
  });

  it('returns false when only legacy registered_groups rows exist', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ejclaw-env-'));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, 'messages.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE registered_groups (
        jid TEXT PRIMARY KEY,
        agent_type TEXT
      )
    `);
    db.exec(`
      INSERT INTO registered_groups (jid, agent_type)
      VALUES ('dc:legacy-room', 'claude-code')
    `);
    db.close();

    expect(detectAssignedRooms({ dbPath })).toBe(false);
  });
});

describe('environment step legacy-room handling', () => {
  const originalCwd = process.cwd();
  const tempDirs: string[] = [];

  afterEach(() => {
    process.chdir(originalCwd);
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it('exits with failure when legacy-only room registrations need migration', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ejclaw-env-run-'));
    tempDirs.push(tempDir);
    process.chdir(tempDir);

    fs.mkdirSync(path.join(tempDir, 'store'), { recursive: true });
    const db = new Database(path.join(tempDir, 'store', 'messages.db'));
    db.exec(`
      CREATE TABLE registered_groups (
        jid TEXT PRIMARY KEY,
        agent_type TEXT
      )
    `);
    db.exec(`
      INSERT INTO registered_groups (jid, agent_type)
      VALUES ('dc:legacy-room', 'claude-code')
    `);
    db.close();

    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code?: string | number | null | undefined) => {
        throw new Error(`process.exit:${code}`);
      });

    await expect(runEnvironment([])).rejects.toThrow('process.exit:1');
    exitSpy.mockRestore();
  });

  it('exits with failure when canonical rooms exist but pending legacy registrations remain', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ejclaw-env-run-'));
    tempDirs.push(tempDir);
    process.chdir(tempDir);

    fs.mkdirSync(path.join(tempDir, 'store'), { recursive: true });
    const db = new Database(path.join(tempDir, 'store', 'messages.db'));
    db.exec(`
      CREATE TABLE room_settings (
        chat_jid TEXT PRIMARY KEY,
        room_mode TEXT NOT NULL
      );
      CREATE TABLE registered_groups (
        jid TEXT PRIMARY KEY,
        agent_type TEXT
      )
    `);
    db.exec(`
      INSERT INTO room_settings (chat_jid, room_mode)
      VALUES ('dc:canonical-room', 'single')
    `);
    db.exec(`
      INSERT INTO registered_groups (jid, agent_type)
      VALUES ('dc:legacy-room', 'claude-code')
    `);
    db.close();

    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code?: string | number | null | undefined) => {
        throw new Error(`process.exit:${code}`);
      });

    await expect(runEnvironment([])).rejects.toThrow('process.exit:1');
    exitSpy.mockRestore();
  });

  it('exits with failure when unexpected data state files are present', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ejclaw-env-run-'));
    tempDirs.push(tempDir);
    process.chdir(tempDir);

    fs.mkdirSync(path.join(tempDir, 'data'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'data', 'router_state.json'),
      JSON.stringify({ last_timestamp: '1234' }),
    );

    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code?: string | number | null | undefined) => {
        throw new Error(`process.exit:${code}`);
      });

    await expect(runEnvironment([])).rejects.toThrow('process.exit:1');
    exitSpy.mockRestore();
  });
});

describe('credentials detection', () => {
  it('detects ANTHROPIC_API_KEY in env content', () => {
    const content =
      'SOME_KEY=value\nANTHROPIC_API_KEY=sk-ant-test123\nOTHER=foo';
    const hasCredentials =
      /^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)=/m.test(content);
    expect(hasCredentials).toBe(true);
  });

  it('detects CLAUDE_CODE_OAUTH_TOKEN in env content', () => {
    const content = 'CLAUDE_CODE_OAUTH_TOKEN=token123';
    const hasCredentials =
      /^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)=/m.test(content);
    expect(hasCredentials).toBe(true);
  });

  it('returns false when no credentials', () => {
    const content = 'ASSISTANT_NAME="Andy"\nOTHER=foo';
    const hasCredentials =
      /^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)=/m.test(content);
    expect(hasCredentials).toBe(false);
  });
});

describe('platform command detection', () => {
  it('commandExists returns boolean', async () => {
    const { commandExists } = await import('./platform.js');
    expect(typeof commandExists('git')).toBe('boolean');
    expect(typeof commandExists('nonexistent_binary_xyz')).toBe('boolean');
  });
});
