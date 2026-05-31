import fs from 'fs';
import path from 'path';

import {
  expandPromptAttachmentReferences,
  extractImageTagPaths,
  imageTagCaption,
  missingImageTagCaption,
  splitImageTagPromptParts,
} from 'ejclaw-runners-shared';

import type { AppServerInputItem } from './app-server-client.js';

const SUPPORTED_LOCAL_IMAGE_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
]);

export function parseAppServerInput(
  text: string,
  log: (message: string) => void = () => undefined,
): AppServerInputItem[] {
  const expandedText = expandPromptAttachmentReferences(text);
  const { imagePaths } = extractImageTagPaths(expandedText);
  const input: AppServerInputItem[] = [];
  const pushText = (value: string) => {
    const trimmed = value.trim();
    if (trimmed) input.push({ type: 'text', text: trimmed });
  };

  if (imagePaths.length > 0) {
    for (const part of splitImageTagPromptParts(expandedText)) {
      if (part.type === 'text') {
        pushText(part.text);
        continue;
      }
      if (!fs.existsSync(part.path)) {
        log(`Image not found, skipping: ${part.path}`);
        pushText(missingImageTagCaption(part, 'file not found'));
        continue;
      }

      const ext = path.extname(part.path).toLowerCase();
      if (!SUPPORTED_LOCAL_IMAGE_EXTENSIONS.has(ext)) {
        log(`Unsupported image type, skipping: ${part.path}`);
        pushText(
          missingImageTagCaption(
            part,
            `unsupported image type ${ext || 'unknown'}`,
          ),
        );
        continue;
      }

      pushText(imageTagCaption(part));
      input.push({ type: 'localImage', path: part.path });
      log(`Adding image input: ${part.path}`);
    }
  } else if (expandedText) {
    input.push({ type: 'text', text: expandedText });
  }

  if (input.length === 0) {
    input.push({ type: 'text', text });
  }

  return input;
}
