import { vi } from 'vitest';

import type { RegisteredGroup } from '../../src/types.js';

export function makeGroup(): RegisteredGroup {
  return {
    name: 'Test Group',
    folder: 'test-claude',
    trigger: '@Andy',
    added_at: new Date().toISOString(),
    requiresTrigger: false,
    agentType: 'claude-code',
  };
}

export function makeDeps() {
  return {
    assistantName: 'Andy',
    queue: {
      registerProcess: vi.fn(),
      enqueueMessageCheck: vi.fn(),
    },
    getRoomBindings: () => ({}),
    getSessions: () => ({}),
    persistSession: vi.fn(),
    clearSession: vi.fn(),
  };
}
