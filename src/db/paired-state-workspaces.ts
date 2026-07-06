import { Database } from 'bun:sqlite';

import { PairedProject, PairedWorkspace } from '../types.js';

export function upsertPairedProjectInDatabase(
  database: Database,
  project: PairedProject,
): void {
  database
    .prepare(
      `
        INSERT INTO paired_projects (
          chat_jid,
          group_folder,
          canonical_work_dir,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(chat_jid) DO UPDATE SET
          group_folder = excluded.group_folder,
          canonical_work_dir = excluded.canonical_work_dir,
          updated_at = excluded.updated_at
      `,
    )
    .run(
      project.chat_jid,
      project.group_folder,
      project.canonical_work_dir,
      project.created_at,
      project.updated_at,
    );
}

export function getPairedProjectFromDatabase(
  database: Database,
  chatJid: string,
): PairedProject | undefined {
  return database
    .prepare('SELECT * FROM paired_projects WHERE chat_jid = ?')
    .get(chatJid) as PairedProject | undefined;
}

export function upsertPairedWorkspaceInDatabase(
  database: Database,
  workspace: PairedWorkspace,
): void {
  database
    .prepare(
      `
        INSERT INTO paired_workspaces (
          id,
          task_id,
          role,
          workspace_dir,
          snapshot_source_dir,
          snapshot_ref,
          status,
          snapshot_refreshed_at,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          workspace_dir = excluded.workspace_dir,
          snapshot_source_dir = excluded.snapshot_source_dir,
          snapshot_ref = excluded.snapshot_ref,
          status = excluded.status,
          snapshot_refreshed_at = excluded.snapshot_refreshed_at,
          updated_at = excluded.updated_at
      `,
    )
    .run(
      workspace.id,
      workspace.task_id,
      workspace.role,
      workspace.workspace_dir,
      workspace.snapshot_source_dir,
      workspace.snapshot_ref,
      workspace.status,
      workspace.snapshot_refreshed_at,
      workspace.created_at,
      workspace.updated_at,
    );
}

export function getPairedWorkspaceFromDatabase(
  database: Database,
  taskId: string,
  role: PairedWorkspace['role'],
): PairedWorkspace | undefined {
  return database
    .prepare('SELECT * FROM paired_workspaces WHERE task_id = ? AND role = ?')
    .get(taskId, role) as PairedWorkspace | undefined;
}

export function listPairedWorkspacesForTaskFromDatabase(
  database: Database,
  taskId: string,
): PairedWorkspace[] {
  return database
    .prepare(
      'SELECT * FROM paired_workspaces WHERE task_id = ? ORDER BY created_at',
    )
    .all(taskId) as PairedWorkspace[];
}
