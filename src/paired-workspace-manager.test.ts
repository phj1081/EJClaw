import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function runGit(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function loadModules() {
  const db = await import('./db.js');
  const manager = await import('./paired-workspace-manager.js');
  return { db, manager };
}

describe('paired workspace manager', () => {
  let tempRoot: string;
  let previousDataDir: string | undefined;
  let previousGroupsDir: string | undefined;
  let previousStoreDir: string | undefined;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join('/tmp', 'ejclaw-paired-workspace-'));
    previousDataDir = process.env.EJCLAW_DATA_DIR;
    previousGroupsDir = process.env.EJCLAW_GROUPS_DIR;
    previousStoreDir = process.env.EJCLAW_STORE_DIR;
    process.env.EJCLAW_DATA_DIR = path.join(tempRoot, 'data');
    process.env.EJCLAW_GROUPS_DIR = path.join(tempRoot, 'groups');
    process.env.EJCLAW_STORE_DIR = path.join(tempRoot, 'store');
    vi.resetModules();
  });

  afterEach(() => {
    if (previousDataDir === undefined) delete process.env.EJCLAW_DATA_DIR;
    else process.env.EJCLAW_DATA_DIR = previousDataDir;
    if (previousGroupsDir === undefined) delete process.env.EJCLAW_GROUPS_DIR;
    else process.env.EJCLAW_GROUPS_DIR = previousGroupsDir;
    if (previousStoreDir === undefined) delete process.env.EJCLAW_STORE_DIR;
    else process.env.EJCLAW_STORE_DIR = previousStoreDir;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('registers the owner workspace for reviewer execution when review is requested', async () => {
    const { db, manager } = await loadModules();
    db._initTestDatabase();

    const canonicalDir = path.join(tempRoot, 'canonical');
    fs.mkdirSync(canonicalDir, { recursive: true });
    runGit(['init'], canonicalDir);
    runGit(['config', 'user.email', 'test@example.com'], canonicalDir);
    runGit(['config', 'user.name', 'EJClaw Test'], canonicalDir);
    fs.writeFileSync(path.join(canonicalDir, 'README.md'), 'original\n');
    runGit(['add', 'README.md'], canonicalDir);
    runGit(['commit', '-m', 'initial'], canonicalDir);

    const now = '2026-03-28T00:00:00.000Z';
    db.upsertPairedProject({
      chat_jid: 'dc:test',
      group_folder: 'paired-room',
      canonical_work_dir: canonicalDir,
      created_at: now,
      updated_at: now,
    });
    db.createPairedTask({
      id: 'paired-task-1',
      chat_jid: 'dc:test',
      group_folder: 'paired-room',
      owner_service_id: 'codex-main',
      reviewer_service_id: 'codex-review',
      title: 'review the owner changes',
      source_ref: 'HEAD',
      plan_notes: null,
      round_trip_count: 0,
      review_requested_at: null,
      status: 'active',
      created_at: now,
      updated_at: now,
    });

    const ownerWorkspace =
      manager.provisionOwnerWorkspaceForPairedTask('paired-task-1');
    expect(fs.existsSync(path.join(ownerWorkspace.workspace_dir, '.git'))).toBe(
      true,
    );

    fs.writeFileSync(
      path.join(ownerWorkspace.workspace_dir, 'README.md'),
      'owner modified\n',
    );
    fs.writeFileSync(
      path.join(ownerWorkspace.workspace_dir, 'NEW_FILE.txt'),
      'review me\n',
    );

    const reviewReady = manager.markPairedTaskReviewReady('paired-task-1');
    expect(reviewReady).not.toBeNull();
    const reviewerWorkspace = reviewReady!.reviewerWorkspace;

    expect(
      fs.readFileSync(
        path.join(reviewerWorkspace.workspace_dir, 'README.md'),
        'utf-8',
      ),
    ).toBe('owner modified\n');
    expect(
      fs.readFileSync(
        path.join(reviewerWorkspace.workspace_dir, 'NEW_FILE.txt'),
        'utf-8',
      ),
    ).toBe('review me\n');
    expect(reviewerWorkspace.workspace_dir).toBe(ownerWorkspace.workspace_dir);
    expect(reviewerWorkspace.snapshot_source_dir).toBe(
      ownerWorkspace.workspace_dir,
    );
    expect(db.getPairedTaskById('paired-task-1')?.status).toBe('review_ready');
    expect(
      db.getPairedTaskById('paired-task-1')?.review_requested_at,
    ).toBeTruthy();
    expect(
      db.getPairedWorkspace('paired-task-1', 'reviewer')?.snapshot_refreshed_at,
    ).toBeTruthy();
    expect(
      db.getPairedWorkspace('paired-task-1', 'reviewer')?.snapshot_ref,
    ).toBe(null);
  });

  it('uses the shared DB owner workspace across service-local data dirs', async () => {
    const canonicalDir = path.join(tempRoot, 'canonical');
    fs.mkdirSync(canonicalDir, { recursive: true });
    runGit(['init'], canonicalDir);
    runGit(['config', 'user.email', 'test@example.com'], canonicalDir);
    runGit(['config', 'user.name', 'EJClaw Test'], canonicalDir);
    fs.writeFileSync(path.join(canonicalDir, 'README.md'), 'original\n');
    runGit(['add', 'README.md'], canonicalDir);
    runGit(['commit', '-m', 'initial'], canonicalDir);

    process.env.EJCLAW_STORE_DIR = path.join(tempRoot, 'shared-store');
    process.env.EJCLAW_GROUPS_DIR = path.join(tempRoot, 'shared-groups');

    process.env.EJCLAW_DATA_DIR = path.join(tempRoot, 'data-owner');
    vi.resetModules();
    let { db, manager } = await loadModules();
    db.initDatabase();

    const now = '2026-03-28T00:00:00.000Z';
    db.upsertPairedProject({
      chat_jid: 'dc:test',
      group_folder: 'paired-room',
      canonical_work_dir: canonicalDir,
      created_at: now,
      updated_at: now,
    });
    db.createPairedTask({
      id: 'paired-task-cross-service',
      chat_jid: 'dc:test',
      group_folder: 'paired-room',
      owner_service_id: 'codex-main',
      reviewer_service_id: 'codex-review',
      title: 'cross service review',
      source_ref: 'HEAD',
      plan_notes: null,
      round_trip_count: 0,
      review_requested_at: null,
      status: 'active',
      created_at: now,
      updated_at: now,
    });

    const ownerWorkspace = manager.provisionOwnerWorkspaceForPairedTask(
      'paired-task-cross-service',
    );
    fs.writeFileSync(
      path.join(ownerWorkspace.workspace_dir, 'README.md'),
      'owner modified\n',
    );

    process.env.EJCLAW_DATA_DIR = path.join(tempRoot, 'data-review');
    vi.resetModules();
    ({ db, manager } = await loadModules());
    db.initDatabase();

    const reviewerWorkspace = manager.refreshReviewerSnapshotForPairedTask(
      'paired-task-cross-service',
    );
    const reviewServiceOwnerDir = path.join(
      tempRoot,
      'data-review',
      'workspaces',
      'paired-room',
      'tasks',
      'paired-task-cross-service',
      'owner',
    );

    expect(
      fs.readFileSync(
        path.join(reviewerWorkspace.workspace_dir, 'README.md'),
        'utf-8',
      ),
    ).toBe('owner modified\n');
    expect(reviewerWorkspace.snapshot_source_dir).toBe(
      ownerWorkspace.workspace_dir,
    );
    expect(fs.existsSync(reviewServiceOwnerDir)).toBe(false);
  });

  it('replaces stale reviewer files on snapshot refresh', async () => {
    const { db, manager } = await loadModules();
    db._initTestDatabase();

    const canonicalDir = path.join(tempRoot, 'canonical');
    fs.mkdirSync(canonicalDir, { recursive: true });
    runGit(['init'], canonicalDir);
    runGit(['config', 'user.email', 'test@example.com'], canonicalDir);
    runGit(['config', 'user.name', 'EJClaw Test'], canonicalDir);
    fs.writeFileSync(path.join(canonicalDir, 'keep.txt'), 'keep\n');
    fs.writeFileSync(path.join(canonicalDir, 'remove.txt'), 'remove\n');
    runGit(['add', 'keep.txt', 'remove.txt'], canonicalDir);
    runGit(['commit', '-m', 'initial'], canonicalDir);

    const now = '2026-03-28T00:00:00.000Z';
    db.upsertPairedProject({
      chat_jid: 'dc:test',
      group_folder: 'paired-room',
      canonical_work_dir: canonicalDir,
      created_at: now,
      updated_at: now,
    });
    db.createPairedTask({
      id: 'paired-task-2',
      chat_jid: 'dc:test',
      group_folder: 'paired-room',
      owner_service_id: 'codex-main',
      reviewer_service_id: 'codex-review',
      title: null,
      source_ref: 'HEAD',
      plan_notes: null,
      round_trip_count: 0,
      review_requested_at: null,
      status: 'active',
      created_at: now,
      updated_at: now,
    });

    const ownerWorkspace =
      manager.provisionOwnerWorkspaceForPairedTask('paired-task-2');
    manager.refreshReviewerSnapshotForPairedTask('paired-task-2');

    fs.rmSync(path.join(ownerWorkspace.workspace_dir, 'remove.txt'));
    fs.writeFileSync(
      path.join(ownerWorkspace.workspace_dir, 'keep.txt'),
      'updated\n',
    );

    const reviewerWorkspace =
      manager.refreshReviewerSnapshotForPairedTask('paired-task-2');

    expect(
      fs.existsSync(path.join(reviewerWorkspace.workspace_dir, 'remove.txt')),
    ).toBe(false);
    expect(
      fs.readFileSync(
        path.join(reviewerWorkspace.workspace_dir, 'keep.txt'),
        'utf-8',
      ),
    ).toBe('updated\n');
    expect(
      runGit(['status', '--short'], reviewerWorkspace.workspace_dir),
    ).toContain('D remove.txt');
  });

  it('filters secrets, caches, and build outputs out of reviewer snapshots', async () => {
    const { db, manager } = await loadModules();
    db._initTestDatabase();

    const canonicalDir = path.join(tempRoot, 'canonical');
    fs.mkdirSync(canonicalDir, { recursive: true });
    runGit(['init'], canonicalDir);
    runGit(['config', 'user.email', 'test@example.com'], canonicalDir);
    runGit(['config', 'user.name', 'EJClaw Test'], canonicalDir);
    fs.writeFileSync(
      path.join(canonicalDir, 'tracked.ts'),
      'export const ok = 1;\n',
    );
    fs.writeFileSync(
      path.join(canonicalDir, '.env.production'),
      'TRACKED_SECRET=1\n',
    );
    fs.writeFileSync(path.join(canonicalDir, '.env.example'), 'EXAMPLE=1\n');
    runGit(
      ['add', 'tracked.ts', '.env.production', '.env.example'],
      canonicalDir,
    );
    runGit(['commit', '-m', 'initial'], canonicalDir);

    const now = '2026-03-28T00:00:00.000Z';
    db.upsertPairedProject({
      chat_jid: 'dc:test',
      group_folder: 'paired-room',
      canonical_work_dir: canonicalDir,
      created_at: now,
      updated_at: now,
    });
    db.createPairedTask({
      id: 'paired-task-3',
      chat_jid: 'dc:test',
      group_folder: 'paired-room',
      owner_service_id: 'codex-main',
      reviewer_service_id: 'codex-review',
      title: null,
      source_ref: 'HEAD',
      plan_notes: null,
      round_trip_count: 0,
      review_requested_at: null,
      status: 'active',
      created_at: now,
      updated_at: now,
    });

    const ownerWorkspace =
      manager.provisionOwnerWorkspaceForPairedTask('paired-task-3');
    fs.mkdirSync(path.join(ownerWorkspace.workspace_dir, 'src'), {
      recursive: true,
    });
    fs.mkdirSync(
      path.join(ownerWorkspace.workspace_dir, 'node_modules', '.cache'),
      {
        recursive: true,
      },
    );
    fs.mkdirSync(path.join(ownerWorkspace.workspace_dir, 'dist'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(ownerWorkspace.workspace_dir, 'logs'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(ownerWorkspace.workspace_dir, 'src', 'draft.ts'),
      'export const draft = true;\n',
    );
    fs.writeFileSync(
      path.join(ownerWorkspace.workspace_dir, '.env.local'),
      'SECRET=1\n',
    );
    fs.writeFileSync(
      path.join(ownerWorkspace.workspace_dir, 'node_modules', '.cache', 'x'),
      'cache\n',
    );
    fs.writeFileSync(
      path.join(ownerWorkspace.workspace_dir, 'dist', 'bundle.js'),
      'dist\n',
    );
    fs.writeFileSync(
      path.join(ownerWorkspace.workspace_dir, 'logs', 'debug.log'),
      'log\n',
    );

    const reviewerWorkspace =
      manager.refreshReviewerSnapshotForPairedTask('paired-task-3');

    expect(
      fs.readFileSync(
        path.join(reviewerWorkspace.workspace_dir, 'src', 'draft.ts'),
        'utf-8',
      ),
    ).toBe('export const draft = true;\n');
    expect(
      fs.existsSync(
        path.join(reviewerWorkspace.workspace_dir, '.env.production'),
      ),
    ).toBe(false);
    expect(
      fs.readFileSync(
        path.join(reviewerWorkspace.workspace_dir, '.env.example'),
        'utf-8',
      ),
    ).toBe('EXAMPLE=1\n');
    expect(
      fs.existsSync(path.join(reviewerWorkspace.workspace_dir, '.env.local')),
    ).toBe(false);
    expect(
      fs.existsSync(
        path.join(
          reviewerWorkspace.workspace_dir,
          'node_modules',
          '.cache',
          'x',
        ),
      ),
    ).toBe(false);
    expect(
      fs.existsSync(
        path.join(reviewerWorkspace.workspace_dir, 'dist', 'bundle.js'),
      ),
    ).toBe(false);
    expect(
      fs.existsSync(
        path.join(reviewerWorkspace.workspace_dir, 'logs', 'debug.log'),
      ),
    ).toBe(false);
  });

  it('keeps reviewer git status clean while hiding denied tracked files', async () => {
    const { db, manager } = await loadModules();
    db._initTestDatabase();

    const canonicalDir = path.join(tempRoot, 'canonical');
    fs.mkdirSync(path.join(canonicalDir, '.claude'), { recursive: true });
    runGit(['init'], canonicalDir);
    runGit(['config', 'user.email', 'test@example.com'], canonicalDir);
    runGit(['config', 'user.name', 'EJClaw Test'], canonicalDir);
    fs.writeFileSync(
      path.join(canonicalDir, 'tracked.ts'),
      'export const ok = 1;\n',
    );
    fs.writeFileSync(
      path.join(canonicalDir, '.claude', 'settings.json'),
      '{"secret":true}\n',
    );
    fs.writeFileSync(
      path.join(canonicalDir, '.env.production'),
      'TRACKED_SECRET=1\n',
    );
    fs.writeFileSync(path.join(canonicalDir, '.env.example'), 'EXAMPLE=1\n');
    runGit(
      [
        'add',
        'tracked.ts',
        '.claude/settings.json',
        '.env.production',
        '.env.example',
      ],
      canonicalDir,
    );
    runGit(['commit', '-m', 'initial'], canonicalDir);

    const now = '2026-03-28T00:00:00.000Z';
    db.upsertPairedProject({
      chat_jid: 'dc:test',
      group_folder: 'paired-room',
      canonical_work_dir: canonicalDir,
      created_at: now,
      updated_at: now,
    });
    db.createPairedTask({
      id: 'paired-task-4',
      chat_jid: 'dc:test',
      group_folder: 'paired-room',
      owner_service_id: 'codex-main',
      reviewer_service_id: 'codex-review',
      title: null,
      source_ref: 'HEAD',
      plan_notes: null,
      round_trip_count: 0,
      review_requested_at: null,
      status: 'active',
      created_at: now,
      updated_at: now,
    });

    manager.provisionOwnerWorkspaceForPairedTask('paired-task-4');
    const reviewerWorkspace =
      manager.refreshReviewerSnapshotForPairedTask('paired-task-4');

    expect(runGit(['status', '--short'], reviewerWorkspace.workspace_dir)).toBe(
      '',
    );
    expect(
      fs.existsSync(
        path.join(reviewerWorkspace.workspace_dir, '.claude', 'settings.json'),
      ),
    ).toBe(false);
    expect(
      fs.existsSync(
        path.join(reviewerWorkspace.workspace_dir, '.env.production'),
      ),
    ).toBe(false);
    expect(
      fs.readFileSync(
        path.join(reviewerWorkspace.workspace_dir, '.env.example'),
        'utf-8',
      ),
    ).toBe('EXAMPLE=1\n');
  });

  it('registers a reviewer workspace when an explicit review request already exists', async () => {
    const { db, manager } = await loadModules();
    db._initTestDatabase();

    const canonicalDir = path.join(tempRoot, 'canonical');
    fs.mkdirSync(canonicalDir, { recursive: true });
    runGit(['init'], canonicalDir);
    runGit(['config', 'user.email', 'test@example.com'], canonicalDir);
    runGit(['config', 'user.name', 'EJClaw Test'], canonicalDir);
    fs.writeFileSync(path.join(canonicalDir, 'README.md'), 'base\n');
    runGit(['add', 'README.md'], canonicalDir);
    runGit(['commit', '-m', 'initial'], canonicalDir);

    const now = '2026-03-28T00:00:00.000Z';
    db.upsertPairedProject({
      chat_jid: 'dc:test',
      group_folder: 'paired-room',
      canonical_work_dir: canonicalDir,
      created_at: now,
      updated_at: now,
    });
    db.createPairedTask({
      id: 'paired-task-5b',
      chat_jid: 'dc:test',
      group_folder: 'paired-room',
      owner_service_id: 'codex-main',
      reviewer_service_id: 'codex-review',
      title: null,
      source_ref: 'HEAD',
      plan_notes: null,
      round_trip_count: 0,
      review_requested_at: '2026-03-28T00:01:00.000Z',
      status: 'review_ready',
      created_at: now,
      updated_at: '2026-03-28T00:01:00.000Z',
    });

    const ownerWorkspace =
      manager.provisionOwnerWorkspaceForPairedTask('paired-task-5b');
    fs.writeFileSync(
      path.join(ownerWorkspace.workspace_dir, 'README.md'),
      'owner change\n',
    );

    const result = manager.prepareReviewerWorkspaceForExecution(
      db.getPairedTaskById('paired-task-5b')!,
    );

    expect(result.autoRefreshed).toBe(false);
    expect(result.blockMessage).toBeUndefined();
    expect(result.workspace?.workspace_dir).toBe(ownerWorkspace.workspace_dir);
    expect(result.workspace?.snapshot_source_dir).toBe(
      ownerWorkspace.workspace_dir,
    );
    expect(
      fs.readFileSync(
        path.join(result.workspace!.workspace_dir, 'README.md'),
        'utf-8',
      ),
    ).toBe('owner change\n');
    expect(db.getPairedTaskById('paired-task-5b')?.status).toBe('review_ready');
    expect(db.getPairedTaskById('paired-task-5b')?.review_requested_at).toBe(
      '2026-03-28T00:01:00.000Z',
    );
  });

  it('reuses the live owner workspace during in-review turns', async () => {
    const { db, manager } = await loadModules();
    db._initTestDatabase();

    const canonicalDir = path.join(tempRoot, 'canonical');
    fs.mkdirSync(canonicalDir, { recursive: true });
    runGit(['init'], canonicalDir);
    runGit(['config', 'user.email', 'test@example.com'], canonicalDir);
    runGit(['config', 'user.name', 'EJClaw Test'], canonicalDir);
    fs.writeFileSync(path.join(canonicalDir, 'README.md'), 'base\n');
    runGit(['add', 'README.md'], canonicalDir);
    runGit(['commit', '-m', 'initial'], canonicalDir);

    const now = '2026-03-28T00:00:00.000Z';
    db.upsertPairedProject({
      chat_jid: 'dc:test',
      group_folder: 'paired-room',
      canonical_work_dir: canonicalDir,
      created_at: now,
      updated_at: now,
    });
    db.createPairedTask({
      id: 'paired-task-6',
      chat_jid: 'dc:test',
      group_folder: 'paired-room',
      owner_service_id: 'codex-main',
      reviewer_service_id: 'codex-review',
      title: null,
      source_ref: 'HEAD',
      plan_notes: null,
      round_trip_count: 0,
      review_requested_at: null,
      status: 'active',
      created_at: now,
      updated_at: now,
    });

    const ownerWorkspace =
      manager.provisionOwnerWorkspaceForPairedTask('paired-task-6');
    fs.writeFileSync(
      path.join(ownerWorkspace.workspace_dir, 'README.md'),
      'first review\n',
    );
    manager.markPairedTaskReviewReady('paired-task-6');
    db.updatePairedTask('paired-task-6', {
      status: 'in_review',
      updated_at: '2026-03-28T00:05:00.000Z',
    });

    fs.writeFileSync(
      path.join(ownerWorkspace.workspace_dir, 'README.md'),
      'owner changed again\n',
    );

    const result = manager.prepareReviewerWorkspaceForExecution(
      db.getPairedTaskById('paired-task-6')!,
    );

    expect(result.workspace?.workspace_dir).toBe(ownerWorkspace.workspace_dir);
    expect(result.autoRefreshed).toBe(false);
    expect(result.blockMessage).toBeUndefined();
    expect(db.getPairedTaskById('paired-task-6')?.status).toBe('in_review');
    expect(
      db.getPairedTaskById('paired-task-6')?.review_requested_at,
    ).toBeTruthy();
    expect(
      fs.readFileSync(
        path.join(result.workspace!.workspace_dir, 'README.md'),
        'utf-8',
      ),
    ).toBe('owner changed again\n');
  });
});
