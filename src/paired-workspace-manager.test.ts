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

const FIXTURE_NOW = '2026-03-28T00:00:00.000Z';

function initCanonicalRepo(
  repoDir: string,
  files: Record<string, string> = { 'README.md': 'original\n' },
): void {
  fs.mkdirSync(repoDir, { recursive: true });
  runGit(['init'], repoDir);
  runGit(['config', 'user.email', 'test@example.com'], repoDir);
  runGit(['config', 'user.name', 'EJClaw Test'], repoDir);
  for (const [relativePath, contents] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repoDir, relativePath)), {
      recursive: true,
    });
    fs.writeFileSync(path.join(repoDir, relativePath), contents);
  }
  runGit(['add', '.'], repoDir);
  runGit(['commit', '-m', 'initial'], repoDir);
}

function seedPairedTask(
  db: Awaited<ReturnType<typeof loadModules>>['db'],
  canonicalDir: string,
  args: {
    taskId: string;
    groupFolder?: string;
    chatJid?: string;
    sourceRef?: string;
    status?: 'active' | 'review_ready' | 'in_review' | 'merge_ready';
    reviewRequestedAt?: string | null;
    updatedAt?: string;
  },
): void {
  const groupFolder = args.groupFolder ?? 'paired-room';
  const chatJid = args.chatJid ?? 'dc:test';
  const reviewRequestedAt = args.reviewRequestedAt ?? null;
  const updatedAt = args.updatedAt ?? FIXTURE_NOW;

  db.upsertPairedProject({
    chat_jid: chatJid,
    group_folder: groupFolder,
    canonical_work_dir: canonicalDir,
    created_at: FIXTURE_NOW,
    updated_at: FIXTURE_NOW,
  });
  db.createPairedTask({
    id: args.taskId,
    chat_jid: chatJid,
    group_folder: groupFolder,
    owner_service_id: 'codex-main',
    reviewer_service_id: 'codex-review',
    title: null,
    source_ref: args.sourceRef ?? 'HEAD',
    plan_notes: null,
    round_trip_count: 0,
    review_requested_at: reviewRequestedAt,
    status: args.status ?? 'active',
    arbiter_verdict: null,
    arbiter_requested_at: null,
    completion_reason: null,
    created_at: FIXTURE_NOW,
    updated_at: updatedAt,
  });
}

function ownerBranchName(groupFolder: string): string {
  return `codex/owner/${groupFolder}`;
}

