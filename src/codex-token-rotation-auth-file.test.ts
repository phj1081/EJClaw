import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  readCodexAccessToken,
  readCodexAuthTokens,
} from './codex-token-rotation-auth-file.js';

describe('readCodexAuthTokens', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-auth-file-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const write = (data: unknown): string => {
    const file = path.join(dir, 'auth.json');
    fs.writeFileSync(file, JSON.stringify(data));
    return file;
  };

  it('returns access token and account id when both exist', () => {
    const file = write({
      tokens: { access_token: 'tok-abc', account_id: 'acct-123' },
    });
    expect(readCodexAuthTokens(file)).toEqual({
      accessToken: 'tok-abc',
      accountId: 'acct-123',
    });
  });

  it('returns null accountId when account_id is missing or blank', () => {
    const file = write({ tokens: { access_token: 'tok-abc' } });
    expect(readCodexAuthTokens(file)).toEqual({
      accessToken: 'tok-abc',
      accountId: null,
    });

    const blank = write({
      tokens: { access_token: 'tok-abc', account_id: '  ' },
    });
    expect(readCodexAuthTokens(blank)?.accountId).toBeNull();
  });

  it('returns null when access token is missing, blank, or file is invalid', () => {
    expect(readCodexAuthTokens(write({ tokens: {} }))).toBeNull();
    expect(
      readCodexAuthTokens(write({ tokens: { access_token: '' } })),
    ).toBeNull();
    expect(readCodexAuthTokens(path.join(dir, 'nope.json'))).toBeNull();
    const garbled = path.join(dir, 'auth.json');
    fs.writeFileSync(garbled, 'not-json');
    expect(readCodexAuthTokens(garbled)).toBeNull();
  });

  it('keeps readCodexAccessToken behavior as a thin wrapper', () => {
    const file = write({
      tokens: { access_token: 'tok-abc', account_id: 'acct-123' },
    });
    expect(readCodexAccessToken(file)).toBe('tok-abc');
    expect(readCodexAccessToken(path.join(dir, 'nope.json'))).toBeNull();
  });
});
