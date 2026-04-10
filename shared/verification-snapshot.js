import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

export const VERIFICATION_SNAPSHOT_EXCLUDE_NAMES = new Set(['node_modules']);

const VERIFICATION_SNAPSHOT_ROOT_EXCLUDE_NAMES = new Set([
  '.git',
  '.env',
  'dist',
  'data',
  'logs',
  'cache',
  '.ejclaw-reviewer-runtime',
]);

const VERIFICATION_SNAPSHOT_ROOT_EXCLUDE_PREFIXES = ['store.local-backup-'];

export function isVerificationSnapshotExcludedName(name) {
  return VERIFICATION_SNAPSHOT_EXCLUDE_NAMES.has(name);
}

export function isVerificationSnapshotExcludedPath(repoDir, currentPath) {
  const name = path.basename(currentPath);
  if (isVerificationSnapshotExcludedName(name)) {
    return true;
  }

  const relPath = path.relative(repoDir, currentPath);
  const isRepoRootEntry = relPath !== '' && !relPath.includes(path.sep);
  if (!isRepoRootEntry) {
    return false;
  }

  return (
    VERIFICATION_SNAPSHOT_ROOT_EXCLUDE_NAMES.has(name) ||
    VERIFICATION_SNAPSHOT_ROOT_EXCLUDE_PREFIXES.some((prefix) =>
      name.startsWith(prefix),
    )
  );
}

function updateVerificationSnapshotHash(hash, repoDir, currentPath) {
  const relPath = path.relative(repoDir, currentPath) || '.';
  const stat = fs.lstatSync(currentPath);

  if (stat.isDirectory()) {
    if (relPath !== '.') {
      hash.update(`dir\0${relPath}\0`);
    }
    for (const entry of fs.readdirSync(currentPath).sort()) {
      const nextPath = path.join(currentPath, entry);
      if (isVerificationSnapshotExcludedPath(repoDir, nextPath)) continue;
      updateVerificationSnapshotHash(hash, repoDir, nextPath);
    }
    return;
  }

  if (stat.isSymbolicLink()) {
    hash.update(`symlink\0${relPath}\0${fs.readlinkSync(currentPath)}\0`);
    return;
  }

  if (stat.isFile()) {
    hash.update(`file\0${relPath}\0`);
    hash.update(fs.readFileSync(currentPath));
    hash.update('\0');
  }
}

export function computeVerificationSnapshotId(repoDir) {
  const hash = createHash('sha256');
  updateVerificationSnapshotHash(hash, repoDir, repoDir);
  return `fs:${hash.digest('hex').slice(0, 24)}`;
}
