import type { MessageSourceKind } from './types.js';

const MESSAGE_SOURCE_KINDS = new Set<MessageSourceKind>([
  'human',
  'bot',
  'trusted_external_bot',
  'ipc_injected_human',
  'ipc_injected_bot',
]);

export function normalizeMessageSourceKind(
  value: unknown,
  fallback: MessageSourceKind = 'human',
): MessageSourceKind {
  return typeof value === 'string' &&
    MESSAGE_SOURCE_KINDS.has(value as MessageSourceKind)
    ? (value as MessageSourceKind)
    : fallback;
}

export function isBotMessageSourceKind(kind: MessageSourceKind): boolean {
  return kind === 'bot' || kind === 'ipc_injected_bot';
}

export function inferMessageSourceKindFromBotFlag(
  isBotMessage: boolean | number | null | undefined,
): MessageSourceKind {
  return isBotMessage ? 'bot' : 'human';
}

export function resolveInjectedMessageSourceKind(args: {
  treatAsHuman: boolean;
  sourceKind?: unknown;
}): MessageSourceKind {
  return normalizeMessageSourceKind(
    args.sourceKind,
    args.treatAsHuman ? 'trusted_external_bot' : 'ipc_injected_bot',
  );
}
