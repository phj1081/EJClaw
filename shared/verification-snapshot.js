import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

export const VERIFICATION_SNAPSHOT_EXCLUDE_NAMES = new Set([
  '.git',
  'node_modules',
  '.env',
]);

export function isVerificationSnapshotExcludedName(name) {
  return VERIFICATION_SNAPSHOT_EXCLUDE_NAMES.has(name);
}

function updateVerificationSnapshotHash(hash, repoDir, currentPath) {
  const relPath = path.relative(repoDir, currentPath) || '.';
  const stat = fs.lstatSync(currentPath);

  if (stat.isDirectory()) {
    if (relPath !== '.') {
      hash.update(`dir\0${relPath}\0`);
    }
    for (const entry of fs.readdirSync(currentPath).sort()) {
      if (isVerificationSnapshotExcludedName(entry)) continue;
      updateVerificationSnapshotHash(hash, repoDir, path.join(currentPath, entry));
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

export function resolveVerificationResponsesDir(hostIpcDir) {
  return path.join(hostIpcDir, 'verification-responses');
}
