import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import type { OutboundAttachment, PairedRoomRole } from './types.js';

function sanitizePathSegment(value: string, fallback: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 96);
  return sanitized.replace(/^[.-]+|[.-]+$/g, '') || fallback;
}

function storedAttachmentName(
  attachment: OutboundAttachment,
  sourcePath: string,
  index: number,
): string {
  const sourceBasename = path.basename(sourcePath);
  const displayBasename = attachment.name
    ? path.basename(attachment.name)
    : sourceBasename;
  const ext = path.extname(displayBasename) || path.extname(sourceBasename);
  const stem =
    path.basename(displayBasename, path.extname(displayBasename)) ||
    `attachment-${index + 1}`;
  return `${String(index + 1).padStart(2, '0')}-${sanitizePathSegment(
    stem,
    `attachment-${index + 1}`,
  )}${ext}`;
}

export function persistPairedTurnOutputAttachments(args: {
  taskId: string;
  turnNumber: number;
  role: PairedRoomRole;
  attachments: OutboundAttachment[];
}): OutboundAttachment[] {
  if (args.attachments.length === 0) return [];

  const safeTaskId = sanitizePathSegment(args.taskId, 'task');
  const targetDir = path.join(
    DATA_DIR,
    'attachments',
    'paired-turn-outputs',
    safeTaskId,
    String(args.turnNumber),
    args.role,
  );

  return args.attachments.map((attachment, index) => {
    try {
      if (
        !path.isAbsolute(attachment.path) ||
        !fs.existsSync(attachment.path)
      ) {
        return attachment;
      }
      const sourcePath = fs.realpathSync(attachment.path);
      if (!fs.statSync(sourcePath).isFile()) return attachment;

      fs.mkdirSync(targetDir, { recursive: true });
      const targetPath = path.join(
        targetDir,
        storedAttachmentName(attachment, sourcePath, index),
      );
      if (sourcePath !== path.resolve(targetPath)) {
        fs.copyFileSync(sourcePath, targetPath);
      }
      return {
        ...attachment,
        path: targetPath,
        name: attachment.name
          ? path.basename(attachment.name)
          : path.basename(targetPath),
      };
    } catch {
      return attachment;
    }
  });
}
