import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AGENT_LANGUAGE } from './config.js';
import {
  getPairedRoomPromptPath,
  getPlatformPromptPath,
  readPairedRoomPrompt,
  readPlatformPrompt,
} from './platform-prompts.js';

describe('platform-prompts', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ejclaw-prompts-'));
    vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns undefined when the prompt file is missing', () => {
    expect(readPlatformPrompt('claude-code')).toBeUndefined();
  });

  it('reads and trims provider-specific prompt files', () => {
    const promptsDir = path.join(tempDir, 'prompts');
    fs.mkdirSync(promptsDir, { recursive: true });
    fs.writeFileSync(
      path.join(promptsDir, 'codex-platform.md'),
      '\nCodex platform prompt\n',
    );

    expect(getPlatformPromptPath('codex')).toBe(
      path.join(promptsDir, 'codex-platform.md'),
    );
    expect(readPlatformPrompt('codex')).toBe('Codex platform prompt');
  });

  it('reads and trims paired-room prompt files', () => {
    const promptsDir = path.join(tempDir, 'prompts');
    fs.mkdirSync(promptsDir, { recursive: true });
    fs.writeFileSync(
      path.join(promptsDir, 'claude-paired-room.md'),
      '\nClaude paired prompt\n',
    );

    expect(getPairedRoomPromptPath('claude-code')).toBe(
      path.join(promptsDir, 'claude-paired-room.md'),
    );
    const expected = AGENT_LANGUAGE
      ? `Claude paired prompt\n\n## Language\n\nAlways respond in ${AGENT_LANGUAGE}.`
      : 'Claude paired prompt';
    expect(readPairedRoomPrompt('claude-code')).toBe(expected);
  });

  it('maps Codex paired-room prompts to the shared reviewer prompt while preserving failover identity wording', () => {
    const repoRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
    );

    expect(getPairedRoomPromptPath('codex', repoRoot)).toBe(
      path.join(repoRoot, 'prompts', 'claude-paired-room.md'),
    );

    const codexPairedPrompt = readPairedRoomPrompt('codex', repoRoot);
    expect(codexPairedPrompt).toContain('reviewer');
    expect(codexPairedPrompt).toContain('the output is invalid');
    expect(codexPairedPrompt).toContain('EJCLAW_WORK_DIR');
    expect(codexPairedPrompt).toContain(
      'canonical verification root for this turn',
    );
    expect(codexPairedPrompt).toContain(
      'suggest 1-2 better alternatives with the reason and tradeoff for each',
    );
    expect(codexPairedPrompt).toContain(
      'Separate correctness issues from improvement ideas',
    );
    expect(codexPairedPrompt).toContain(
      'Do not present static analysis as completed verification',
    );
    expect(codexPairedPrompt).toContain('Keep reviewer output owner-facing');
    expect(codexPairedPrompt).toContain('prefer 3-6 lines');
    expect(codexPairedPrompt).not.toContain('owner-side paired agent');

    const failoverPlatformPrompt = fs.readFileSync(
      path.join(repoRoot, 'prompts', 'codex-review-failover-platform.md'),
      'utf-8',
    );
    expect(failoverPlatformPrompt).toContain('acting as `클코`');
  });

  it('keeps the superpowers-derived debugging guidance compressed and role-scoped', () => {
    const repoRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
    );
    const promptsDir = path.join(repoRoot, 'prompts');
    const ownerPrompt = fs.readFileSync(
      path.join(promptsDir, 'owner-common-paired-room.md'),
      'utf-8',
    );
    const reviewerPrompt = fs.readFileSync(
      path.join(promptsDir, 'claude-paired-room.md'),
      'utf-8',
    );

    for (const prompt of [ownerPrompt, reviewerPrompt]) {
      expect(prompt).toContain('## Debugging discipline');
      expect(prompt).toContain('root-cause');
      expect(prompt).toContain('component-boundary data');
      expect(prompt).toContain('same failed fix path');
      expect(prompt).toContain('3 times');
      expect(prompt).not.toContain('superpowers');
      expect(prompt).not.toContain('NO FIXES WITHOUT ROOT CAUSE');
      expect(prompt).not.toContain('The Four Phases');
    }
  });

  it('keeps file-backed note guidance optional and lightweight', () => {
    const repoRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
    );
    const promptsDir = path.join(repoRoot, 'prompts');
    const ownerPrompt = fs.readFileSync(
      path.join(promptsDir, 'owner-common-paired-room.md'),
      'utf-8',
    );
    const reviewerPrompt = fs.readFileSync(
      path.join(promptsDir, 'claude-paired-room.md'),
      'utf-8',
    );

    for (const prompt of [ownerPrompt, reviewerPrompt]) {
      expect(prompt).toContain('## Durable work notes');
      expect(prompt).toContain('multi-step plans');
      expect(prompt).toContain('long debugging evidence');
      expect(prompt).toContain('existing docs/plans location');
      expect(prompt).not.toContain('docs/superpowers');
      expect(prompt).not.toContain('Every plan MUST');
    }
  });
});
