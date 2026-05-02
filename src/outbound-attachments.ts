import fs from 'fs';
import os from 'os';
import path from 'path';

import { DATA_DIR } from './config.js';
import { getEnv } from './env.js';
import type { OutboundAttachment } from './types.js';

export interface ValidatedOutboundAttachment {
  attachment: string;
  name: string;
}

export interface ValidateOutboundAttachmentsResult {
  files: ValidatedOutboundAttachment[];
  rejected: Array<{ path: string; reason: string }>;
}

const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const IMAGE_EXTS = /\.(png|jpe?g|gif|webp|bmp)$/i;
function unique(values: Array<string | null | undefined>): string[] {
  return [
    ...new Set(values.filter((value): value is string => Boolean(value))),
  ];
}

function resolveExistingDir(dir: string): string | null {
  try {
    if (!fs.existsSync(dir)) return null;
    return fs.realpathSync(dir);
  } catch {
    return null;
  }
}

function expandHomeDir(dir: string): string {
  const home = getEnv('HOME') || os.homedir();
  if (dir === '~') return home;
  if (dir.startsWith(`~${path.sep}`)) return path.join(home, dir.slice(2));
  return dir;
}

export function getConfiguredAttachmentBaseDirs(): string[] {
  const raw = getEnv('EJCLAW_ATTACHMENT_ALLOWED_DIRS') ?? '';
  return unique(
    raw
      .split(/[,\n]/)
      .flatMap((part) => part.split(path.delimiter))
      .map((value) => value.trim())
      .filter(Boolean)
      .map(expandHomeDir),
  );
}

export function getDefaultAttachmentBaseDirs(): string[] {
  const home = getEnv('HOME');
  const codexHome =
    getEnv('CODEX_HOME') || (home ? path.join(home, '.codex') : null);
  // Keep defaults narrow. Runtime-specific workspaces must be passed via
  // attachmentBaseDirs so one room cannot attach another room's files by path.
  // Ad-hoc generated files under os.tmpdir() are handled separately after
  // resolving symlinks, without allowlisting all of /tmp recursively.
  return unique([
    path.join(DATA_DIR, 'attachments'),
    codexHome ? path.join(codexHome, 'generated_images') : null,
    ...getConfiguredAttachmentBaseDirs(),
  ])
    .map(resolveExistingDir)
    .filter((dir): dir is string => Boolean(dir));
}

function isWithinBaseDir(realPath: string, baseDir: string): boolean {
  const relative = path.relative(baseDir, realPath);
  return (
    relative === '' ||
    (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function matchesAllowedBaseDir(realPath: string, baseDirs: string[]): boolean {
  return baseDirs.some((baseDir) => isWithinBaseDir(realPath, baseDir));
}

function isWithinTempDir(realPath: string, tempDir: string | null): boolean {
  if (!tempDir) return false;
  const relative = path.relative(tempDir, realPath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return false;
  }
  return true;
}

function detectImageMime(filePath: string): string | null {
  const handle = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(512);
    const bytesRead = fs.readSync(handle, buffer, 0, buffer.length, 0);
    const header = buffer.subarray(0, bytesRead);
    if (
      header
        .subarray(0, 8)
        .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    ) {
      return 'image/png';
    }
    if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
      return 'image/jpeg';
    }
    if (
      header.subarray(0, 6).toString('ascii') === 'GIF87a' ||
      header.subarray(0, 6).toString('ascii') === 'GIF89a'
    ) {
      return 'image/gif';
    }
    if (
      header.subarray(0, 4).toString('ascii') === 'RIFF' &&
      header.subarray(8, 12).toString('ascii') === 'WEBP'
    ) {
      return 'image/webp';
    }
    if (header[0] === 0x42 && header[1] === 0x4d) {
      return 'image/bmp';
    }
    return null;
  } finally {
    fs.closeSync(handle);
  }
}

function normalizeAttachmentName(
  attachment: OutboundAttachment,
  realPath: string,
): string {
  const candidate = attachment.name
    ? path.basename(attachment.name)
    : path.basename(realPath);
  return candidate || 'attachment';
}

export function validateOutboundAttachments(
  attachments: OutboundAttachment[] | undefined,
  options: { baseDirs?: string[] } = {},
): ValidateOutboundAttachmentsResult {
  const baseDirs = unique([
    ...getDefaultAttachmentBaseDirs(),
    ...(options.baseDirs ?? []).map(resolveExistingDir),
  ]).filter((dir): dir is string => Boolean(dir));
  const defaultTempDir = resolveExistingDir(os.tmpdir());
  const files: ValidatedOutboundAttachment[] = [];
  const rejected: Array<{ path: string; reason: string }> = [];
  const seen = new Set<string>();

  for (const attachment of attachments ?? []) {
    const requestedPath = attachment.path;
    try {
      if (!path.isAbsolute(requestedPath)) {
        rejected.push({ path: requestedPath, reason: 'not-absolute' });
        continue;
      }
      if (!IMAGE_EXTS.test(requestedPath)) {
        rejected.push({ path: requestedPath, reason: 'unsupported-extension' });
        continue;
      }
      if (!fs.existsSync(requestedPath)) {
        rejected.push({ path: requestedPath, reason: 'not-found' });
        continue;
      }
      const realPath = fs.realpathSync(requestedPath);
      if (seen.has(realPath)) continue;
      const stat = fs.statSync(realPath);
      if (!stat.isFile()) {
        rejected.push({ path: requestedPath, reason: 'not-file' });
        continue;
      }
      if (stat.size > MAX_ATTACHMENT_BYTES) {
        rejected.push({ path: requestedPath, reason: 'too-large' });
        continue;
      }
      if (
        !matchesAllowedBaseDir(realPath, baseDirs) &&
        !isWithinTempDir(realPath, defaultTempDir)
      ) {
        rejected.push({ path: requestedPath, reason: 'outside-allowed-dirs' });
        continue;
      }
      const detectedMime = detectImageMime(realPath);
      if (!detectedMime) {
        rejected.push({
          path: requestedPath,
          reason: 'invalid-image-signature',
        });
        continue;
      }
      if (attachment.mime && attachment.mime !== detectedMime) {
        rejected.push({ path: requestedPath, reason: 'mime-mismatch' });
        continue;
      }
      files.push({
        attachment: realPath,
        name: normalizeAttachmentName(attachment, realPath),
      });
      seen.add(realPath);
    } catch {
      rejected.push({ path: requestedPath, reason: 'validation-error' });
    }
  }

  return { files, rejected };
}
