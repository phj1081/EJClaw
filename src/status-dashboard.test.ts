import fs from 'fs';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { CACHE_DIR } from './config.js';
import {
  readDashboardStatusMessageId,
  writeDashboardStatusMessageId,
} from './status-dashboard.js';

afterEach(() => {
  const messagesDir = path.join(CACHE_DIR, 'status-dashboard', 'messages');
  fs.rmSync(path.join(messagesDir, 'test-status-channel.json'), {
    force: true,
  });
});

describe('dashboard status message id state', () => {
  it('persists the tracked Discord status message id across restarts', async () => {
    expect(readDashboardStatusMessageId('test-status-channel')).toBeNull();

    writeDashboardStatusMessageId('test-status-channel', '1499810000000000000');

    expect(readDashboardStatusMessageId('test-status-channel')).toBe(
      '1499810000000000000',
    );
    expect(readDashboardStatusMessageId('other-channel')).toBeNull();
  });
});
