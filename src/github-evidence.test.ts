import { describe, expect, it } from 'vitest';

import {
  buildGitHubEvidenceCommand,
  decodeGitHubContentBase64,
  normalizeGitHubRef,
  normalizeGitHubRepo,
  normalizeGitHubWorkflowPath,
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

  it('validates workflow evidence paths and refs', () => {
    expect(
      normalizeGitHubWorkflowPath('.github/workflows/display-analyzer.yml'),
    ).toBe('.github/workflows/display-analyzer.yml');
    expect(normalizeGitHubWorkflowPath('.github/workflows/ci.yaml')).toBe(
      '.github/workflows/ci.yaml',
    );
    expect(() => normalizeGitHubWorkflowPath('README.md')).toThrow(
      'Unsupported GitHub workflow path',
    );
    expect(() =>
      normalizeGitHubWorkflowPath('.github/workflows/../ci.yml'),
    ).toThrow('Unsupported GitHub workflow path');

    expect(normalizeGitHubRef('prod')).toBe('prod');
    expect(normalizeGitHubRef('feature/display-analyzer')).toBe(
      'feature/display-analyzer',
    );
    expect(normalizeGitHubRef('00b971972e4b2e7ecf0c6d789f405fef7edeb258')).toBe(
      '00b971972e4b2e7ecf0c6d789f405fef7edeb258',
    );
    expect(() => normalizeGitHubRef('../prod')).toThrow(
      'Missing or invalid ref',
    );
    expect(() => normalizeGitHubRef('feature branch')).toThrow(
      'Missing or invalid ref',
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

    expect(
      buildGitHubEvidenceCommand({
        action: 'github_run_jobs',
        repo: 'owner/repo',
        runId: 123,
      }).args,
    ).toEqual([
      'run',
      'view',
      '123',
      '--repo',
      'owner/repo',
      '--json',
      'databaseId,name,status,conclusion,url,headBranch,headSha,jobs',
    ]);

    expect(
      buildGitHubEvidenceCommand({
        action: 'github_workflow_file',
        repo: 'owner/repo',
        workflowPath: '.github/workflows/display-analyzer-check.yml',
        ref: 'feature/display-analyzer',
      }),
    ).toMatchObject({
      args: [
        'api',
        'repos/owner/repo/contents/.github/workflows/display-analyzer-check.yml?ref=feature%2Fdisplay-analyzer',
        '--jq',
        '.content',
      ],
      decodeBase64Stdout: true,
    });
  });

  it('decodes GitHub contents API workflow bodies', () => {
    expect(decodeGitHubContentBase64('bmFtZTogQ0kK')).toBe('name: CI\n');
  });
});
