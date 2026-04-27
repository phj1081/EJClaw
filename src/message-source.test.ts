import { describe, expect, it } from 'vitest';

import {
  isBotMessageSourceKind,
  normalizeMessageSourceKind,
  resolveInjectedMessageSourceKind,
} from './message-source.js';

describe('message source helpers', () => {
  it('defaults IPC injected messages to trusted human-equivalent provenance', () => {
    expect(resolveInjectedMessageSourceKind({ treatAsHuman: true })).toBe(
      'trusted_external_bot',
    );
    expect(
      isBotMessageSourceKind(
        resolveInjectedMessageSourceKind({ treatAsHuman: true }),
      ),
    ).toBe(false);
  });

  it('defaults non-human IPC injected messages to bot-equivalent provenance', () => {
    expect(resolveInjectedMessageSourceKind({ treatAsHuman: false })).toBe(
      'ipc_injected_bot',
    );
    expect(
      isBotMessageSourceKind(
        resolveInjectedMessageSourceKind({ treatAsHuman: false }),
      ),
    ).toBe(true);
  });

  it('honors valid explicit source kinds and normalizes invalid values', () => {
    expect(
      resolveInjectedMessageSourceKind({
        treatAsHuman: true,
        sourceKind: 'ipc_injected_human',
      }),
    ).toBe('ipc_injected_human');

    expect(normalizeMessageSourceKind('bot', 'human')).toBe('bot');
    expect(normalizeMessageSourceKind('not-real', 'human')).toBe('human');
  });
});
