import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  _deleteStoredRoomSettingsForTests,
  _setRegisteredGroupForTests,
  assignRoom,
  clearExplicitRoomMode,
  getAllRoomBindings,
  getEffectiveRoomMode,
  getEffectiveRuntimeRoomMode,
  getExplicitRoomMode,
  getRegisteredGroup,
  getRegisteredAgentTypesForJid,
  getStoredRoomSettings,
  setExplicitRoomMode,
  updateRegisteredGroupName,
} from './db.js';

beforeEach(() => {
  _initTestDatabase();
});

describe('registered group isMain', () => {
  it('projects trigger metadata from canonical room settings into registered groups', () => {
    _setRegisteredGroupForTests('dc:triggered', {
      name: 'Triggered Room',
      folder: 'triggered-room',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      requiresTrigger: true,
    });

    expect(getRegisteredGroup('dc:triggered')).toMatchObject({
      trigger: '@Andy',
      requiresTrigger: true,
    });
    expect(getAllRoomBindings()['dc:triggered']).toMatchObject({
      trigger: '@Andy',
      requiresTrigger: true,
    });
  });

  it('persists isMain=true through set/get round-trip', () => {
    _setRegisteredGroupForTests('dc:main', {
      name: 'Main Chat',
      folder: 'discord_main',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: true,
    });

    const groups = getAllRoomBindings();
    const group = groups['dc:main'];
    expect(group).toBeDefined();
    expect(group.isMain).toBe(true);
    expect(group.folder).toBe('discord_main');
  });

  it('omits isMain for non-main groups', () => {
    _setRegisteredGroupForTests('group@g.us', {
      name: 'Family Chat',
      folder: 'discord_family-chat',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
    });

    const groups = getAllRoomBindings();
    const group = groups['group@g.us'];
    expect(group).toBeDefined();
    expect(group.isMain).toBeUndefined();
  });

  it('filters duplicate jid registrations by agent type', () => {
    _setRegisteredGroupForTests('dc:shared', {
      name: 'Shared Room',
      folder: 'shared-room',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      agentType: 'claude-code',
    });
    _setRegisteredGroupForTests('dc:shared', {
      name: 'Shared Room',
      folder: 'shared-room',
      trigger: '@Codex',
      added_at: '2024-01-01T00:00:00.000Z',
      agentType: 'codex',
    });

    const claudeGroups = getAllRoomBindings('claude-code');
    const codexGroups = getAllRoomBindings('codex');

    expect(claudeGroups['dc:shared']?.agentType).toBe('claude-code');
    expect(claudeGroups['dc:shared']?.name).toBe('Shared Room');
    expect(codexGroups['dc:shared']?.agentType).toBe('codex');
    expect(codexGroups['dc:shared']?.name).toBe('Shared Room');
  });
});

