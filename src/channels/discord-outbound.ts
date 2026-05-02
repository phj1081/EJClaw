import path from 'path';

import { normalizeAgentOutput } from '../agent-protocol.js';
import type { OutboundAttachment } from '../types.js';

const LOCAL_MARKDOWN_LINK_RE = /\[[^\]\n]*\]\((\/[^)\n]+)\)/g;

export interface PreparedDiscordOutbound {
  text: string;
  cleanText: string;
  attachments: OutboundAttachment[];
  attachmentSource: 'structured' | 'md-link' | 'image-tag' | 'mixed' | 'none';
  silent: boolean;
}

function sanitizeLocalMarkdownLinks(text: string): string {
  return text.replace(LOCAL_MARKDOWN_LINK_RE, (_full, rawPath: string) => {
    const trimmed = rawPath.trim();
    const basename = path.basename(trimmed.replace(/#.*$/, ''));
    const lineMatch = trimmed.match(/#L(\d+)/);
    return lineMatch ? `\`${basename}:${lineMatch[1]}\`` : `\`${basename}\``;
  });
}

export function prepareDiscordOutbound(
  text: string,
  optionAttachments: OutboundAttachment[] | undefined,
): PreparedDiscordOutbound {
  const normalized = normalizeAgentOutput(text);
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
  const cleanText = sanitizeLocalMarkdownLinks(outboundText);
  const attachments =
    optionAttachments && optionAttachments.length > 0
      ? optionAttachments
      : (structuredOutput?.attachments ?? []);
  const hasAttachments = attachments.length > 0;
  const attachmentSource =
    optionAttachments && optionAttachments.length > 0
      ? 'structured'
      : normalized.attachmentSource === 'legacy-ejclaw-json'
        ? 'structured'
        : normalized.attachmentSource === 'markdown-image'
          ? 'md-link'
          : (normalized.attachmentSource ?? 'none');

  return {
    text: outboundText,
    cleanText,
    attachments,
    attachmentSource: hasAttachments ? attachmentSource : 'none',
    silent: false,
  };
}
