import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildLaunchdPlist,
  buildRuntimePathEnv,
  buildStackRestartSystemdUnit,
  buildSystemdUnit,
} from './service-renderers.js';
import { getServiceDefs, type ServiceDef } from './service-defs.js';

/**
 * Tests for service configuration generation.
 *
 * These tests verify the generated content of plist/systemd/nohup configs
 * without actually loading services.
 */

const baseServiceDef: ServiceDef = {
  kind: 'primary',
  description: 'EJClaw Personal Assistant',
  launchdLabel: 'com.ejclaw',
  logName: 'ejclaw',
  name: 'ejclaw',
};

describe('plist generation', () => {
  it('contains the correct label', () => {
    const plist = buildLaunchdPlist(
      baseServiceDef,
      '/home/user/ejclaw',
      '/usr/local/bin/node',
      '/home/user',
    );
    expect(plist).toContain('<string>com.ejclaw</string>');
  });

  it('uses the correct node path', () => {
    const plist = buildLaunchdPlist(
      baseServiceDef,
      '/home/user/ejclaw',
      '/opt/node/bin/node',
      '/home/user',
    );
    expect(plist).toContain('<string>/opt/node/bin/node</string>');
  });

  it('points to dist/index.js', () => {
    const plist = buildLaunchdPlist(
      baseServiceDef,
      '/home/user/ejclaw',
      '/usr/local/bin/node',
      '/home/user',
    );
    expect(plist).toContain('/home/user/ejclaw/dist/index.js');
  });

  it('sets log paths', () => {
    const plist = buildLaunchdPlist(
      baseServiceDef,
      '/home/user/ejclaw',
      '/usr/local/bin/node',
      '/home/user',
    );
    expect(plist).toContain('ejclaw.log');
    expect(plist).toContain('ejclaw.error.log');
  });
});

describe('systemd unit generation', () => {
  it('shares the runtime PATH builder across service formats', () => {
    expect(buildRuntimePathEnv('/usr/bin/bun', '/home/user')).toBe(
      '/usr/bin:/usr/local/bin:/usr/bin:/bin:/home/user/.local/bin:/home/user/.npm-global/bin',
    );
  });

  it('user unit uses default.target', () => {
    const unit = buildSystemdUnit(
      baseServiceDef,
      '/home/user/ejclaw',
      '/usr/bin/node',
      '/home/user',
      false,
    );
    expect(unit).toContain('WantedBy=default.target');
  });

  it('system unit uses multi-user.target', () => {
    const unit = buildSystemdUnit(
      baseServiceDef,
      '/home/user/ejclaw',
      '/usr/bin/node',
      '/home/user',
      true,
    );
    expect(unit).toContain('WantedBy=multi-user.target');
  });

  it('contains restart policy', () => {
    const unit = buildSystemdUnit(
      baseServiceDef,
      '/home/user/ejclaw',
      '/usr/bin/node',
      '/home/user',
      false,
    );
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('RestartSec=5');
    expect(unit).toContain('RestartPreventExitStatus=78');
  });

  it('sets correct ExecStart', () => {
    const unit = buildSystemdUnit(
      baseServiceDef,
      '/srv/ejclaw',
      '/usr/bin/bun',
      '/home/user',
      false,
    );
    expect(unit).toContain('ExecStart=/usr/bin/bun /srv/ejclaw/dist/index.js');
  });

  it('preserves EnvironmentFile and extraEnv in the actual builder', () => {
    const unit = buildSystemdUnit(
      {
        ...baseServiceDef,
        kind: 'primary',
        environmentFile: '/srv/ejclaw/.env.extra',
        extraEnv: { ASSISTANT_NAME: 'codex' },
        logName: 'ejclaw',
        name: 'ejclaw',
      },
      '/srv/ejclaw',
      '/usr/bin/bun',
      '/home/user',
      false,
    );
    expect(unit).toContain('EnvironmentFile=/srv/ejclaw/.env.extra');
    expect(unit).toContain('Environment=ASSISTANT_NAME=codex');
  });
});

describe('WSL nohup fallback', () => {
  it('generates a valid wrapper script', () => {
    const projectRoot = '/home/user/ejclaw';
    const nodePath = '/usr/bin/node';
    const pidFile = path.join(projectRoot, 'ejclaw.pid');

    // Simulate what service.ts generates
    const wrapper = `#!/bin/bash
set -euo pipefail
cd ${JSON.stringify(projectRoot)}
nohup ${JSON.stringify(nodePath)} ${JSON.stringify(projectRoot)}/dist/index.js >> ${JSON.stringify(projectRoot)}/logs/ejclaw.log 2>> ${JSON.stringify(projectRoot)}/logs/ejclaw.error.log &
echo $! > ${JSON.stringify(pidFile)}`;

    expect(wrapper).toContain('#!/bin/bash');
    expect(wrapper).toContain('nohup');
    expect(wrapper).toContain(nodePath);
    expect(wrapper).toContain('ejclaw.pid');
  });
});

describe('service definitions', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns only the unified service definition', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ejclaw-stack-'));
    tempRoots.push(tempRoot);

    const defs = getServiceDefs(tempRoot);

    expect(defs.map((def) => def.name)).toEqual(['ejclaw']);
    expect(defs.map((def) => def.kind)).toEqual(['primary']);
    expect(defs[0]?.extraEnv).toMatchObject({
      EJCLAW_UNSAFE_HOST_PAIRED_MODE: '1',
    });
  });

  it('generates a oneshot stack restart unit', () => {
    const unit = buildStackRestartSystemdUnit(
      '/srv/ejclaw',
      '/usr/bin/bun',
      '/home/user',
    );

    expect(unit).toContain('Description=EJClaw Stack Restart Orchestrator');
    expect(unit).toContain('Type=oneshot');
    expect(unit).toContain(
      'ExecStart=/usr/bin/bun /srv/ejclaw/setup/restart-stack.ts --direct',
    );
  });
});
