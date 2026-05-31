import { beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase, assignRoom, getStoredRoomSettings } from './db.js';

describe('room assignment metadata', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('preserves explicit trigger metadata when assigning a room', () => {
    const group = assignRoom('dc:triggered-room', {
      name: 'Triggered Room',
      roomMode: 'single',
      ownerAgentType: 'codex',
      folder: 'triggered-room',
      trigger: '@Repro',
      requiresTrigger: true,
    });

    expect(group).toMatchObject({
      trigger: '@Repro',
      requiresTrigger: true,
    });
    expect(getStoredRoomSettings('dc:triggered-room')).toMatchObject({
      trigger: '@Repro',
      requiresTrigger: true,
    });
  });
});
