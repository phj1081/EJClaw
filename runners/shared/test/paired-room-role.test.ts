import { describe, expect, it } from 'vitest';

import {
  PAIRED_ROOM_ROLES,
  isPairedRoomRole,
  normalizePairedRoomRole,
  normalizePairedRoomRoleOrNull,
} from '../src/paired-room-role.js';

describe('paired room role helpers', () => {
  it('defines the supported paired roles', () => {
    expect(PAIRED_ROOM_ROLES).toEqual(['owner', 'reviewer', 'arbiter']);
  });

  it('recognizes valid paired room roles', () => {
    expect(isPairedRoomRole('owner')).toBe(true);
    expect(isPairedRoomRole('reviewer')).toBe(true);
    expect(isPairedRoomRole('arbiter')).toBe(true);
  });

  it('normalizes unknown values consistently', () => {
    expect(normalizePairedRoomRole('main')).toBeUndefined();
    expect(normalizePairedRoomRole(null)).toBeUndefined();
    expect(normalizePairedRoomRoleOrNull('main')).toBeNull();
  });
});
