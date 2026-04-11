import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { Database } from 'bun:sqlite';

import type { ServiceDef } from './service-defs.js';
import type { ServiceCheck } from './verify-services.js';
import {
  buildVerifySummary,
  detectChannelAuth,
  detectCredentials,
  loadRoleRoutingRequirementsSummary,
} from './verify-state.js';

describe('verify state helpers', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('detects configured credentials from .env', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ejclaw-verify-'));
    tempRoots.push(tempRoot);
    fs.writeFileSync(
      path.join(tempRoot, '.env'),
      'CLAUDE_CODE_OAUTH_TOKEN=test-token\n',
    );

    expect(detectCredentials(tempRoot)).toBe('configured');
  });

  it('detects configured multi-account credentials from .env', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ejclaw-verify-'));
    tempRoots.push(tempRoot);
    fs.writeFileSync(
      path.join(tempRoot, '.env'),
      'CLAUDE_CODE_OAUTH_TOKENS=test-token-1,test-token-2\n',
    );

    expect(detectCredentials(tempRoot)).toBe('configured');
  });

  it('detects canonical role-based channel auth names from process env', () => {
    expect(
      detectChannelAuth(
        {},
        {
          DISCORD_OWNER_BOT_TOKEN: 'owner-token',
          DISCORD_REVIEWER_BOT_TOKEN: 'reviewer-token',
          DISCORD_ARBITER_BOT_TOKEN: 'arbiter-token',
        },
      ),
    ).toEqual({
      discord: 'configured',
      'discord-review': 'configured',
      'discord-arbiter': 'configured',
    });
  });

  it('does not treat unknown discord token names as configured channels', () => {
    expect(
      detectChannelAuth(
        {},
        {
          DISCORD_UNUSED_BOT_TOKEN: 'unknown-token',
        },
      ),
    ).toEqual({});
  });

  it('loads paired-room routing requirements from the sqlite store', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ejclaw-verify-'));
    tempRoots.push(tempRoot);
    const dbPath = path.join(tempRoot, 'messages.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE room_settings (
        chat_jid TEXT PRIMARY KEY,
        room_mode TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    db.exec(`
      CREATE TABLE paired_tasks (
        id TEXT PRIMARY KEY,
        chat_jid TEXT NOT NULL,
        status TEXT NOT NULL
      );
    `);
    db.exec(`
      INSERT INTO room_settings (chat_jid, room_mode, updated_at) VALUES
        ('group-1', 'tribunal', '2024-01-01T00:00:00.000Z'),
        ('group-2', 'single', '2024-01-01T00:00:00.000Z');
    `);
    db.exec(`
      INSERT INTO paired_tasks (id, chat_jid, status) VALUES
        ('task-1', 'group-1', 'arbiter_requested'),
        ('task-2', 'group-2', 'completed');
    `);
    db.close();

    expect(loadRoleRoutingRequirementsSummary({ dbPath })).toEqual({
      tribunalRooms: 1,
      activeArbiterTasks: 1,
    });
  });

  it('builds a successful verification summary when all gates pass', () => {
    const services: ServiceCheck[] = [{ name: 'ejclaw', status: 'running' }];
    const serviceDefs: ServiceDef[] = [
      {
        kind: 'primary',
        name: 'ejclaw',
        description: 'EJClaw',
        launchdLabel: 'com.ejclaw',
        logName: 'ejclaw',
      },
    ];

    expect(
      buildVerifySummary(
        services,
        serviceDefs,
        'configured',
        {
          discord: 'configured',
          'discord-review': 'configured',
          'discord-arbiter': 'configured',
        },
        {
          assignedRooms: 2,
          roomsByOwnerAgent: { codex: 1 },
          legacyRegisteredGroupRows: 0,
          legacyRoomMigrationRequired: false,
          unexpectedDataStateFiles: [],
          unexpectedDataStateDetected: false,
        },
      ),
    ).toMatchObject({
      status: 'success',
      configuredChannels: ['discord', 'discord-review', 'discord-arbiter'],
      reviewerChannelConfigured: true,
      arbiterChannelConfigured: true,
      servicesSummary: { ejclaw: 'running' },
    });
  });

  it('fails verification when any required gate is missing', () => {
    const services: ServiceCheck[] = [{ name: 'ejclaw', status: 'stopped' }];

    expect(
      buildVerifySummary(
        services,
        [],
        'missing',
        {},
        {
          assignedRooms: 0,
          roomsByOwnerAgent: {},
          legacyRegisteredGroupRows: 0,
          legacyRoomMigrationRequired: false,
          unexpectedDataStateFiles: [],
          unexpectedDataStateDetected: false,
        },
      ),
    ).toMatchObject({
      status: 'failed',
      configuredChannels: [],
      servicesSummary: { ejclaw: 'stopped' },
    });
  });

  it('fails verification when only the review channel is configured', () => {
    const services: ServiceCheck[] = [{ name: 'ejclaw', status: 'running' }];

    expect(
      buildVerifySummary(
        services,
        [],
        'configured',
        { 'discord-review': 'configured' },
        {
          assignedRooms: 1,
          roomsByOwnerAgent: {},
          legacyRegisteredGroupRows: 0,
          legacyRoomMigrationRequired: false,
          unexpectedDataStateFiles: [],
          unexpectedDataStateDetected: false,
        },
      ),
    ).toMatchObject({
      status: 'failed',
      configuredChannels: ['discord-review'],
      reviewerChannelConfigured: true,
      arbiterChannelConfigured: false,
      servicesSummary: { ejclaw: 'running' },
    });
  });

  it('fails verification when tribunal rooms exist but the reviewer channel is missing', () => {
    const services: ServiceCheck[] = [{ name: 'ejclaw', status: 'running' }];

    expect(
      buildVerifySummary(
        services,
        [],
        'configured',
        { discord: 'configured' },
        {
          assignedRooms: 1,
          roomsByOwnerAgent: {},
          legacyRegisteredGroupRows: 0,
          legacyRoomMigrationRequired: false,
          unexpectedDataStateFiles: [],
          unexpectedDataStateDetected: false,
        },
        { tribunalRooms: 1 },
      ),
    ).toMatchObject({
      status: 'failed',
      configuredChannels: ['discord'],
      reviewerChannelConfigured: false,
      arbiterChannelConfigured: false,
      tribunalRooms: 1,
    });
  });

  it('fails verification when arbiter work is pending but the arbiter channel is missing', () => {
    const services: ServiceCheck[] = [{ name: 'ejclaw', status: 'running' }];

    expect(
      buildVerifySummary(
        services,
        [],
        'configured',
        {
          discord: 'configured',
          'discord-review': 'configured',
        },
        {
          assignedRooms: 1,
          roomsByOwnerAgent: {},
          legacyRegisteredGroupRows: 0,
          legacyRoomMigrationRequired: false,
          unexpectedDataStateFiles: [],
          unexpectedDataStateDetected: false,
        },
        { tribunalRooms: 1, activeArbiterTasks: 1 },
      ),
    ).toMatchObject({
      status: 'failed',
      configuredChannels: ['discord', 'discord-review'],
      reviewerChannelConfigured: true,
      arbiterChannelConfigured: false,
      activeArbiterTasks: 1,
    });
  });

  it('fails verification when legacy room migration is still required', () => {
    const services: ServiceCheck[] = [{ name: 'ejclaw', status: 'running' }];

    expect(
      buildVerifySummary(
        services,
        [],
        'configured',
        { discord: 'configured' },
        {
          assignedRooms: 0,
          roomsByOwnerAgent: {},
          legacyRegisteredGroupRows: 2,
          legacyRoomMigrationRequired: true,
          unexpectedDataStateFiles: [],
          unexpectedDataStateDetected: false,
        },
      ),
    ).toMatchObject({
      status: 'failed',
      legacyRoomMigrationRequired: true,
      legacyRegisteredGroupRows: 2,
    });
  });

  it('fails verification when unexpected data state files are still present', () => {
    const services: ServiceCheck[] = [{ name: 'ejclaw', status: 'running' }];

    expect(
      buildVerifySummary(
        services,
        [],
        'configured',
        { discord: 'configured' },
        {
          assignedRooms: 1,
          roomsByOwnerAgent: { codex: 1 },
          legacyRegisteredGroupRows: 0,
          legacyRoomMigrationRequired: false,
          unexpectedDataStateFiles: ['router_state.json'],
          unexpectedDataStateDetected: true,
        },
      ),
    ).toMatchObject({
      status: 'failed',
      unexpectedDataStateDetected: true,
      unexpectedDataStateFiles: ['router_state.json'],
    });
  });
});
