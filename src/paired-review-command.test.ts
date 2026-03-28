import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RegisteredGroup, RoomRoleContext } from './types.js';

function runGit(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function loadModules() {
  const db = await import('./db.js');
  const executionContext = await import('./paired-execution-context.js');
  return { db, executionContext };
}

const ownerContext: RoomRoleContext = {
  serviceId: 'codex-main',
  role: 'owner',
  ownerServiceId: 'codex-main',
  reviewerServiceId: 'codex-review',
  failoverOwner: false,
};

const reviewerContext: RoomRoleContext = {
  serviceId: 'codex-review',
  role: 'reviewer',
  ownerServiceId: 'codex-main',
  reviewerServiceId: 'codex-review',
  failoverOwner: false,
};

describe('paired /review command path', () => {
  let tempRoot: string;
  let previousDataDir: string | undefined;
  let previousGroupsDir: string | undefined;
  let previousStoreDir: string | undefined;
  let previousServiceId: string | undefined;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join('/tmp', 'ejclaw-review-command-'));
    previousDataDir = process.env.EJCLAW_DATA_DIR;
    previousGroupsDir = process.env.EJCLAW_GROUPS_DIR;
    previousStoreDir = process.env.EJCLAW_STORE_DIR;
    previousServiceId = process.env.SERVICE_ID;
    process.env.EJCLAW_STORE_DIR = path.join(tempRoot, 'shared-store');
    process.env.EJCLAW_GROUPS_DIR = path.join(tempRoot, 'shared-groups');
    vi.resetModules();
  });

  afterEach(() => {
    if (previousDataDir === undefined) delete process.env.EJCLAW_DATA_DIR;
    else process.env.EJCLAW_DATA_DIR = previousDataDir;
    if (previousGroupsDir === undefined) delete process.env.EJCLAW_GROUPS_DIR;
    else process.env.EJCLAW_GROUPS_DIR = previousGroupsDir;
    if (previousStoreDir === undefined) delete process.env.EJCLAW_STORE_DIR;
    else process.env.EJCLAW_STORE_DIR = previousStoreDir;
    if (previousServiceId === undefined) delete process.env.SERVICE_ID;
    else process.env.SERVICE_ID = previousServiceId;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('reuses the db owner workspace when reviewer service handles /review', async () => {
    const canonicalDir = path.join(tempRoot, 'canonical');
    fs.mkdirSync(canonicalDir, { recursive: true });
    runGit(['init'], canonicalDir);
    runGit(['config', 'user.email', 'test@example.com'], canonicalDir);
    runGit(['config', 'user.name', 'EJClaw Test'], canonicalDir);
    fs.writeFileSync(path.join(canonicalDir, 'README.md'), 'original\n');
    runGit(['add', 'README.md'], canonicalDir);
    runGit(['commit', '-m', 'initial'], canonicalDir);

    const group: RegisteredGroup = {
      name: 'Paired Room',
      folder: 'paired-room',
      trigger: '@codex',
      added_at: '2026-03-28T00:00:00.000Z',
      agentType: 'codex',
      workDir: canonicalDir,
    };

    process.env.EJCLAW_DATA_DIR = path.join(tempRoot, 'data-owner');
    process.env.SERVICE_ID = 'codex-main';
    vi.resetModules();
    let { db, executionContext } = await loadModules();
    db.initDatabase();

    const ownerResult = executionContext.preparePairedExecutionContext({
      group,
      chatJid: 'dc:test',
      runId: 'run-owner',
      roomRoleContext: ownerContext,
    });

    expect(ownerResult?.workspace?.workspace_dir).toBeTruthy();
    const ownerWorkspaceDir = ownerResult!.workspace!.workspace_dir;
    fs.writeFileSync(
      path.join(ownerWorkspaceDir, 'README.md'),
      'owner change\n',
    );

    process.env.EJCLAW_DATA_DIR = path.join(tempRoot, 'data-review');
    process.env.SERVICE_ID = 'codex-review';
    vi.resetModules();
    ({ db, executionContext } = await loadModules());
    db.initDatabase();

    const result = executionContext.markRoomReviewReady({
      group,
      chatJid: 'dc:test',
      roomRoleContext: reviewerContext,
    });

    const reviewerLocalOwnerDir = path.join(
      tempRoot,
      'data-review',
      'workspaces',
      'paired-room',
      'tasks',
      ownerResult!.task.id,
      'owner',
    );

    expect(result).not.toBeNull();
    expect(result?.status).toBe('ready');
    if (!result || result.status !== 'ready') {
      throw new Error('expected reviewer /review to prepare a ready snapshot');
    }
    expect(result.ownerWorkspace.workspace_dir).toBe(ownerWorkspaceDir);
    expect(result.reviewerWorkspace.snapshot_source_dir).toBe(
      ownerWorkspaceDir,
    );
    expect(
      fs.readFileSync(
        path.join(result.reviewerWorkspace.workspace_dir, 'README.md'),
        'utf-8',
      ),
    ).toBe('owner change\n');
    expect(fs.existsSync(reviewerLocalOwnerDir)).toBe(false);
  });

  it('keeps review_pending when reviewer service handles /review before owner workspace exists', async () => {
    const canonicalDir = path.join(tempRoot, 'canonical');
    fs.mkdirSync(canonicalDir, { recursive: true });
    runGit(['init'], canonicalDir);
    runGit(['config', 'user.email', 'test@example.com'], canonicalDir);
    runGit(['config', 'user.name', 'EJClaw Test'], canonicalDir);
    fs.writeFileSync(path.join(canonicalDir, 'README.md'), 'original\n');
    runGit(['add', 'README.md'], canonicalDir);
    runGit(['commit', '-m', 'initial'], canonicalDir);

    const group: RegisteredGroup = {
      name: 'Paired Room',
      folder: 'paired-room',
      trigger: '@codex',
      added_at: '2026-03-28T00:00:00.000Z',
      agentType: 'codex',
      workDir: canonicalDir,
    };

    process.env.EJCLAW_DATA_DIR = path.join(tempRoot, 'data-review');
    process.env.SERVICE_ID = 'codex-review';
    vi.resetModules();
    const { db, executionContext } = await loadModules();
    db.initDatabase();

    const result = executionContext.markRoomReviewReady({
      group,
      chatJid: 'dc:test',
      roomRoleContext: reviewerContext,
    });

    const task = db.getLatestOpenPairedTaskForChat('dc:test');
    const reviewerLocalOwnerDir = path.join(
      tempRoot,
      'data-review',
      'workspaces',
      'paired-room',
      'tasks',
      task!.id,
      'owner',
    );

    expect(result).toEqual({
      status: 'pending',
      task: expect.objectContaining({
        id: task!.id,
        status: 'review_pending',
      }),
      pendingReason: 'owner-workspace-not-ready',
    });
    expect(task?.status).toBe('review_pending');
    expect(task?.review_requested_at).toBeTruthy();
    expect(fs.existsSync(reviewerLocalOwnerDir)).toBe(false);
  });

  it('blocks /review when a high-risk task plan is not approved yet', async () => {
    const canonicalDir = path.join(tempRoot, 'canonical');
    fs.mkdirSync(canonicalDir, { recursive: true });
    runGit(['init'], canonicalDir);
    runGit(['config', 'user.email', 'test@example.com'], canonicalDir);
    runGit(['config', 'user.name', 'EJClaw Test'], canonicalDir);
    fs.writeFileSync(path.join(canonicalDir, 'README.md'), 'original\n');
    runGit(['add', 'README.md'], canonicalDir);
    runGit(['commit', '-m', 'initial'], canonicalDir);

    const group: RegisteredGroup = {
      name: 'Paired Room',
      folder: 'paired-room',
      trigger: '@codex',
      added_at: '2026-03-28T00:00:00.000Z',
      agentType: 'codex',
      workDir: canonicalDir,
    };

    process.env.EJCLAW_DATA_DIR = path.join(tempRoot, 'data-owner');
    process.env.SERVICE_ID = 'codex-main';
    vi.resetModules();
    const { db, executionContext } = await loadModules();
    db.initDatabase();

    const task = executionContext.preparePairedExecutionContext({
      group,
      chatJid: 'dc:test',
      runId: 'run-owner',
      roomRoleContext: ownerContext,
    })?.task;

    expect(task).toBeTruthy();
    db.updatePairedTask(task!.id, {
      risk_level: 'high',
      plan_status: 'pending',
      status: 'plan_review_pending',
      updated_at: '2026-03-29T00:00:00.000Z',
    });

    const result = executionContext.markRoomReviewReady({
      group,
      chatJid: 'dc:test',
      roomRoleContext: ownerContext,
    });

    expect(result).toEqual({
      status: 'blocked',
      task: expect.objectContaining({
        id: task!.id,
        risk_level: 'high',
        plan_status: 'pending',
        status: 'plan_review_pending',
      }),
      blockedReason: 'plan-review-required',
    });
  });
});
