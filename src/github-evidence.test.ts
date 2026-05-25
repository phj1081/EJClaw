import { describe, expect, it } from 'vitest';

import {
  buildGitHubEvidenceCommand,
  normalizeGitHubRepo,
  normalizePositiveInteger,
} from './github-evidence.js';

describe('GitHub evidence helpers', () => {
  it('validates repo and numeric identifiers', () => {
    expect(normalizeGitHubRepo('owner/repo')).toBe('owner/repo');
    expect(() => normalizeGitHubRepo('../repo')).toThrow(
      'Unsupported GitHub repo',
    );
    expect(normalizePositiveInteger(12, 'pr_number')).toBe(12);
    expect(() => normalizePositiveInteger(0, 'pr_number')).toThrow(
      'Missing or invalid pr_number',
    );
  });

  it('builds fixed gh commands', () => {
    expect(
      buildGitHubEvidenceCommand({
        action: 'github_pr_status',
        repo: 'owner/repo',
        prNumber: 164,
      }).args,
    ).toEqual([
      'pr',
      'view',
      '164',
      '--repo',
      'owner/repo',
      '--json',
      'number,title,state,mergeStateStatus,headRefName,baseRefName,headRefOid,url,statusCheckRollup',
    ]);

    expect(
      buildGitHubEvidenceCommand({
        action: 'github_run_status',
        repo: 'owner/repo',
        runId: 123,
      }).args,
    ).toContain('123');
  });
});
