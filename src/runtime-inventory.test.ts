import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getRuntimeInventory } from './runtime-inventory.js';

describe('runtime inventory', () => {
  let tempDir: string;
  let homeDir: string;
  let projectRoot: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ejclaw-runtime-inv-'));
    homeDir = path.join(tempDir, 'home');
    projectRoot = path.join(tempDir, 'repo');
    fs.mkdirSync(homeDir, { recursive: true });
    fs.mkdirSync(projectRoot, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('summarizes safe Codex and Claude runtime metadata without reading secrets', () => {
    const codexDir = path.join(homeDir, '.codex');
    const claudeDir = path.join(homeDir, '.claude');
    fs.mkdirSync(codexDir, { recursive: true });
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(codexDir, 'config.toml'),
      '[mcp_servers.ejclaw]\ncommand = "node"\n[mcp_servers.other]\ncommand = "x"\n',
    );
    fs.writeFileSync(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify({
        fastMode: true,
        secret: 'should-not-leak',
        mcpServers: {
          ejclaw: {
            command: 'node',
            args: ['secret-arg-should-not-leak'],
          },
          filesystem: {
            command: 'node',
          },
        },
      }),
    );
    fs.writeFileSync(
      path.join(codexDir, 'auth.json'),
      '{"OPENAI_API_KEY":"sk-secret"}\n',
    );

    const codexSkill = path.join(homeDir, '.agents', 'skills', 'browser');
    fs.mkdirSync(codexSkill, { recursive: true });
    fs.writeFileSync(
      path.join(codexSkill, 'SKILL.md'),
      '---\nname: browser\ndescription: Browser automation\n---\n# Body\n',
    );

    const runnerSkill = path.join(projectRoot, 'runners', 'skills', 'runner');
    fs.mkdirSync(runnerSkill, { recursive: true });
    fs.writeFileSync(
      path.join(runnerSkill, 'SKILL.md'),
      '---\nname: runner\ndescription: Runner skill\n---\n',
    );
    const mcpServerPath = path.join(
      projectRoot,
      'runners',
      'agent-runner',
      'dist',
      'ipc-mcp-stdio.js',
    );
    fs.mkdirSync(path.dirname(mcpServerPath), { recursive: true });
    fs.writeFileSync(mcpServerPath, 'console.log("mcp");\n');

    const snapshot = getRuntimeInventory({
      generatedAt: '2026-05-04T00:00:00.000Z',
      homeDir,
      projectRoot,
    });

    expect(snapshot.projectRoot).toBe(projectRoot);
    expect(snapshot.codex.mcp).toMatchObject({
      ejclawConfigured: true,
      serverCount: 2,
    });
    expect(snapshot.claude.mcp).toMatchObject({
      ejclawConfigured: true,
      serverCount: 2,
    });
    expect(snapshot.codex.skillDirs[0]).toMatchObject({
      count: 1,
      skills: [{ name: 'browser', description: 'Browser automation' }],
    });
    expect(snapshot.ejclaw.runnerSkillDir).toMatchObject({
      count: 1,
      skills: [{ name: 'runner', description: 'Runner skill' }],
    });

    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain('sk-secret');
    expect(serialized).not.toContain('should-not-leak');
    expect(serialized).not.toContain('secret-arg-should-not-leak');
  });
});