describe('paired room registration', () => {
  it('detects paired capability types from canonical tribunal room settings', () => {
    assignRoom('dc:123', {
      name: 'Paired Room',
      roomMode: 'tribunal',
      ownerAgentType: 'codex',
      folder: 'paired-room',
    });

    expect(getRegisteredAgentTypesForJid('dc:123').sort()).toEqual([
      'claude-code',
      'codex',
    ]);
    expect(getExplicitRoomMode('dc:123')).toBe('tribunal');
    expect(getEffectiveRoomMode('dc:123')).toBe('tribunal');
    expect(getEffectiveRuntimeRoomMode('dc:123')).toBe('tribunal');
  });

  it('does not mark canonical single rooms as paired', () => {
    assignRoom('dc:solo', {
      name: 'Solo Claude Room',
      roomMode: 'single',
      ownerAgentType: 'claude-code',
      folder: 'solo-claude',
    });

    expect(getRegisteredAgentTypesForJid('dc:solo')).toEqual(['claude-code']);
    expect(getEffectiveRuntimeRoomMode('dc:solo')).toBe('single');
  });

  it('keeps canonical inferred room mode available when no explicit override exists', () => {
    assignRoom('dc:canonical-inferred-paired', {
      name: 'Canonical Inferred Paired',
      roomMode: 'tribunal',
      ownerAgentType: 'codex',
      folder: 'canonical-inferred-paired',
    });

    clearExplicitRoomMode('dc:canonical-inferred-paired');

    expect(getExplicitRoomMode('dc:canonical-inferred-paired')).toBeUndefined();
    expect(getEffectiveRoomMode('dc:canonical-inferred-paired')).toBe(
      'tribunal',
    );
    expect(getEffectiveRuntimeRoomMode('dc:canonical-inferred-paired')).toBe(
      'tribunal',
    );
  });

  it('ignores legacy capability rows when canonical room settings are missing', () => {
    _setRegisteredGroupForTests('dc:legacy-paired', {
      name: 'Legacy Paired',
      folder: 'legacy-paired',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      agentType: 'claude-code',
    });
    _setRegisteredGroupForTests('dc:legacy-paired', {
      name: 'Legacy Paired',
      folder: 'legacy-paired',
      trigger: '@Codex',
      added_at: '2024-01-01T00:00:00.000Z',
      agentType: 'codex',
    });
    _deleteStoredRoomSettingsForTests('dc:legacy-paired');

    expect(getRegisteredAgentTypesForJid('dc:legacy-paired')).toEqual([]);
    expect(getExplicitRoomMode('dc:legacy-paired')).toBeUndefined();
    expect(getEffectiveRoomMode('dc:legacy-paired')).toBe('single');
    expect(getEffectiveRuntimeRoomMode('dc:legacy-paired')).toBe('single');
  });

  it('keeps room-level metadata synced on setRegisteredGroup helper writes', () => {
    _setRegisteredGroupForTests('dc:room-settings', {
      name: 'Room Settings Test',
      folder: 'room-settings-test',
      trigger: '@Claude',
      added_at: '2024-01-01T00:00:00.000Z',
      agentType: 'claude-code',
    });
    _setRegisteredGroupForTests('dc:room-settings', {
      name: 'Room Settings Test',
      folder: 'room-settings-test',
      trigger: '@Codex',
      added_at: '2024-01-01T00:00:00.000Z',
      agentType: 'codex',
    });

    expect(getStoredRoomSettings('dc:room-settings')).toMatchObject({
      chatJid: 'dc:room-settings',
      roomMode: 'tribunal',
      modeSource: 'inferred',
      name: 'Room Settings Test',
      folder: 'room-settings-test',
      trigger: '@Codex',
      ownerAgentType: 'codex',
    });

    setExplicitRoomMode('dc:room-settings', 'single');

    expect(getStoredRoomSettings('dc:room-settings')).toMatchObject({
      chatJid: 'dc:room-settings',
      roomMode: 'single',
      modeSource: 'explicit',
      name: 'Room Settings Test',
      folder: 'room-settings-test',
      trigger: '@Codex',
      ownerAgentType: 'codex',
    });

    updateRegisteredGroupName('dc:room-settings', 'Room Settings Renamed');

    expect(getStoredRoomSettings('dc:room-settings')).toMatchObject({
      chatJid: 'dc:room-settings',
      roomMode: 'single',
      modeSource: 'explicit',
      name: 'Room Settings Renamed',
      folder: 'room-settings-test',
      trigger: '@Codex',
      ownerAgentType: 'codex',
    });
  });

  it('lets explicit single override dual registration for paired-room checks', () => {
    _setRegisteredGroupForTests('dc:explicit-single', {
      name: 'Explicit Single',
      folder: 'explicit-single',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      agentType: 'claude-code',
    });
    _setRegisteredGroupForTests('dc:explicit-single', {
      name: 'Explicit Single',
      folder: 'explicit-single',
      trigger: '@Codex',
      added_at: '2024-01-01T00:00:00.000Z',
      agentType: 'codex',
    });

    setExplicitRoomMode('dc:explicit-single', 'single');

    expect(getExplicitRoomMode('dc:explicit-single')).toBe('single');
    expect(getEffectiveRoomMode('dc:explicit-single')).toBe('single');
    expect(getEffectiveRuntimeRoomMode('dc:explicit-single')).toBe('single');
  });

  it('restores inferred paired mode when clearing an explicit single override', () => {
    _setRegisteredGroupForTests('dc:explicit-single-clear', {
      name: 'Explicit Single Clear',
      folder: 'explicit-single-clear',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      agentType: 'claude-code',
    });
    _setRegisteredGroupForTests('dc:explicit-single-clear', {
      name: 'Explicit Single Clear',
      folder: 'explicit-single-clear',
      trigger: '@Codex',
      added_at: '2024-01-01T00:00:00.000Z',
      agentType: 'codex',
    });

    setExplicitRoomMode('dc:explicit-single-clear', 'single');

    expect(getExplicitRoomMode('dc:explicit-single-clear')).toBe('single');
    expect(getEffectiveRoomMode('dc:explicit-single-clear')).toBe('single');

    clearExplicitRoomMode('dc:explicit-single-clear');

    expect(getExplicitRoomMode('dc:explicit-single-clear')).toBeUndefined();
    expect(getEffectiveRoomMode('dc:explicit-single-clear')).toBe('tribunal');
    expect(getEffectiveRuntimeRoomMode('dc:explicit-single-clear')).toBe(
      'tribunal',
    );
  });

  it('lets explicit tribunal become runnable when the configured reviewer can run on the solo registration', () => {
    _setRegisteredGroupForTests('dc:explicit-tribunal', {
      name: 'Explicit Tribunal Claude',
      folder: 'explicit-tribunal-claude',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      agentType: 'claude-code',
    });

    expect(getEffectiveRoomMode('dc:explicit-tribunal')).toBe('single');

    setExplicitRoomMode('dc:explicit-tribunal', 'tribunal');

    expect(getExplicitRoomMode('dc:explicit-tribunal')).toBe('tribunal');
    expect(getEffectiveRoomMode('dc:explicit-tribunal')).toBe('tribunal');
    expect(getEffectiveRuntimeRoomMode('dc:explicit-tribunal')).toBe(
      'tribunal',
    );

    clearExplicitRoomMode('dc:explicit-tribunal');

    expect(getExplicitRoomMode('dc:explicit-tribunal')).toBeUndefined();
    expect(getEffectiveRoomMode('dc:explicit-tribunal')).toBe('single');
    expect(getEffectiveRuntimeRoomMode('dc:explicit-tribunal')).toBe('single');
  });

  it('trusts stored tribunal mode without projection rows', () => {
    assignRoom('dc:explicit-tribunal-codex', {
      name: 'Explicit Tribunal Codex',
      roomMode: 'single',
      ownerAgentType: 'codex',
      folder: 'explicit-tribunal-codex',
    });

    setExplicitRoomMode('dc:explicit-tribunal-codex', 'tribunal');

    expect(getEffectiveRoomMode('dc:explicit-tribunal-codex')).toBe('tribunal');
    expect(getEffectiveRuntimeRoomMode('dc:explicit-tribunal-codex')).toBe(
      'tribunal',
    );
  });
});
