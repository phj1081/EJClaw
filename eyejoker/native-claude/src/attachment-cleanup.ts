import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export interface AttachmentCleanupOptions {
  activePaths: string[];
  nowMs?: number;
  ttlMs: number;
}

function messageDirectory(root: string, filePath: string): string | null {
  const absoluteRoot = resolve(root);
  const absoluteFile = resolve(filePath);
  const rel = relative(absoluteRoot, absoluteFile);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  const first = rel.split(/[\\/]/)[0];
  return first ? join(absoluteRoot, first) : dirname(absoluteFile);
}

export function steeringAttachmentProtectionPaths(root: string, messageIds: string[]): string[] {
  const absoluteRoot = resolve(root);
  return messageIds
    .filter((messageId) => /^[1-9]\d{16,19}$/.test(messageId))
    .map((messageId) => join(absoluteRoot, messageId, ".active"));
}

export function cleanupExpiredAttachmentDirs(
  root: string,
  options: AttachmentCleanupOptions,
): string[] {
  if (!existsSync(root)) return [];
  const absoluteRoot = resolve(root);
  const activeDirs = new Set(
    options.activePaths
      .map((path) => messageDirectory(absoluteRoot, path))
      .filter((path): path is string => Boolean(path)),
  );
  const cutoff = (options.nowMs ?? Date.now()) - Math.max(0, options.ttlMs);
  const deleted: string[] = [];

  for (const entry of readdirSync(absoluteRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(absoluteRoot, entry.name);
    if (activeDirs.has(path)) continue;
    if (statSync(path).mtimeMs > cutoff) continue;
    rmSync(path, { recursive: true, force: true });
    deleted.push(path);
  }
  return deleted.sort();
}
