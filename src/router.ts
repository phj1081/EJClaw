import { Channel, NewMessage } from './types.js';
import { formatLocalTime } from './timezone.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMessages(
  messages: NewMessage[],
  timezone: string,
): string {
  const lines = messages.map((m) => {
    const displayTime = formatLocalTime(m.timestamp, timezone);
    return `<message sender="${escapeXml(m.sender_name)}" time="${escapeXml(displayTime)}">${escapeXml(m.content)}</message>`;
  });

  const header = `<context timezone="${escapeXml(timezone)}" />\n`;

  return `${header}<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

/**
 * Patterns that match common API keys / tokens.
 * Matched strings are replaced with `[REDACTED]`.
 */
const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{20,}/g, // Anthropic
  /sk-[A-Za-z0-9_-]{20,}/g, // OpenAI
  /gsk_[A-Za-z0-9_-]{20,}/g, // Groq
  /xai-[A-Za-z0-9_-]{20,}/g, // xAI
  /ghp_[A-Za-z0-9_]{36,}/g, // GitHub PAT classic
  /github_pat_[A-Za-z0-9_]{20,}/g, // GitHub PAT fine-grained
  /glpat-[A-Za-z0-9_-]{20,}/g, // GitLab PAT
  /AKIA[A-Z0-9]{16}/g, // AWS Access Key
  /Bearer\s+eyJ[A-Za-z0-9_-]{40,}/g, // Bearer JWT
];

function redactSecrets(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, '[REDACTED]');
  }
  return result;
}

/**
 * Strip leaked tool-call serialization text.
 *
 * When a model (especially Codex) enters a degenerate loop, it emits
 * tool-call intent as plaintext instead of actual tool calls.  The format is:
 *   to=functions.<name> <arbitrary tokens> {<json>}
 * e.g. `to=functions.exec_command code {"cmd":"git status","yield_time_ms":1000}`
 *
 * The tokens between the function name and JSON body can include non-ASCII
 * characters (CJK, etc.) when the model hallucinates. The regex allows one or
 * more non-whitespace descriptor tokens before the JSON brace.
 *
 * This function removes such fragments so they never reach Discord.
 */
export function stripToolCallLeaks(text: string): string {
  // Match tool-call serialization: to=functions.<name> <descriptor tokens> {<json>}
  // Handles up to one level of nested braces in the JSON body.
  const stripped = text.replace(
    /to=functions\.\w+(?:\s+[^\s{}]+)+\s+\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g,
    '',
  );
  // Collapse excessive blank lines left after stripping
  return stripped.replace(/\n{3,}/g, '\n\n').trim();
}

export function formatOutbound(rawText: string): string {
  let text = stripInternalTags(rawText);
  if (!text) return '';
  text = stripToolCallLeaks(text);
  if (!text) return '';
  return redactSecrets(text);
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}

export interface DeliveryRouteResolution {
  channel?: Channel;
  requestedRoleChannelName: string | null;
  selectedChannelName: string | null;
  usedRoleChannel: boolean;
  fallbackUsed: boolean;
}

function resolveRequestedRoleChannelName(senderRole?: string): string | null {
  if (senderRole === 'reviewer') return 'discord-review';
  if (senderRole === 'arbiter') return 'discord-arbiter';
  return null;
}

export function resolveChannelForDeliveryRole(
  channels: Channel[],
  jid: string,
  senderRole?: string,
): DeliveryRouteResolution {
  const requestedRoleChannelName = resolveRequestedRoleChannelName(senderRole);
  if (!requestedRoleChannelName) {
    const channel = findChannel(channels, jid);
    return {
      channel,
      requestedRoleChannelName,
      selectedChannelName: channel?.name ?? null,
      usedRoleChannel: false,
      fallbackUsed: false,
    };
  }

  const roleChannel = findChannelByName(channels, requestedRoleChannelName);
  if (roleChannel) {
    return {
      channel: roleChannel,
      requestedRoleChannelName,
      selectedChannelName: roleChannel.name,
      usedRoleChannel: true,
      fallbackUsed: false,
    };
  }

  const fallbackChannel = findChannel(channels, jid);
  return {
    channel: fallbackChannel,
    requestedRoleChannelName,
    selectedChannelName: fallbackChannel?.name ?? null,
    usedRoleChannel: false,
    fallbackUsed: true,
  };
}

export function findChannelForDeliveryRole(
  channels: Channel[],
  jid: string,
  senderRole?: string,
): Channel | undefined {
  return resolveChannelForDeliveryRole(channels, jid, senderRole).channel;
}

export function findChannelByName(
  channels: Channel[],
  name: string,
): Channel | undefined {
  return channels.find((c) => c.name === name);
}

/**
 * Normalize message text for deduplication comparison.
 * - Trim leading/trailing whitespace
 * - Collapse consecutive whitespace/newlines into single space
 */
export function normalizeMessageForDedupe(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}
