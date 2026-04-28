import { describe, expect, it } from 'vitest';

import { redactSecretsForMarkdown, redactSecretsForPreview } from './redaction';

describe('dashboard redaction', () => {
  it('redacts named secret assignments for markdown output', () => {
    expect(redactSecretsForMarkdown('OPENAI_API_KEY=sk-testvalue1234')).toBe(
      'OPENAI_API_KEY=***',
    );
  });

  it('redacts named secret assignments for compact previews', () => {
    expect(redactSecretsForPreview('BOT_TOKEN=xoxb-testvalue1234')).toBe(
      'BOT_TOKEN=<redacted>',
    );
  });

  it('redacts standalone secret values consistently', () => {
    const raw = 'token sk-1234567890abcdef and ghp_1234567890abcdef';

    expect(redactSecretsForMarkdown(raw)).toBe('token *** and ***');
    expect(redactSecretsForPreview(raw)).toBe(
      'token <redacted-token> and <redacted-token>',
    );
  });
});
