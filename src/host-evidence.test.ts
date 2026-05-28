import { describe, expect, it } from 'vitest';

import {
  buildRoleRuntimeConfigEvidence,
  buildHostEvidenceCommand,
  clampHostEvidenceTailLines,
  isHostEvidenceAction,
} from './host-evidence.js';

describe('host evidence helpers', () => {
  it('recognizes only allowlisted actions', () => {
    expect(isHostEvidenceAction('ejclaw_service_status')).toBe(true);
    expect(isHostEvidenceAction('ejclaw_service_logs')).toBe(true);
    expect(isHostEvidenceAction('ejclaw_role_runtime_config')).toBe(true);
    expect(isHostEvidenceAction('db_paired_task_status')).toBe(true);
    expect(isHostEvidenceAction('db_recent_scheduled_tasks')).toBe(true);
    expect(isHostEvidenceAction('db_scheduled_task_runs')).toBe(true);
    expect(isHostEvidenceAction('ejclaw_deploy_state')).toBe(true);
    expect(isHostEvidenceAction('github_pr_status')).toBe(true);
    expect(isHostEvidenceAction('github_run_jobs')).toBe(true);
    expect(isHostEvidenceAction('github_workflow_file')).toBe(true);
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

  it('returns role runtime config without secret-shaped fields', () => {
    const text = buildRoleRuntimeConfigEvidence();
    const parsed = JSON.parse(text) as {
      roles: {
        owner: { agent_type: string; effective_model: string };
        reviewer: { agent_type: string; effective_model: string };
        arbiter: { agent_type: string | null; effective_model: string | null };
      };
    };

    expect(parsed.roles.owner.agent_type).toMatch(/^(codex|claude-code)$/);
    expect(parsed.roles.reviewer.agent_type).toMatch(/^(codex|claude-code)$/);
    expect(text).not.toMatch(/api[_-]?key/i);
    expect(text).not.toMatch(/token/i);
    expect(text).not.toMatch(/secret/i);
    expect(text).not.toMatch(/password/i);
  });
});
