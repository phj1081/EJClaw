import { describe, expect, it } from 'vitest';

import {
  getFixedRoleChannelName,
  getMissingRoleChannelMessage,
  resolveHandoffCursorKey,
  resolveHandoffRoleOverride,
} from './message-runtime-shared.js';

describe('message-runtime-shared', () => {
  it('prefers explicit target role over inferred handoff metadata', () => {
    expect(
      resolveHandoffRoleOverride({
        target_role: 'arbiter',
        intended_role: 'reviewer',
        reason: 'reviewer-follow-up',
      }),
    ).toBe('arbiter');
  });

  it('falls back from intended role to reason prefix when needed', () => {
    expect(
      resolveHandoffRoleOverride({
        target_role: null,
        intended_role: 'reviewer',
        reason: 'arbiter-follow-up',
      }),
    ).toBe('reviewer');
    expect(
      resolveHandoffRoleOverride({
        target_role: null,
        intended_role: null,
        reason: 'arbiter-follow-up',
      }),
    ).toBe('arbiter');
  });

  it('builds owner and role-scoped cursor keys', () => {
    expect(resolveHandoffCursorKey('room-1')).toBe('room-1');
    expect(resolveHandoffCursorKey('room-1', 'owner')).toBe('room-1');
    expect(resolveHandoffCursorKey('room-1', 'reviewer')).toBe(
      'room-1:reviewer',
    );
  });

  it('returns fixed role channel names and user-facing missing-channel errors', () => {
    expect(getFixedRoleChannelName('reviewer')).toBe('discord-review');
    expect(getFixedRoleChannelName('arbiter')).toBe('discord-arbiter');
    expect(getMissingRoleChannelMessage('reviewer')).toContain(
      'discord-review',
    );
    expect(getMissingRoleChannelMessage('arbiter')).toContain(
      'discord-arbiter',
    );
  });
});
