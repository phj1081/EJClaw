import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

type PackageJson = {
  scripts?: Record<string, string>;
};

describe('deploy script', () => {
  it('refreshes root file dependencies after pulling and after building shared dist', () => {
    const packageJson = JSON.parse(
      fs.readFileSync(
        path.resolve(import.meta.dirname, '../package.json'),
        'utf8',
      ),
    ) as PackageJson;

    const deploy = packageJson.scripts?.deploy ?? '';
    const pullIndex = deploy.indexOf('git pull --ff-only');
    const firstRootInstallIndex = deploy.indexOf(
      'bun install --frozen-lockfile',
    );
    const buildIndex = deploy.indexOf('bun run build:all');
    const secondRootInstallIndex = deploy.indexOf(
      'bun install --frozen-lockfile',
      firstRootInstallIndex + 1,
    );
    const verifyIndex = deploy.indexOf('bun run verify:dist');

    expect(pullIndex).toBeGreaterThanOrEqual(0);
    expect(firstRootInstallIndex).toBeGreaterThan(pullIndex);
    expect(firstRootInstallIndex).toBeLessThan(buildIndex);
    expect(secondRootInstallIndex).toBeGreaterThan(buildIndex);
    expect(secondRootInstallIndex).toBeLessThan(verifyIndex);
  });
});
