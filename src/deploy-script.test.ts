import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

type PackageJson = {
  dependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  workspaces?: string[];
};

function readPackageJson(relativePath: string): PackageJson {
  return JSON.parse(
    fs.readFileSync(path.resolve(import.meta.dirname, relativePath), 'utf8'),
  ) as PackageJson;
}

describe('deploy script', () => {
  it('refreshes workspace dependencies after pulling before building', () => {
    const packageJson = readPackageJson('../package.json');

    const deploy = packageJson.scripts?.deploy ?? '';
    const pullIndex = deploy.indexOf('git pull --ff-only');
    const rootInstallIndex = deploy.indexOf('bun install --frozen-lockfile');
    const buildIndex = deploy.indexOf('bun run build:all');

    expect(pullIndex).toBeGreaterThanOrEqual(0);
    expect(rootInstallIndex).toBeGreaterThan(pullIndex);
    expect(rootInstallIndex).toBeLessThan(buildIndex);
    expect(
      deploy.indexOf('bun install --frozen-lockfile', rootInstallIndex + 1),
    ).toBe(-1);
  });

  it('uses workspace links for shared runner code instead of copied file dependencies', () => {
    const rootPackageJson = readPackageJson('../package.json');
    const agentRunnerPackageJson = readPackageJson(
      '../runners/agent-runner/package.json',
    );
    const codexRunnerPackageJson = readPackageJson(
      '../runners/codex-runner/package.json',
    );

    expect(rootPackageJson.workspaces).toEqual(
      expect.arrayContaining([
        'runners/shared',
        'runners/agent-runner',
        'runners/codex-runner',
      ]),
    );
    expect(rootPackageJson.dependencies?.['ejclaw-runners-shared']).toBe(
      'workspace:*',
    );
    expect(agentRunnerPackageJson.dependencies?.['ejclaw-runners-shared']).toBe(
      'workspace:*',
    );
    expect(codexRunnerPackageJson.dependencies?.['ejclaw-runners-shared']).toBe(
      'workspace:*',
    );
  });
});
