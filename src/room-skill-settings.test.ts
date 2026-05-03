import { Database } from 'bun:sqlite';

import { describe, expect, it } from 'vitest';

import { initializeDatabaseSchema } from './db/bootstrap.js';
import {
  deleteStoredRoomSkillOverrideFromDatabase,
  getStoredRoomSkillOverridesFromDatabase,
  upsertStoredRoomSkillOverrideInDatabase,
} from './db/rooms.js';
import {
  buildRoomSkillSettingsSnapshot,
  type RoomSkillSettingsBuildInput,
} from './room-skill-settings.js';
import type { RuntimeInventorySnapshot } from './runtime-inventory.js';

function skill(name: string, skillPath: string, description = `${name} desc`) {
  return { name, description, path: skillPath };
}

function inventoryFixture(): RuntimeInventorySnapshot {
  return {
    generatedAt: '2026-05-04T00:00:00.000Z',
    projectRoot: '/repo',
    dataDir: '/repo/data',
    service: {
      id: 'codex-main',
      sessionScope: 'codex-main',
      agentType: 'codex',
    },
    codex: {
      configFiles: [],
      skillDirs: [
        {
          label: 'Codex user skills',
          path: '/home/.agents/skills',
          exists: true,
          count: 1,
          skills: [skill('agent-browser', '/home/.agents/skills/browser')],
        },
      ],
      mcp: {
        configPath: {
          label: 'Codex config.toml',
          path: '/home/.codex/config.toml',
          exists: true,
        },
        ejclawConfigured: true,
        serverCount: 1,
      },
    },
    claude: {
      configFiles: [],
      skillDirs: [
        {
          label: 'Claude user skills',
          path: '/home/.claude/skills',
          exists: true,
          count: 1,
          skills: [
            skill('review-helper', '/home/.claude/skills/review-helper'),
          ],
        },
      ],
      mcp: {
        configPath: {
          label: 'Claude settings.json',
          path: '/home/.claude/settings.json',
          exists: true,
        },
        ejclawConfigured: true,
        serverCount: 1,
      },
    },
    ejclaw: {
      runnerSkillDir: {
        label: 'EJClaw runner skills',
        path: '/repo/runners/skills',
        exists: true,
        count: 1,
        skills: [
          skill('runner-browser', '/repo/runners/skills/runner-browser'),
        ],
      },
      mcpServer: {
        label: 'EJClaw IPC MCP server',
        path: '/repo/runners/agent-runner/dist/ipc-mcp-stdio.js',
        exists: true,
      },
    },
  };
}

