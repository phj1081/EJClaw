import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

type PackageJson = {
  scripts?: Record<string, string>;
};

describe('deploy script', () => {
  it('refreshes root file dependencies after pulling before building', () => {
    const packageJson = JSON.parse(
      fs.readFileSync(
        path.resolve(import.meta.dirname, '../package.json'),
        'utf8',
      ),
    ) as PackageJson;

    const deploy = packageJson.scripts?.deploy ?? '';
    const pullIndex = deploy.indexOf('git pull --ff-only');
    const rootInstallIndex = deploy.indexOf('bun install --frozen-lockfile');
    const buildIndex = deploy.indexOf('bun run build:all');

    expect(pullIndex).toBeGreaterThanOrEqual(0);
    expect(rootInstallIndex).toBeGreaterThan(pullIndex);
    expect(rootInstallIndex).toBeLessThan(buildIndex);
  });
});
