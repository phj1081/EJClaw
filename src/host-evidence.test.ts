import { describe, expect, it } from 'vitest';

import {
  buildHostEvidenceCommand,
  clampHostEvidenceTailLines,
  isHostEvidenceAction,
} from './host-evidence.js';

describe('host evidence helpers', () => {
  it('recognizes only allowlisted actions', () => {
    expect(isHostEvidenceAction('ejclaw_service_status')).toBe(true);
    expect(isHostEvidenceAction('ejclaw_service_logs')).toBe(true);
    expect(isHostEvidenceAction('rm -rf /')).toBe(false);
  });

  it('clamps journal tail lines to a safe range', () => {
    expect(clampHostEvidenceTailLines(undefined)).toBe(20);
    expect(clampHostEvidenceTailLines(0)).toBe(1);
    expect(clampHostEvidenceTailLines(500)).toBe(200);
    expect(clampHostEvidenceTailLines(15)).toBe(15);
  });

  it('builds deterministic commands for each allowlisted action', () => {
    const status = buildHostEvidenceCommand({
      requestId: 'req-1',
      action: 'ejclaw_service_status',
    });
    expect(status.file).toBe('systemctl');
    expect(status.args).toContain('show');
    expect(status.args).toContain('ActiveState');

    const logs = buildHostEvidenceCommand({
      requestId: 'req-2',
      action: 'ejclaw_service_logs',
      tailLines: 42,
    });
    expect(logs.file).toBe('journalctl');
    expect(logs.args).toEqual(
      expect.arrayContaining(['--user', '-u', 'ejclaw', '-n', '42']),
    );
  });
});
