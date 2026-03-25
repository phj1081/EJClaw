import { afterEach, describe, expect, it, vi } from 'vitest';

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
}));

vi.mock('child_process', () => ({
  execFile: execFileMock,
}));

import {
  checkGitHubActionsRun,
  parseGitHubCiMetadata,
  serializeGitHubCiMetadata,
} from './github-ci.js';

describe('github-ci helpers', () => {
  afterEach(() => {
    execFileMock.mockReset();
  });

  it('round-trips GitHub CI metadata', () => {
    const raw = serializeGitHubCiMetadata({
      repo: 'owner/repo',
      run_id: 123456,
      poll_count: 1,
    });

    expect(parseGitHubCiMetadata(raw)).toEqual({
      repo: 'owner/repo',
      run_id: 123456,
      poll_count: 1,
      consecutive_errors: undefined,
    });
    expect(parseGitHubCiMetadata('{"repo":"","run_id":0}')).toBeNull();
  });

  it('returns non-terminal status for in-progress runs', async () => {
    execFileMock.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        cb(
          null,
          JSON.stringify({
            status: 'in_progress',
            conclusion: null,
          }),
          '',
        );
      },
    );

    await expect(
      checkGitHubActionsRun({
        prompt: `
[BACKGROUND CI WATCH]

Watch target:
GitHub Actions run 123456

Task ID:
task-github

Check instructions:
Managed by host-driven watcher.
        `.trim(),
        ci_metadata: JSON.stringify({
          repo: 'owner/repo',
          run_id: 123456,
        }),
      }),
    ).resolves.toEqual({
      terminal: false,
      resultSummary: 'GitHub Actions run 123456 is in_progress',
    });
  });

  it('renders a concise completion message for terminal runs', async () => {
    execFileMock
      .mockImplementationOnce(
        (
          _cmd: string,
          _args: string[],
          _opts: unknown,
          cb: (error: Error | null, stdout: string, stderr: string) => void,
        ) => {
          cb(
            null,
            JSON.stringify({
              status: 'completed',
              conclusion: 'failure',
              name: 'CI',
              html_url: 'https://github.com/owner/repo/actions/runs/654321',
              head_branch: 'main',
            }),
            '',
          );
        },
      )
      .mockImplementationOnce(
        (
          _cmd: string,
          _args: string[],
          _opts: unknown,
          cb: (error: Error | null, stdout: string, stderr: string) => void,
        ) => {
          cb(
            null,
            JSON.stringify({
              jobs: [
                { name: 'build', conclusion: 'success' },
                { name: 'test', conclusion: 'failure' },
              ],
            }),
            '',
          );
        },
      );

    const result = await checkGitHubActionsRun({
      prompt: `
[BACKGROUND CI WATCH]

Watch target:
GitHub Actions run 654321

Task ID:
task-github

Check instructions:
Managed by host-driven watcher.
      `.trim(),
      ci_metadata: JSON.stringify({
        repo: 'owner/repo',
        run_id: 654321,
      }),
    });

    expect(result.terminal).toBe(true);
    expect(result.resultSummary).toContain('실패');
    expect(result.completionMessage).toContain('CI 완료: GitHub Actions run 654321');
    expect(result.completionMessage).toContain('판정: 실패');
    expect(result.completionMessage).toContain('- 실패 job: test');
  });
});
