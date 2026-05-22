import { describe, expect, it } from 'vitest';

import { buildClaudeSdkEnv } from '../src/sdk-env.js';

describe('claude SDK env', () => {
  it('defaults MCP connections to blocking startup for first-turn tool availability', () => {
    expect(buildClaudeSdkEnv({}).MCP_CONNECTION_NONBLOCKING).toBe('0');
  });

  it('preserves explicit MCP connection mode and overlays secrets', () => {
    expect(
      buildClaudeSdkEnv(
        { MCP_CONNECTION_NONBLOCKING: '1', EXISTING: 'base' },
        { EXISTING: 'secret', TOKEN: 'value' },
      ),
    ).toMatchObject({
      MCP_CONNECTION_NONBLOCKING: '1',
      EXISTING: 'secret',
      TOKEN: 'value',
    });
  });
});
