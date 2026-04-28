import fs from 'fs';
import path from 'path';

import { validateOutboundAttachments } from './outbound-attachments.js';

function attachmentJsonResponse(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
}

function getAttachmentContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.bmp') return 'image/bmp';
  return 'application/octet-stream';
}

export function serveValidatedAttachment(url: URL): Response {
  const requestedPath = url.searchParams.get('path');
  if (!requestedPath) {
    return attachmentJsonResponse(
      { error: 'Missing attachment path' },
      { status: 400 },
    );
  }

  const validation = validateOutboundAttachments([{ path: requestedPath }]);
  const file = validation.files[0];
  if (!file) {
    return attachmentJsonResponse(
      { error: 'Attachment not found or not allowed' },
      { status: 404 },
    );
  }

  return new Response(fs.readFileSync(file.attachment), {
    headers: {
      'content-type': getAttachmentContentType(file.attachment),
      'cache-control': 'private, max-age=300',
    },
  });
}