describe('room skill settings', () => {
  it('builds room-scoped effective skill policy from inventory and overrides', () => {
    const input: RoomSkillSettingsBuildInput = {
      generatedAt: '2026-05-04T00:00:00.000Z',
      inventory: inventoryFixture(),
      roomBindings: {
        'room-1': {
          name: 'Room One',
          folder: 'room-one',
          added_at: '2026-05-04T00:00:00.000Z',
          agentType: 'codex',
        },
      },
      registeredAgentTypesByJid: new Map([
        ['room-1', ['claude-code', 'codex']],
      ]),
      overrides: [
        {
          chatJid: 'room-1',
          agentType: 'claude-code',
          skillScope: 'claude-user',
          skillName: 'review-helper',
          enabled: false,
          createdAt: '2026-05-04T00:00:00.000Z',
          updatedAt: '2026-05-04T00:00:00.000Z',
        },
      ],
    };

    const snapshot = buildRoomSkillSettingsSnapshot(input);

    expect(snapshot.catalog.map((skill) => skill.id).sort()).toEqual([
      'claude-user:review-helper',
      'codex-user:browser',
      'runner:runner-browser',
    ]);
    expect(snapshot.rooms).toHaveLength(1);
    const room = snapshot.rooms[0]!;
    expect(room.agents.map((agent) => agent.agentType)).toEqual([
      'claude-code',
      'codex',
    ]);
    expect(
      room.agents.find((agent) => agent.agentType === 'codex'),
    ).toMatchObject({
      mode: 'all-enabled',
      availableSkillIds: ['codex-user:browser', 'runner:runner-browser'],
      effectiveEnabledSkillIds: ['codex-user:browser', 'runner:runner-browser'],
    });
    expect(
      room.agents.find((agent) => agent.agentType === 'claude-code'),
    ).toMatchObject({
      mode: 'custom',
      availableSkillIds: ['claude-user:review-helper', 'runner:runner-browser'],
      disabledSkillIds: ['claude-user:review-helper'],
      effectiveEnabledSkillIds: ['runner:runner-browser'],
    });
  });

  it('keeps default mode when explicit enable rows do not change effective skills', () => {
    const snapshot = buildRoomSkillSettingsSnapshot({
      generatedAt: '2026-05-04T00:00:00.000Z',
      inventory: inventoryFixture(),
      roomBindings: {
        'room-1': {
          name: 'Room One',
          folder: 'room-one',
          added_at: '2026-05-04T00:00:00.000Z',
          agentType: 'codex',
        },
      },
      registeredAgentTypesByJid: new Map([['room-1', ['codex']]]),
      overrides: [
        {
          chatJid: 'room-1',
          agentType: 'codex',
          skillScope: 'runner',
          skillName: 'runner-browser',
          enabled: true,
          createdAt: '2026-05-04T00:00:00.000Z',
          updatedAt: '2026-05-04T00:00:00.000Z',
        },
      ],
    });

    expect(snapshot.rooms[0]?.agents[0]).toMatchObject({
      mode: 'all-enabled',
      explicitEnabledSkillIds: ['runner:runner-browser'],
      effectiveEnabledSkillIds: ['codex-user:browser', 'runner:runner-browser'],
    });
  });

  it('reads normalized room skill overrides from the database', () => {
    const database = new Database(':memory:');
    try {
      initializeDatabaseSchema(database);
      database
        .prepare(
          `INSERT INTO room_settings (
             chat_jid, room_mode, mode_source, name, folder, updated_at
           ) VALUES (?, 'single', 'explicit', ?, ?, ?)`,
        )
        .run('room-1', 'Room One', 'room-one', '2026-05-04T00:00:00.000Z');
      database
        .prepare(
          `INSERT INTO room_skill_overrides (
             chat_jid, agent_type, skill_scope, skill_name, enabled,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'room-1',
          'codex',
          'runner',
          'agent-browser',
          0,
          '2026-05-04T00:00:00.000Z',
          '2026-05-04T00:00:00.000Z',
        );

      expect(getStoredRoomSkillOverridesFromDatabase(database)).toEqual([
        {
          chatJid: 'room-1',
          agentType: 'codex',
          skillScope: 'runner',
          skillName: 'agent-browser',
          enabled: false,
          createdAt: '2026-05-04T00:00:00.000Z',
          updatedAt: '2026-05-04T00:00:00.000Z',
        },
      ]);
      expect(
        getStoredRoomSkillOverridesFromDatabase(database, 'missing-room'),
      ).toEqual([]);
    } finally {
      database.close();
    }
  });

  it('upserts and deletes room skill overrides in the database', () => {
    const database = new Database(':memory:');
    try {
      initializeDatabaseSchema(database);
      database
        .prepare(
          `INSERT INTO room_settings (
             chat_jid, room_mode, mode_source, name, folder, updated_at
           ) VALUES (?, 'single', 'explicit', ?, ?, ?)`,
        )
        .run('room-1', 'Room One', 'room-one', '2026-05-04T00:00:00.000Z');

      upsertStoredRoomSkillOverrideInDatabase(database, {
        chatJid: 'room-1',
        agentType: 'codex',
        skillScope: 'runner',
        skillName: 'agent-browser',
        enabled: false,
      });
      expect(getStoredRoomSkillOverridesFromDatabase(database)).toMatchObject([
        {
          chatJid: 'room-1',
          agentType: 'codex',
          skillScope: 'runner',
          skillName: 'agent-browser',
          enabled: false,
        },
      ]);

      upsertStoredRoomSkillOverrideInDatabase(database, {
        chatJid: 'room-1',
        agentType: 'codex',
        skillScope: 'runner',
        skillName: 'agent-browser',
        enabled: true,
      });
      expect(
        getStoredRoomSkillOverridesFromDatabase(database)[0],
      ).toMatchObject({
        enabled: true,
      });

      deleteStoredRoomSkillOverrideFromDatabase(database, {
        chatJid: 'room-1',
        agentType: 'codex',
        skillScope: 'runner',
        skillName: 'agent-browser',
      });
      expect(getStoredRoomSkillOverridesFromDatabase(database)).toEqual([]);
    } finally {
      database.close();
    }
  });
});
