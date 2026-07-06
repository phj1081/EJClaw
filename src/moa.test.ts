import { describe, expect, it } from 'vitest';

import { assertSafeMoaBaseUrl } from './moa.js';

describe('assertSafeMoaBaseUrl', () => {
  it('accepts public https endpoints', () => {
    expect(() =>
      assertSafeMoaBaseUrl('https://api.moonshot.cn/v1'),
    ).not.toThrow();
    expect(() =>
      assertSafeMoaBaseUrl('https://open.bigmodel.cn/api/paas/v4'),
    ).not.toThrow();
  });

  it('rejects non-http(s) schemes', () => {
    expect(() => assertSafeMoaBaseUrl('file:///etc/passwd')).toThrow(
      /http\(s\)/,
    );
  });

  it('rejects loopback and localhost', () => {
    expect(() => assertSafeMoaBaseUrl('http://127.0.0.1:8080')).toThrow(
      /not allowed/,
    );
    expect(() => assertSafeMoaBaseUrl('http://localhost/v1')).toThrow(
      /not allowed/,
    );
  });

  it('rejects cloud metadata and private ranges', () => {
    expect(() => assertSafeMoaBaseUrl('http://169.254.169.254/latest')).toThrow(
      /not allowed/,
    );
    expect(() => assertSafeMoaBaseUrl('http://10.0.0.5/v1')).toThrow(
      /not allowed/,
    );
    expect(() => assertSafeMoaBaseUrl('http://192.168.1.1/v1')).toThrow(
      /not allowed/,
    );
    expect(() => assertSafeMoaBaseUrl('http://100.101.210.95/v1')).toThrow(
      /not allowed/,
    );
  });

  it('rejects malformed URLs', () => {
    expect(() => assertSafeMoaBaseUrl('not-a-url')).toThrow(/Invalid/);
  });
});
