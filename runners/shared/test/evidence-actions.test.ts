import { describe, expect, it } from 'vitest';

import {
  ARTIFACT_EVIDENCE_KINDS,
  DB_EVIDENCE_ACTIONS,
  DEPLOY_EVIDENCE_ACTIONS,
  GITHUB_EVIDENCE_ACTIONS,
  HOST_EVIDENCE_ACTIONS,
  isArtifactEvidenceKind,
  isDbEvidenceAction,
  isDeployEvidenceAction,
  isGitHubEvidenceAction,
  isHostEvidenceAction,
} from '../src/evidence-actions.js';

describe('evidence action constants', () => {
  it('keeps host evidence actions as the composed allowlist', () => {
    expect(HOST_EVIDENCE_ACTIONS).toEqual([
      'ejclaw_service_status',
      'ejclaw_service_logs',
      'ejclaw_role_runtime_config',
      ...DEPLOY_EVIDENCE_ACTIONS,
      ...DB_EVIDENCE_ACTIONS,
      ...GITHUB_EVIDENCE_ACTIONS,
    ]);
  });

  it('recognizes scoped evidence actions', () => {
    expect(isHostEvidenceAction('github_run_jobs')).toBe(true);
    expect(isDbEvidenceAction('db_recent_scheduled_tasks')).toBe(true);
    expect(isDeployEvidenceAction('ejclaw_artifact_metadata')).toBe(true);
    expect(isGitHubEvidenceAction('github_workflow_file')).toBe(true);
    expect(isHostEvidenceAction('cat /etc/shadow')).toBe(false);
  });

  it('recognizes artifact evidence kinds', () => {
    expect(ARTIFACT_EVIDENCE_KINDS).toContain('runner_dist');
    expect(isArtifactEvidenceKind('runner_dist')).toBe(true);
    expect(isArtifactEvidenceKind('../secret')).toBe(false);
  });
});
