import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { getMoaSettings, updateMoaSettings } from './settings-store-moa.js';

const originalCwd = process.cwd();
let tempDir: string | null = null;

function writeTempEnv(content: string): string {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ejclaw-moa-settings-'));
  fs.writeFileSync(path.join(tempDir, '.env'), content, { mode: 0o600 });
  process.chdir(tempDir);
  return path.join(tempDir, '.env');
}

afterEach(() => {
  process.chdir(originalCwd);
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe('MoA settings store', () => {
  it('reads MoA config without exposing API keys', () => {
    writeTempEnv(
      [
        'MOA_ENABLED=true',
        'MOA_REF_MODELS=kimi,glm',
        'MOA_KIMI_MODEL=kimi-k2.6',
        'MOA_KIMI_BASE_URL=https://api.kimi.com/coding',
        'MOA_KIMI_API_FORMAT=anthropic',
        'MOA_KIMI_API_KEY=sk-kimi-secret',
        'MOA_GLM_MODEL=glm-5.1',
        'MOA_GLM_BASE_URL=https://open.bigmodel.cn/api/anthropic',
        'MOA_GLM_API_FORMAT=anthropic',
        'MOA_GLM_API_KEY=glm-secret',
        '',
      ].join('\n'),
    );

    expect(getMoaSettings()).toMatchObject({
      enabled: true,
      referenceModels: ['kimi', 'glm'],
      models: [
        {
          name: 'kimi',
          enabled: true,
          model: 'kimi-k2.6',
          apiFormat: 'anthropic',
          apiKeyConfigured: true,
        },
        {
          name: 'glm',
          enabled: true,
          model: 'glm-5.1',
          apiFormat: 'anthropic',
          apiKeyConfigured: true,
        },
      ],
    });
    expect(JSON.stringify(getMoaSettings())).not.toContain('sk-kimi-secret');
  });

  it('updates the master toggle, active models, and replacement API keys', () => {
    const envFile = writeTempEnv(
      [
        'MOA_ENABLED=true',
        'MOA_REF_MODELS=kimi,glm',
        'MOA_KIMI_MODEL=kimi-k2.6',
        'MOA_KIMI_BASE_URL=https://api.kimi.com/coding',
        'MOA_KIMI_API_FORMAT=anthropic',
        'MOA_KIMI_API_KEY=old-secret',
        'MOA_GLM_MODEL=glm-5.1',
        'MOA_GLM_BASE_URL=https://open.bigmodel.cn/api/anthropic',
        'MOA_GLM_API_FORMAT=anthropic',
        'MOA_GLM_API_KEY=glm-secret',
        '',
      ].join('\n'),
    );

    const updated = updateMoaSettings({
      enabled: false,
      models: [
        {
          name: 'kimi',
          enabled: false,
          model: 'kimi-k2.7',
          baseUrl: 'https://api.kimi.com/coding',
          apiFormat: 'anthropic',
          apiKey: 'new-secret',
        },
        { name: 'glm', enabled: true },
      ],
    });

    expect(updated.enabled).toBe(false);
    expect(updated.referenceModels).toEqual(['glm']);
    const content = fs.readFileSync(envFile, 'utf-8');
    expect(content).toContain('MOA_ENABLED=false');
    expect(content).toContain('MOA_REF_MODELS=glm');
    expect(content).toContain('MOA_KIMI_MODEL=kimi-k2.7');
    expect(content).toContain('MOA_KIMI_API_KEY=new-secret');
  });
});
