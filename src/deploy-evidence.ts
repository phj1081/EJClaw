import { createHash } from 'crypto';
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import {
  ARTIFACT_EVIDENCE_KINDS,
  DEPLOY_EVIDENCE_ACTIONS,
  isArtifactEvidenceKind,
  isDeployEvidenceAction,
  type ArtifactEvidenceKind,
  type DeployEvidenceAction,
} from 'ejclaw-runners-shared';

export {
  ARTIFACT_EVIDENCE_KINDS,
  DEPLOY_EVIDENCE_ACTIONS,
  isDeployEvidenceAction,
  type ArtifactEvidenceKind,
  type DeployEvidenceAction,
};

export interface DeployEvidenceRequest {
  action: DeployEvidenceAction;
  artifactKind?: string;
}

export interface DeployEvidencePaths {
  projectRoot: string;
  dataDir: string;
  dashboardStaticDir: string;
}

const COMMAND_TIMEOUT_MS = 5_000;
const COMMAND_MAX_BUFFER = 1024 * 1024;
const MAX_DIR_ENTRIES = 5_000;
const MAX_LATEST_FILES = 12;

export function normalizeArtifactEvidenceKind(
  value?: string,
): ArtifactEvidenceKind {
  if (!value) return 'build_outputs';
  if (isArtifactEvidenceKind(value)) {
    return value;
  }
  throw new Error(`Unsupported artifact evidence kind: ${value}`);
}

function execFileText(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        encoding: 'utf8',
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: COMMAND_MAX_BUFFER,
      },
      (error, stdout, stderr) => {
        if (error) {
          const details = stderr?.trim() || stdout?.trim() || error.message;
          reject(new Error(`${file} ${args.join(' ')} failed: ${details}`));
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

function sha256File(filePath: string): string {
  const hash = createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function fileMetadata(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) {
    return {
      path: filePath,
      exists: false,
    };
  }

  const stat = fs.statSync(filePath);
  const base = {
    path: filePath,
    exists: true,
    type: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other',
    size_bytes: stat.size,
    mtime: stat.mtime.toISOString(),
  };

  if (!stat.isFile()) {
    return base;
  }

  return {
    ...base,
    sha256: sha256File(filePath),
  };
}

function walkDirectory(root: string): Array<{ path: string; stat: fs.Stats }> {
  if (!fs.existsSync(root)) return [];
  const pending = [root];
  const files: Array<{ path: string; stat: fs.Stats }> = [];

  while (pending.length > 0 && files.length < MAX_DIR_ENTRIES) {
    const current = pending.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      if (!entry.isFile()) continue;
      files.push({ path: entryPath, stat: fs.statSync(entryPath) });
      if (files.length >= MAX_DIR_ENTRIES) break;
    }
  }

  return files;
}

function directoryMetadata(root: string): Record<string, unknown> {
  if (!fs.existsSync(root)) {
    return {
      path: root,
      exists: false,
    };
  }
  const files = walkDirectory(root);
  const totalBytes = files.reduce((sum, file) => sum + file.stat.size, 0);
  const latestFiles = [...files]
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
    .slice(0, MAX_LATEST_FILES)
    .map((file) => ({
      relative_path: path.relative(root, file.path),
      size_bytes: file.stat.size,
      mtime: file.stat.mtime.toISOString(),
    }));

  return {
    path: root,
    exists: true,
    file_count: files.length,
    total_bytes: totalBytes,
    truncated: files.length >= MAX_DIR_ENTRIES,
    latest_files: latestFiles,
  };
}

function buildOutputArtifacts(
  paths: DeployEvidencePaths,
): Record<string, unknown> {
  return {
    root_dist: fileMetadata(path.join(paths.projectRoot, 'dist', 'index.js')),
    dashboard_index: fileMetadata(
      path.join(paths.dashboardStaticDir, 'index.html'),
    ),
    dashboard_assets: directoryMetadata(
      path.join(paths.dashboardStaticDir, 'assets'),
    ),
    agent_runner: fileMetadata(
      path.join(
        paths.projectRoot,
        'runners',
        'agent-runner',
        'dist',
        'index.js',
      ),
    ),
    codex_runner: fileMetadata(
      path.join(
        paths.projectRoot,
        'runners',
        'codex-runner',
        'dist',
        'index.js',
      ),
    ),
  };
}

export async function collectDeployState(
  paths: DeployEvidencePaths,
): Promise<string> {
  const [head, logLine, status] = await Promise.all([
    execFileText('git', ['-C', paths.projectRoot, 'rev-parse', 'HEAD']),
    execFileText('git', [
      '-C',
      paths.projectRoot,
      'log',
      '-1',
      '--oneline',
      '--decorate',
    ]),
    execFileText('git', ['-C', paths.projectRoot, 'status', '--short']),
  ]);

  return JSON.stringify(
    {
      action: 'ejclaw_deploy_state',
      project_root: paths.projectRoot,
      git: {
        head,
        log: logLine,
        dirty: status.length > 0,
        status_short: status,
      },
      artifacts: buildOutputArtifacts(paths),
    },
    null,
    2,
  );
}

export function collectArtifactMetadata(
  paths: DeployEvidencePaths,
  request: DeployEvidenceRequest,
): string {
  const kind = normalizeArtifactEvidenceKind(request.artifactKind);
  const payload =
    kind === 'build_outputs'
      ? buildOutputArtifacts(paths)
      : kind === 'dashboard_dist'
        ? directoryMetadata(paths.dashboardStaticDir)
        : kind === 'runner_dist'
          ? {
              agent_runner: directoryMetadata(
                path.join(paths.projectRoot, 'runners', 'agent-runner', 'dist'),
              ),
              codex_runner: directoryMetadata(
                path.join(paths.projectRoot, 'runners', 'codex-runner', 'dist'),
              ),
            }
          : kind === 'android_debug_apk'
            ? fileMetadata(
                path.join(
                  paths.projectRoot,
                  'apps',
                  'android',
                  'app',
                  'build',
                  'outputs',
                  'apk',
                  'debug',
                  'app-debug.apk',
                ),
              )
            : directoryMetadata(path.join(paths.dataDir, 'attachments'));

  return JSON.stringify(
    {
      action: 'ejclaw_artifact_metadata',
      artifact_kind: kind,
      payload,
    },
    null,
    2,
  );
}
