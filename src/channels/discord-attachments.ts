import fs from 'fs';
import path from 'path';

import { Attachment } from 'discord.js';

import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';

const ATTACHMENTS_DIR = path.join(DATA_DIR, 'attachments');
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const TEXT_ATTACHMENT_NAME_PATTERN =
  /\.(txt|md|json|csv|log|xml|yaml|yml|toml|ini|cfg|conf|sh|bash|zsh|py|js|ts|jsx|tsx|html|css|sql|rs|go|java|c|cpp|h|hpp|rb|php|swift|kt|scala|r|lua|pl|ex|exs|hs|ml|clj|dart|v|zig|nim|ps1|bat|cmd|mjs|cjs)$/i;

async function downloadAttachment(
  att: Attachment,
  defaultExt = '.bin',
): Promise<string> {
  const res = await fetch(att.url);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());

  fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });
  const ext = path.extname(att.name || `file${defaultExt}`) || defaultExt;
  const attachmentId = String(att.id || 'attachment').replace(
    /[^a-zA-Z0-9_-]/g,
    '_',
  );
  const filename = `${Date.now()}-${attachmentId}${ext}`;
  const filePath = path.join(ATTACHMENTS_DIR, filename);
  fs.writeFileSync(filePath, buffer);
  logger.info({ file: filename, size: buffer.length }, 'Attachment downloaded');
  return filePath;
}

function attachmentDefaultExtension(contentType: string): string {
  if (contentType.startsWith('image/')) return '.png';
  if (contentType.startsWith('audio/')) return '.wav';
  if (contentType.startsWith('video/')) return '.mp4';
  if (contentType.startsWith('text/')) return '.txt';
  if (contentType === 'application/pdf') return '.pdf';
  if (
    contentType === 'application/zip' ||
    contentType === 'application/x-zip-compressed'
  ) {
    return '.zip';
  }
  return '.bin';
}

function attachmentLabel(
  contentType: string,
): 'Audio' | 'File' | 'Image' | 'Video' {
  if (contentType.startsWith('image/')) return 'Image';
  if (contentType.startsWith('audio/')) return 'Audio';
  if (contentType.startsWith('video/')) return 'Video';
  return 'File';
}

function isTextAttachment(att: Attachment, contentType: string): boolean {
  return (
    contentType.startsWith('text/') ||
    TEXT_ATTACHMENT_NAME_PATTERN.test(att.name || '')
  );
}

function formatAttachmentReference(
  label: 'Audio' | 'File' | 'Image' | 'Video',
  att: Attachment,
  filePath: string,
): string {
  return `[${label}: ${att.name || 'file'} → ${filePath}]`;
}

function formatUnavailableAttachmentReference(
  label: 'Audio' | 'File' | 'Image' | 'Video',
  att: Attachment,
  filePath: string,
  contentType: string,
): string {
  return `[${label} unavailable: ${att.name || 'file'} → ${filePath} — ${contentType} is not loaded as structured model input]`;
}

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function getDeclaredAttachmentSize(att: Attachment): number | null {
  return typeof att.size === 'number' && Number.isFinite(att.size)
    ? att.size
    : null;
}

function formatTooLargeAttachment(
  label: 'Audio' | 'File' | 'Image' | 'Video',
  att: Attachment,
  size: number,
): string {
  return `[${label}: ${att.name || 'file'} (too large to download: ${formatBytes(size)} > ${formatBytes(MAX_ATTACHMENT_BYTES)})]`;
}

export async function describeDownloadedAttachment(
  att: Attachment,
  contentType: string,
): Promise<string> {
  const label = attachmentLabel(contentType);
  const declaredSize = getDeclaredAttachmentSize(att);
  if (declaredSize != null && declaredSize > MAX_ATTACHMENT_BYTES) {
    logger.warn(
      {
        file: att.name,
        size: declaredSize,
        maxSize: MAX_ATTACHMENT_BYTES,
      },
      'Attachment skipped because it exceeds the download size cap',
    );
    return formatTooLargeAttachment(label, att, declaredSize);
  }

  const filePath = await downloadAttachment(
    att,
    attachmentDefaultExtension(contentType),
  );
  const reference = formatAttachmentReference(label, att, filePath);
  if (!isTextAttachment(att, contentType)) {
    if (label === 'Image') return reference;
    return formatUnavailableAttachmentReference(
      label,
      att,
      filePath,
      contentType,
    );
  }

  let text = fs.readFileSync(filePath, 'utf8');
  const MAX_TEXT_LENGTH = 32_000;
  if (text.length > MAX_TEXT_LENGTH) {
    text =
      text.slice(0, MAX_TEXT_LENGTH) +
      `\n...(truncated, ${text.length} chars total)`;
  }
  return `${reference}\n${text}`;
}
