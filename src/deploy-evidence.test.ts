import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import {
  collectArtifactMetadata,
  normalizeArtifactEvidenceKind,
} from './deploy-evidence.js';

describe('deploy evidence helpers', () => {
  it('normalizes fixed artifact kinds', () => {
    expect(normalizeArtifactEvidenceKind()).toBe('build_outputs');
    expect(normalizeArtifactEvidenceKind('dashboard_dist')).toBe(
      'dashboard_dist',
    );
    expect(() => normalizeArtifactEvidenceKind('/etc/passwd')).toThrow(
      'Unsupported artifact evidence kind',
    );
  });

  it('returns metadata only for build artifacts', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ejclaw-deploy-'));
    const dashboardDir = path.join(root, 'apps', 'dashboard', 'dist');
    fs.mkdirSync(path.join(dashboardDir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(dashboardDir, 'index.html'), '<html></html>');
    fs.writeFileSync(path.join(dashboardDir, 'assets', 'index.js'), 'secret');

    const text = collectArtifactMetadata(
      {
        projectRoot: root,
        dataDir: path.join(root, 'data'),
        dashboardStaticDir: dashboardDir,
      },
      { action: 'ejclaw_artifact_metadata', artifactKind: 'dashboard_dist' },
    );

    expect(text).toContain('"file_count"');
    expect(text).toContain('"total_bytes"');
    expect(text).toContain('index.js');
    expect(text).not.toContain('"secret"');
    fs.rmSync(root, { recursive: true, force: true });
  });
});
