import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  assignRoom: vi.fn(),
  deleteAllSessionsForGroup: vi.fn(),
  deleteSession: vi.fn(),
  getAllRoomBindings: vi.fn(() => ({})),
  getAllSessions: vi.fn(() => ({})),
  getRouterState: vi.fn(() => ''),
  setRouterState: vi.fn(),
  setSession: vi.fn(),
}));

vi.mock('./db.js', () => db);

import { createRuntimeState } from './runtime-state.js';

describe('createRuntimeState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('clears role-scoped sessions from memory when allRoles is requested', () => {
    const state = createRuntimeState();

    state.persistSession('group-a', 'owner-session');
    state.persistSession('group-a:reviewer', 'reviewer-session');
    state.persistSession('group-a:arbiter', 'arbiter-session');
    state.persistSession('group-b', 'other-session');

    state.clearSession('group-a', { allRoles: true });

    expect(state.getSessions()).toEqual({ 'group-b': 'other-session' });
    expect(db.deleteAllSessionsForGroup).toHaveBeenCalledWith('group-a');
    expect(db.deleteSession).not.toHaveBeenCalled();
  });
});
