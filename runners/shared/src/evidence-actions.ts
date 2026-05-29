export const DB_EVIDENCE_ACTIONS = [
  'db_paired_task_status',
  'db_paired_task_flow',
  'db_recent_paired_failures',
  'db_recent_scheduled_tasks',
  'db_scheduled_task_runs',
] as const;

export const DEPLOY_EVIDENCE_ACTIONS = [
  'ejclaw_deploy_state',
  'ejclaw_artifact_metadata',
] as const;

export const GITHUB_EVIDENCE_ACTIONS = [
  'github_pr_status',
  'github_pr_diff_stat',
  'github_run_status',
  'github_run_jobs',
  'github_workflow_file',
] as const;

export const HOST_EVIDENCE_ACTIONS = [
  'ejclaw_service_status',
  'ejclaw_service_logs',
  'ejclaw_role_runtime_config',
  ...DEPLOY_EVIDENCE_ACTIONS,
  ...DB_EVIDENCE_ACTIONS,
  ...GITHUB_EVIDENCE_ACTIONS,
] as const;

export const ARTIFACT_EVIDENCE_KINDS = [
  'build_outputs',
  'dashboard_dist',
  'runner_dist',
  'android_debug_apk',
  'attachments_dir',
] as const;

export type DbEvidenceAction = (typeof DB_EVIDENCE_ACTIONS)[number];
export type DeployEvidenceAction = (typeof DEPLOY_EVIDENCE_ACTIONS)[number];
export type GitHubEvidenceAction = (typeof GITHUB_EVIDENCE_ACTIONS)[number];
export type HostEvidenceAction = (typeof HOST_EVIDENCE_ACTIONS)[number];
export type ArtifactEvidenceKind = (typeof ARTIFACT_EVIDENCE_KINDS)[number];

function includesEvidenceValue<T extends readonly string[]>(
  values: T,
  value: unknown,
): value is T[number] {
  return typeof value === 'string' && values.includes(value as T[number]);
}

export function isDbEvidenceAction(value: unknown): value is DbEvidenceAction {
  return includesEvidenceValue(DB_EVIDENCE_ACTIONS, value);
}

export function isDeployEvidenceAction(
  value: unknown,
): value is DeployEvidenceAction {
  return includesEvidenceValue(DEPLOY_EVIDENCE_ACTIONS, value);
}

export function isGitHubEvidenceAction(
  value: unknown,
): value is GitHubEvidenceAction {
  return includesEvidenceValue(GITHUB_EVIDENCE_ACTIONS, value);
}

export function isHostEvidenceAction(
  value: unknown,
): value is HostEvidenceAction {
  return includesEvidenceValue(HOST_EVIDENCE_ACTIONS, value);
}

export function isArtifactEvidenceKind(
  value: unknown,
): value is ArtifactEvidenceKind {
  return includesEvidenceValue(ARTIFACT_EVIDENCE_KINDS, value);
}
