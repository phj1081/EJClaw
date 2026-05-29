import { describe, expect, it } from 'vitest';

import {
  normalizeAgentOutputPhase,
  normalizePairedRoomRole,
  normalizePairedRoomRoleOrNull,
  toVisiblePhase,
} from './types.js';

describe('phase helpers', () => {
  it('maps agent output phases to visible phases', () => {
    expect(toVisiblePhase('intermediate')).toBe('silent');
    expect(toVisiblePhase('tool-activity')).toBe('silent');
    expect(toVisiblePhase('progress')).toBe('progress');
    expect(toVisiblePhase('final')).toBe('final');
  });

  it('normalizes missing agent output phases to final', () => {
    expect(normalizeAgentOutputPhase(undefined)).toBe('final');
    expect(normalizeAgentOutputPhase('progress')).toBe('progress');
  });
});

describe('paired room role helpers', () => {
  it('normalizes valid paired room roles', () => {
    expect(normalizePairedRoomRole('owner')).toBe('owner');
    expect(normalizePairedRoomRole('reviewer')).toBe('reviewer');
    expect(normalizePairedRoomRole('arbiter')).toBe('arbiter');
  });

  it('rejects invalid paired room roles', () => {
    expect(normalizePairedRoomRole('single')).toBeUndefined();
    expect(normalizePairedRoomRole(undefined)).toBeUndefined();
    expect(normalizePairedRoomRoleOrNull('codex')).toBeNull();
  });
});
