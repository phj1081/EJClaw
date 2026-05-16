import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  deleteAllSessionsForGroup,
  getSession,
  setSession,
} from './db.js';

describe('session accessors', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('deletes owner, reviewer, and arbiter role-scoped sessions for a group', () => {
    setSession('group-a', 'owner-session');
    setSession('group-a:reviewer', 'reviewer-session');
    setSession('group-a:arbiter', 'arbiter-session');
    setSession('group-b', 'other-session');

    deleteAllSessionsForGroup('group-a');

    expect(getSession('group-a')).toBeUndefined();
    expect(getSession('group-a:reviewer')).toBeUndefined();
    expect(getSession('group-a:arbiter')).toBeUndefined();
    expect(getSession('group-b')).toBe('other-session');
  });
});