function ownerWorkspacePath(groupFolder: string): string {
  return path.join(
    process.env.EJCLAW_DATA_DIR!,
    'workspaces',
    groupFolder,
    'owner',
  );
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
      arbiter_verdict: null,
      arbiter_requested_at: null,
      completion_reason: null,
      created_at: now,
      updated_at: now,
    });

    const ownerWorkspace =
      manager.provisionOwnerWorkspaceForPairedTask('paired-task-1');
    expect(fs.existsSync(path.join(ownerWorkspace.workspace_dir, '.git'))).toBe(
      true,
    );
    expect(
      runGit(['branch', '--show-current'], ownerWorkspace.workspace_dir),
    ).toBe(ownerBranchName('paired-room'));

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

  it('ensures owner workspace dependencies on provision and review handoff', async () => {
    const ensureWorkspaceDependenciesInstalledMock = vi.fn(() => ({
      installed: false,
      packageManager: 'pnpm' as const,
    }));
    vi.doMock('./workspace-package-manager.js', async () => {
      const actual = await vi.importActual<
        typeof import('./workspace-package-manager.js')
      >('./workspace-package-manager.js');
      return {
        ...actual,
        ensureWorkspaceDependenciesInstalled:
          ensureWorkspaceDependenciesInstalledMock,
      };
    });

    const { db, manager } = await loadModules();
    db._initTestDatabase();

    const canonicalDir = path.join(tempRoot, 'canonical');
    initCanonicalRepo(canonicalDir);
    seedPairedTask(db, canonicalDir, {
      taskId: 'paired-task-install-owner-deps',
      groupFolder: 'install-room',
    });

    const ownerWorkspace = manager.provisionOwnerWorkspaceForPairedTask(
      'paired-task-install-owner-deps',
    );

    expect(ensureWorkspaceDependenciesInstalledMock).toHaveBeenCalledTimes(1);
    expect(ensureWorkspaceDependenciesInstalledMock).toHaveBeenNthCalledWith(
      1,
      ownerWorkspace.workspace_dir,
    );

    manager.markPairedTaskReviewReady('paired-task-install-owner-deps');

    expect(ensureWorkspaceDependenciesInstalledMock).toHaveBeenCalledTimes(2);
    expect(ensureWorkspaceDependenciesInstalledMock).toHaveBeenNthCalledWith(
      2,
      ownerWorkspace.workspace_dir,
    );
  });

  it('leaves review_requested_at untouched when review handoff aborts before an owner workspace exists', async () => {
    const { db, manager } = await loadModules();
    db._initTestDatabase();

    const canonicalDir = path.join(tempRoot, 'canonical');
    initCanonicalRepo(canonicalDir);
    seedPairedTask(db, canonicalDir, {
      taskId: 'paired-task-no-owner-workspace',
      groupFolder: 'no-owner-workspace-room',
    });

    const result = manager.markPairedTaskReviewReady(
      'paired-task-no-owner-workspace',
    );

    expect(result).toBeNull();
    expect(
      db.getPairedTaskById('paired-task-no-owner-workspace')
        ?.review_requested_at,
    ).toBeNull();
    expect(db.getPairedTaskById('paired-task-no-owner-workspace')?.status).toBe(
      'active',
    );
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
      arbiter_verdict: null,
      arbiter_requested_at: null,
      completion_reason: null,
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
      arbiter_verdict: null,
      arbiter_requested_at: null,
      completion_reason: null,
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
      arbiter_verdict: null,
      arbiter_requested_at: null,
      completion_reason: null,
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
      arbiter_verdict: null,
      arbiter_requested_at: null,
      completion_reason: null,
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
      arbiter_verdict: null,
      arbiter_requested_at: null,
      completion_reason: null,
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
      arbiter_verdict: null,
      arbiter_requested_at: null,
      completion_reason: null,
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

  it('resyncs a stale reviewer workspace record to the current owner workspace', async () => {
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
      id: 'paired-task-6b',
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
      arbiter_verdict: null,
      arbiter_requested_at: null,
      completion_reason: null,
      created_at: now,
      updated_at: '2026-03-28T00:01:00.000Z',
    });

    const ownerWorkspace =
      manager.provisionOwnerWorkspaceForPairedTask('paired-task-6b');
    db.upsertPairedWorkspace({
      id: 'paired-task-6b:reviewer',
      task_id: 'paired-task-6b',
      role: 'reviewer',
      workspace_dir: canonicalDir,
      snapshot_source_dir: canonicalDir,
      snapshot_ref: 'stale-fingerprint',
      status: 'ready',
      snapshot_refreshed_at: '2026-03-28T00:01:00.000Z',
      created_at: '2026-03-28T00:01:00.000Z',
      updated_at: '2026-03-28T00:01:00.000Z',
    });

    const result = manager.prepareReviewerWorkspaceForExecution(
      db.getPairedTaskById('paired-task-6b')!,
    );

    expect(result.autoRefreshed).toBe(false);
    expect(result.blockMessage).toBeUndefined();
    expect(result.workspace?.workspace_dir).toBe(ownerWorkspace.workspace_dir);
    expect(result.workspace?.snapshot_source_dir).toBe(
      ownerWorkspace.workspace_dir,
    );
    expect(
      db.getPairedWorkspace('paired-task-6b', 'reviewer')?.workspace_dir,
    ).toBe(ownerWorkspace.workspace_dir);
    expect(
      db.getPairedWorkspace('paired-task-6b', 'reviewer')?.snapshot_source_dir,
    ).toBe(ownerWorkspace.workspace_dir);
    expect(
      db.getPairedWorkspace('paired-task-6b', 'reviewer')
        ?.snapshot_refreshed_at,
    ).not.toBe('2026-03-28T00:01:00.000Z');
  });

  it('bases a new owner branch on the canonical repo HEAD without requiring a remote', async () => {
    const { db, manager } = await loadModules();
    db._initTestDatabase();

    const canonicalDir = path.join(tempRoot, 'canonical');
    initCanonicalRepo(canonicalDir);
    runGit(['checkout', '-b', 'feature/base'], canonicalDir);
    fs.writeFileSync(path.join(canonicalDir, 'README.md'), 'feature base\n');
    runGit(['commit', '-am', 'feature base'], canonicalDir);

    seedPairedTask(db, canonicalDir, {
      taskId: 'paired-task-head-base',
      groupFolder: 'head-base-room',
    });

    const ownerWorkspace = manager.provisionOwnerWorkspaceForPairedTask(
      'paired-task-head-base',
    );

    expect(
      runGit(['branch', '--show-current'], ownerWorkspace.workspace_dir),
    ).toBe(ownerBranchName('head-base-room'));
    expect(
      fs.readFileSync(
        path.join(ownerWorkspace.workspace_dir, 'README.md'),
        'utf-8',
      ),
    ).toBe('feature base\n');
    expect(runGit(['rev-parse', 'HEAD'], ownerWorkspace.workspace_dir)).toBe(
      runGit(['rev-parse', 'HEAD'], canonicalDir),
    );
  });

  it('provisions and reprovisions owner workspaces when source_ref is a tree hash', async () => {
    const { db, manager } = await loadModules();
    db._initTestDatabase();

    const canonicalDir = path.join(tempRoot, 'canonical');
    initCanonicalRepo(canonicalDir);
    fs.writeFileSync(path.join(canonicalDir, 'README.md'), 'tree source\n');
    runGit(['commit', '-am', 'tree source'], canonicalDir);
    const treeSourceRef = runGit(['rev-parse', 'HEAD^{tree}'], canonicalDir);

    seedPairedTask(db, canonicalDir, {
      taskId: 'paired-task-tree-source-ref',
      groupFolder: 'tree-source-room',
      sourceRef: treeSourceRef,
    });

    const firstProvision = manager.provisionOwnerWorkspaceForPairedTask(
      'paired-task-tree-source-ref',
    );
    const secondProvision = manager.provisionOwnerWorkspaceForPairedTask(
      'paired-task-tree-source-ref',
    );

    expect(firstProvision.workspace_dir).toBe(secondProvision.workspace_dir);
    expect(
      runGit(['branch', '--show-current'], secondProvision.workspace_dir),
    ).toBe(ownerBranchName('tree-source-room'));
    expect(
      fs.readFileSync(
        path.join(secondProvision.workspace_dir, 'README.md'),
        'utf-8',
      ),
    ).toBe('tree source\n');
    expect(runGit(['rev-parse', 'HEAD'], secondProvision.workspace_dir)).toBe(
      runGit(['rev-parse', 'HEAD'], canonicalDir),
    );
  });

  it('repairs a missing but registered owner worktree path before reprovisioning', async () => {
    const { db, manager } = await loadModules();
    db._initTestDatabase();

    const canonicalDir = path.join(tempRoot, 'canonical');
    initCanonicalRepo(canonicalDir);
    seedPairedTask(db, canonicalDir, {
      taskId: 'paired-task-repair',
      groupFolder: 'repair-room',
    });

    const ownerWorkspace =
      manager.provisionOwnerWorkspaceForPairedTask('paired-task-repair');
    fs.rmSync(ownerWorkspace.workspace_dir, { recursive: true, force: true });

    expect(runGit(['worktree', 'list', '--porcelain'], canonicalDir)).toContain(
      ownerWorkspace.workspace_dir,
    );

    const reprovisioned =
      manager.provisionOwnerWorkspaceForPairedTask('paired-task-repair');

    expect(reprovisioned.workspace_dir).toBe(ownerWorkspace.workspace_dir);
    expect(
      runGit(['branch', '--show-current'], reprovisioned.workspace_dir),
    ).toBe(ownerBranchName('repair-room'));
    expect(runGit(['worktree', 'list', '--porcelain'], canonicalDir)).toContain(
      reprovisioned.workspace_dir,
    );
  });

  it('lazy-migrates a detached dirty owner workspace to a new channel branch', async () => {
    const { db, manager } = await loadModules();
    db._initTestDatabase();

    const canonicalDir = path.join(tempRoot, 'canonical');
    initCanonicalRepo(canonicalDir);
    seedPairedTask(db, canonicalDir, {
      taskId: 'paired-task-migrate-new-branch',
      groupFolder: 'migrate-room',
    });

    const workspaceDir = ownerWorkspacePath('migrate-room');
    fs.mkdirSync(path.dirname(workspaceDir), { recursive: true });
    runGit(['worktree', 'add', workspaceDir, 'HEAD'], canonicalDir);
    fs.writeFileSync(path.join(workspaceDir, 'README.md'), 'detached dirty\n');
    fs.writeFileSync(path.join(workspaceDir, 'NEW_FILE.txt'), 'new file\n');

    const ownerWorkspace = manager.provisionOwnerWorkspaceForPairedTask(
      'paired-task-migrate-new-branch',
    );

    expect(
      runGit(['branch', '--show-current'], ownerWorkspace.workspace_dir),
    ).toBe(ownerBranchName('migrate-room'));
    expect(
      fs.readFileSync(
        path.join(ownerWorkspace.workspace_dir, 'README.md'),
        'utf-8',
      ),
    ).toBe('detached dirty\n');
    expect(
      fs.readFileSync(
        path.join(ownerWorkspace.workspace_dir, 'NEW_FILE.txt'),
        'utf-8',
      ),
    ).toBe('new file\n');
    expect(
      runGit(['status', '--short'], ownerWorkspace.workspace_dir),
    ).toContain('M README.md');
    expect(
      runGit(['status', '--short'], ownerWorkspace.workspace_dir),
    ).toContain('?? NEW_FILE.txt');
  });

  it('lazy-migrates a detached dirty owner workspace onto an existing matching channel branch', async () => {
    const { db, manager } = await loadModules();
    db._initTestDatabase();

    const canonicalDir = path.join(tempRoot, 'canonical');
    initCanonicalRepo(canonicalDir);
    seedPairedTask(db, canonicalDir, {
      taskId: 'paired-task-migrate-existing-branch',
      groupFolder: 'migrate-existing-room',
    });

    runGit(
      ['branch', ownerBranchName('migrate-existing-room'), 'HEAD'],
      canonicalDir,
    );
    const workspaceDir = ownerWorkspacePath('migrate-existing-room');
    fs.mkdirSync(path.dirname(workspaceDir), { recursive: true });
    runGit(['worktree', 'add', workspaceDir, 'HEAD'], canonicalDir);
    fs.writeFileSync(
      path.join(workspaceDir, 'README.md'),
      'detached existing\n',
    );
    fs.writeFileSync(path.join(workspaceDir, 'NOTES.md'), 'keep me\n');

    const ownerWorkspace = manager.provisionOwnerWorkspaceForPairedTask(
      'paired-task-migrate-existing-branch',
    );

    expect(
      runGit(['branch', '--show-current'], ownerWorkspace.workspace_dir),
    ).toBe(ownerBranchName('migrate-existing-room'));
    expect(
      fs.readFileSync(
        path.join(ownerWorkspace.workspace_dir, 'README.md'),
        'utf-8',
      ),
    ).toBe('detached existing\n');
    expect(
      fs.readFileSync(
        path.join(ownerWorkspace.workspace_dir, 'NOTES.md'),
        'utf-8',
      ),
    ).toBe('keep me\n');
  });

  it('auto-repairs a clean named owner workspace onto the expected new channel branch', async () => {
    const { db, manager } = await loadModules();
    db._initTestDatabase();

    const canonicalDir = path.join(tempRoot, 'canonical');
    initCanonicalRepo(canonicalDir);
    seedPairedTask(db, canonicalDir, {
      taskId: 'paired-task-named-branch-repair',
      groupFolder: 'named-repair-room',
    });

    const workspaceDir = ownerWorkspacePath('named-repair-room');
    fs.mkdirSync(path.dirname(workspaceDir), { recursive: true });
    runGit(
      [
        'worktree',
        'add',
        '-b',
        'codex/owner/named-repair-room-sync',
        workspaceDir,
        'HEAD',
      ],
      canonicalDir,
    );

    const ownerWorkspace = manager.provisionOwnerWorkspaceForPairedTask(
      'paired-task-named-branch-repair',
    );

    expect(
      runGit(['branch', '--show-current'], ownerWorkspace.workspace_dir),
    ).toBe(ownerBranchName('named-repair-room'));
    expect(
      fs.readFileSync(
        path.join(ownerWorkspace.workspace_dir, 'README.md'),
        'utf-8',
      ),
    ).toBe('original\n');
  });

  it('auto-repairs a clean named owner workspace onto an existing matching channel branch', async () => {
    const { db, manager } = await loadModules();
    db._initTestDatabase();

    const canonicalDir = path.join(tempRoot, 'canonical');
    initCanonicalRepo(canonicalDir);
    seedPairedTask(db, canonicalDir, {
      taskId: 'paired-task-named-existing-branch-repair',
      groupFolder: 'named-existing-room',
    });

    runGit(
      ['branch', ownerBranchName('named-existing-room'), 'HEAD'],
      canonicalDir,
    );
    const workspaceDir = ownerWorkspacePath('named-existing-room');
    fs.mkdirSync(path.dirname(workspaceDir), { recursive: true });
    runGit(
      [
        'worktree',
        'add',
        '-b',
        'codex/owner/named-existing-room-sync',
        workspaceDir,
        'HEAD',
      ],
      canonicalDir,
    );

    const ownerWorkspace = manager.provisionOwnerWorkspaceForPairedTask(
      'paired-task-named-existing-branch-repair',
    );

    expect(
      runGit(['branch', '--show-current'], ownerWorkspace.workspace_dir),
    ).toBe(ownerBranchName('named-existing-room'));
  });

  it('re-anchors a dirty named owner workspace without touching local changes', async () => {
    const { db, manager } = await loadModules();
    db._initTestDatabase();

    const canonicalDir = path.join(tempRoot, 'canonical');
    initCanonicalRepo(canonicalDir);
    seedPairedTask(db, canonicalDir, {
      taskId: 'paired-task-dirty-named-branch',
      groupFolder: 'dirty-named-room',
    });

    runGit(
      ['branch', ownerBranchName('dirty-named-room'), 'HEAD'],
      canonicalDir,
    );
    const workspaceDir = ownerWorkspacePath('dirty-named-room');
    fs.mkdirSync(path.dirname(workspaceDir), { recursive: true });
    runGit(
      [
        'worktree',
        'add',
        '-b',
        'codex/owner/dirty-named-room-sync',
        workspaceDir,
        'HEAD',
      ],
      canonicalDir,
    );
    fs.writeFileSync(
      path.join(workspaceDir, 'README.md'),
      'dirty named branch\n',
    );
    fs.writeFileSync(path.join(workspaceDir, 'NOTES.md'), 'untracked keep\n');
    const dirtyBefore = runGit(['status', '--short'], workspaceDir);

    const ownerWorkspace = manager.provisionOwnerWorkspaceForPairedTask(
      'paired-task-dirty-named-branch',
    );

    expect(
      runGit(['branch', '--show-current'], ownerWorkspace.workspace_dir),
    ).toBe(ownerBranchName('dirty-named-room'));
    expect(runGit(['status', '--short'], ownerWorkspace.workspace_dir)).toBe(
      dirtyBefore,
    );
    expect(
      fs.readFileSync(
        path.join(ownerWorkspace.workspace_dir, 'README.md'),
        'utf-8',
      ),
    ).toBe('dirty named branch\n');
    expect(
      fs.readFileSync(
        path.join(ownerWorkspace.workspace_dir, 'NOTES.md'),
        'utf-8',
      ),
    ).toBe('untracked keep\n');
    expect(
      runGit(['branch', '--list', 'backup/dirty-named-room-*'], canonicalDir),
    ).toContain('backup/dirty-named-room-current-pre-reanchor-');
  });

  it('re-anchors a clean divergent named owner workspace to the current feature branch head', async () => {
    const { db, manager } = await loadModules();
    db._initTestDatabase();

    const canonicalDir = path.join(tempRoot, 'canonical');
    initCanonicalRepo(canonicalDir);
    seedPairedTask(db, canonicalDir, {
      taskId: 'paired-task-divergent-named-branch',
      groupFolder: 'divergent-named-room',
    });

    runGit(
      ['branch', ownerBranchName('divergent-named-room'), 'HEAD'],
      canonicalDir,
    );
    const workspaceDir = ownerWorkspacePath('divergent-named-room');
    fs.mkdirSync(path.dirname(workspaceDir), { recursive: true });
    runGit(
      [
        'worktree',
        'add',
        '-b',
        'codex/feature-divergent-named-room',
        workspaceDir,
        'HEAD',
      ],
      canonicalDir,
    );
    fs.writeFileSync(path.join(workspaceDir, 'README.md'), 'feature head\n');
    runGit(['add', 'README.md'], workspaceDir);
    runGit(['commit', '-m', 'feature work'], workspaceDir);
    const featureHead = runGit(['rev-parse', 'HEAD'], workspaceDir);

    const ownerWorkspace = manager.provisionOwnerWorkspaceForPairedTask(
      'paired-task-divergent-named-branch',
    );

    expect(
      runGit(['branch', '--show-current'], ownerWorkspace.workspace_dir),
    ).toBe(ownerBranchName('divergent-named-room'));
    expect(
      runGit(
        ['rev-parse', ownerBranchName('divergent-named-room')],
        canonicalDir,
      ),
    ).toBe(featureHead);
    expect(
      fs.readFileSync(
        path.join(ownerWorkspace.workspace_dir, 'README.md'),
        'utf-8',
      ),
    ).toBe('feature head\n');
    expect(runGit(['status', '--short'], ownerWorkspace.workspace_dir)).toBe(
      '',
    );
  });

  it('blocks provisioning when the channel branch is already checked out in another worktree', async () => {
    const { db, manager } = await loadModules();
    db._initTestDatabase();

    const canonicalDir = path.join(tempRoot, 'canonical');
    initCanonicalRepo(canonicalDir);
    seedPairedTask(db, canonicalDir, {
      taskId: 'paired-task-branch-collision',
      groupFolder: 'collision-room',
    });

    const conflictingDir = path.join(tempRoot, 'conflicting-owner');
    runGit(
      [
        'worktree',
        'add',
        '-b',
        ownerBranchName('collision-room'),
        conflictingDir,
        'HEAD',
      ],
      canonicalDir,
    );

    expect(() =>
      manager.provisionOwnerWorkspaceForPairedTask(
        'paired-task-branch-collision',
      ),
    ).toThrow(/already checked out/i);
  });
});
