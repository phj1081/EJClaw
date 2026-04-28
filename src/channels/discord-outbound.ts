import path from 'path';

import {
  extractImageTagPaths,
  normalizeEjclawStructuredOutput,
} from '../agent-protocol.js';
import type { OutboundAttachment } from '../types.js';

const IMAGE_EXTS = /\.(png|jpe?g|gif|webp|bmp)$/i;
const MD_LINK_RE = /\[[^\]]*\]\((\/[^)]+)\)/g;

export interface PreparedDiscordOutbound {
  text: string;
  cleanText: string;
  attachments: OutboundAttachment[];
  attachmentSource: 'structured' | 'md-link' | 'image-tag' | 'none';
  silent: boolean;
}

function extractMarkdownImageAttachments(text: string): {
  cleanText: string;
  attachments: OutboundAttachment[];
} {
  const attachments: OutboundAttachment[] = [];
  const seen = new Set<string>();

  const cleanText = text.replace(MD_LINK_RE, (_full, rawPath: string) => {
    const trimmed = rawPath.trim();
    if (IMAGE_EXTS.test(trimmed)) {
      if (!seen.has(trimmed)) {
        attachments.push({
          path: trimmed,
          name: path.basename(trimmed),
        });
        seen.add(trimmed);
      }
      return '';
    }

    const basename = path.basename(trimmed.replace(/#.*$/, ''));
    const lineMatch = trimmed.match(/#L(\d+)/);
    return lineMatch ? `\`${basename}:${lineMatch[1]}\`` : `\`${basename}\``;
  });

  return { cleanText, attachments };
}

function imageTagPathsToAttachments(paths: string[]): OutboundAttachment[] {
  return paths
    .filter((filePath) => IMAGE_EXTS.test(filePath))
    .map((filePath) => ({
      path: filePath,
      name: path.basename(filePath),
    }));
}

export function prepareDiscordOutbound(
  text: string,
  optionAttachments: OutboundAttachment[] | undefined,
): PreparedDiscordOutbound {
  const normalized = normalizeEjclawStructuredOutput(text);
  if (normalized.output?.visibility === 'silent') {
    return {
      text: '',
      cleanText: '',
      attachments: [],
      attachmentSource: 'none',
      silent: true,
    };
  }

  const structuredOutput =
    normalized.output?.visibility === 'public' ? normalized.output : null;
  const outboundText = structuredOutput?.text ?? normalized.result ?? text;
  const structuredAttachments =
    optionAttachments && optionAttachments.length > 0
      ? optionAttachments
      : (structuredOutput?.attachments ?? []);
  const hasStructuredAttachments = structuredAttachments.length > 0;
  const markdownExtracted = extractMarkdownImageAttachments(outboundText);
  const imageTagExtracted = extractImageTagPaths(markdownExtracted.cleanText);
  const legacyImageTagAttachments = imageTagPathsToAttachments(
    imageTagExtracted.imagePaths,
  );

  return {
    text: outboundText,
    cleanText: imageTagExtracted.cleanText,
    attachments: hasStructuredAttachments
      ? structuredAttachments
      : [...markdownExtracted.attachments, ...legacyImageTagAttachments],
    attachmentSource: hasStructuredAttachments
      ? 'structured'
      : markdownExtracted.attachments.length > 0
        ? 'md-link'
        : legacyImageTagAttachments.length > 0
          ? 'image-tag'
          : 'none',
    silent: false,
  };
}
