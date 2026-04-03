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
  detectLegacyDiscordTokenKeys,
  loadRegisteredGroupsSummary,
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

  it('does not treat legacy service-based channel auth names as configured channels', () => {
    expect(
      detectChannelAuth(
        {},
        {
          DISCORD_CLAUDE_BOT_TOKEN: 'legacy-owner-token',
          DISCORD_CODEX_MAIN_BOT_TOKEN: 'legacy-reviewer-token',
          DISCORD_CODEX_REVIEW_BOT_TOKEN: 'legacy-arbiter-token',
        },
      ),
    ).toEqual({});
  });

  it('detects legacy service-based discord token names from env file and process env', () => {
    expect(
      detectLegacyDiscordTokenKeys(
        {
          DISCORD_BOT_TOKEN: 'legacy-owner-token',
        },
        {
          DISCORD_CODEX_MAIN_BOT_TOKEN: 'legacy-reviewer-token',
          DISCORD_CODEX_REVIEW_BOT_TOKEN: 'legacy-arbiter-token',
        },
      ),
    ).toEqual([
      'DISCORD_BOT_TOKEN',
      'DISCORD_CODEX_MAIN_BOT_TOKEN',
      'DISCORD_CODEX_REVIEW_BOT_TOKEN',
    ]);
  });

  it('loads paired-room routing requirements from the sqlite store', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ejclaw-verify-'));
    tempRoots.push(tempRoot);
    const dbPath = path.join(tempRoot, 'messages.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE registered_groups (
        jid TEXT NOT NULL,
        agent_type TEXT
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
      INSERT INTO registered_groups (jid, agent_type) VALUES
        ('group-1', 'claude-code'),
        ('group-1', 'codex'),
        ('group-2', 'claude-code');
    `);
    db.exec(`
      INSERT INTO paired_tasks (id, chat_jid, status) VALUES
        ('task-1', 'group-1', 'arbiter_requested'),
        ('task-2', 'group-2', 'completed');
    `);
    db.close();

    expect(loadRoleRoutingRequirementsSummary(dbPath)).toEqual({
      tribunalRooms: 1,
      activeArbiterTasks: 1,
    });
  });

  it('loads registered group counts from the sqlite store', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ejclaw-verify-'));
    tempRoots.push(tempRoot);
    const dbPath = path.join(tempRoot, 'messages.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE registered_groups (
        jid TEXT PRIMARY KEY,
        agent_type TEXT
      );
    `);
    db.exec(`
      INSERT INTO registered_groups (jid, agent_type) VALUES
        ('group-1', 'claude-code'),
        ('group-2', 'codex'),
        ('group-3', 'codex');
    `);
    db.close();

    expect(loadRegisteredGroupsSummary(dbPath)).toEqual({
      registeredGroups: 3,
      groupsByAgent: {
        'claude-code': 1,
        codex: 2,
      },
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
        2,
        { codex: 1 },
      ),
    ).toMatchObject({
      status: 'success',
      configuredChannels: ['discord', 'discord-review', 'discord-arbiter'],
      codexConfigured: true,
      reviewConfigured: true,
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
        0,
        {},
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
        1,
        {},
      ),
    ).toMatchObject({
      status: 'failed',
      configuredChannels: ['discord-review'],
      codexConfigured: true,
      reviewConfigured: false,
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
        1,
        {},
        { tribunalRooms: 1 },
      ),
    ).toMatchObject({
      status: 'failed',
      configuredChannels: ['discord'],
      codexConfigured: false,
      reviewConfigured: false,
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
        1,
        {},
        { tribunalRooms: 1, activeArbiterTasks: 1 },
      ),
    ).toMatchObject({
      status: 'failed',
      configuredChannels: ['discord', 'discord-review'],
      codexConfigured: true,
      reviewConfigured: false,
      activeArbiterTasks: 1,
    });
  });

  it('fails verification when legacy discord token names are still configured', () => {
    const services: ServiceCheck[] = [{ name: 'ejclaw', status: 'running' }];

    expect(
      buildVerifySummary(
        services,
        [],
        'configured',
        {
          discord: 'configured',
          'discord-review': 'configured',
          'discord-arbiter': 'configured',
        },
        1,
        {},
        { legacyDiscordTokenKeys: ['DISCORD_BOT_TOKEN'] },
      ),
    ).toMatchObject({
      status: 'failed',
      legacyDiscordTokenKeys: ['DISCORD_BOT_TOKEN'],
    });
  });
});
