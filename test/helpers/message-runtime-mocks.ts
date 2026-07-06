import { vi } from 'vitest';

/**
 * Module mock factories shared by the src/message-runtime-*.test.ts split
 * files. Each test file must still call vi.mock(...) at its own top level
 * (vitest hoists mocks per file) and delegate to these factories via a
 * dynamic import inside the mock callback.
 */

export const createAgentRunnerMock = () => ({
  runAgentProcess: vi.fn(),
  writeGroupsSnapshot: vi.fn(),
  writeTasksSnapshot: vi.fn(),
});

export const createConfigMock = () => ({
  DATA_DIR: '/tmp/ejclaw-test-data',
  SERVICE_ID: 'claude',
  SERVICE_SESSION_SCOPE: 'claude',
  CODEX_MAIN_SERVICE_ID: 'codex-main',
  CODEX_REVIEW_SERVICE_ID: 'codex-review',
  REVIEWER_AGENT_TYPE: 'claude-code',
  ARBITER_AGENT_TYPE: undefined,
  shouldForceFreshClaudeReviewerSessionInUnsafeHostMode: vi.fn(() => false),
  normalizeServiceId: vi.fn((serviceId: string) => serviceId),
  isClaudeService: vi.fn(() => true),
  isReviewService: vi.fn(() => false),
  isSessionCommandSenderAllowed: vi.fn(() => false),
  getMoaConfig: vi.fn(() => ({
    enabled: false,
    referenceModels: [],
    aggregator: {},
  })),
  TIMEZONE: 'Asia/Seoul',
});

export const createPairedExecutionContextMock = () => ({
  preparePairedExecutionContext: vi.fn(() => undefined),
  completePairedExecutionContext: vi.fn(),
  resolveOwnerTaskForHumanMessage: vi.fn(
    (args?: { existingTask?: unknown }) => ({
      task: args?.existingTask ?? null,
      supersededTask: null,
    }),
  ),
});

export const createDbMock = () => {
  const getOpenWorkItem = vi.fn(
    (
      _chatJid?: string,
      _agentType?: 'claude-code' | 'codex',
      _serviceId?: string,
    ) => undefined,
  );
  const getMessagesSince = vi.fn(
    (
      _chatJid?: string,
      _sinceCursor?: string,
      _botPrefix?: string,
      _limit?: number,
    ) => [],
  );
  const getNewMessages = vi.fn(
    (
      _jids?: string[],
      _lastSeqCursor?: string,
      _botPrefix?: string,
      _limit?: number,
    ) => ({ messages: [], newSeqCursor: '0' }),
  );
  const withSeqs = (messages: Array<Record<string, unknown>>) =>
    messages.map((message, index) => ({
      ...message,
      seq: typeof message.seq === 'number' ? message.seq : index + 1,
    }));
  const pairedTurnReservations = new Set<string>();
  const claimedTaskRevisions = new Set<string>();
  const buildReservationKey = (args: {
    chatJid: string;
    taskId: string;
    taskUpdatedAt: string;
    intentKind: string;
  }) =>
    [args.chatJid, args.taskId, args.taskUpdatedAt, args.intentKind].join(':');

  return {
    claimServiceHandoff: vi.fn(() => true),
    completeServiceHandoff: vi.fn(),
    completeServiceHandoffAndAdvanceTargetCursor: vi.fn(),
    completePairedTurn: vi.fn(),
    failServiceHandoff: vi.fn(),
    failPairedTurn: vi.fn(),
    getAllChats: vi.fn(() => []),
    getAllTasks: vi.fn(() => []),
    getAllPendingServiceHandoffs: vi.fn(() => []),
    getLastHumanMessageTimestamp: vi.fn(() => null),
    getLastHumanMessageContent: vi.fn(() => null),
    getMessagesSince,
    getNewMessages,
    getLatestMessageSeqAtOrBefore: vi.fn(() => 0),
    getMessagesSinceSeq: vi.fn(
      (
        chatJid: string,
        sinceSeqCursor: string,
        botPrefix: string,
        limit?: number,
      ) =>
        withSeqs(getMessagesSince(chatJid, sinceSeqCursor, botPrefix, limit)),
    ),
    getNewMessagesBySeq: vi.fn(
      (
        jids: string[],
        lastSeqCursor: string,
        botPrefix: string,
        limit?: number,
      ) => {
        const result:
          | {
              messages?: Array<Record<string, unknown>>;
              newSeqCursor?: string;
              newTimestamp?: string;
            }
          | undefined = getNewMessages(
          jids,
          lastSeqCursor,
          botPrefix,
          limit,
        ) || {
          messages: [],
          newSeqCursor: '0',
        };
        const messages = withSeqs(result.messages || []);
        const lastSeq =
          messages.length > 0
            ? String(messages[messages.length - 1].seq)
            : String(lastSeqCursor || '0');
        return {
          messages,
          newSeqCursor: result.newSeqCursor || result.newTimestamp || lastSeq,
        };
      },
    ),
    getPairedTurnAttempts: vi.fn(() => []),
    getOpenWorkItem,
    getOpenWorkItemForChat: vi.fn((chatJid: string) =>
      getOpenWorkItem(chatJid),
    ),
    hasActiveCiWatcherForChat: vi.fn(() => false),
    getLatestOpenPairedTaskForChat: vi.fn(() => undefined),
    getLatestPreviousPairedTaskForChat: vi.fn(() => undefined),
    getPairedTaskById: vi.fn(() => undefined),
    getPairedTurnOutputs: vi.fn(() => []),
    getOwnerCodexBadRequestFailureSummaryForTask: vi.fn(() => null),
    getRecentChatMessages: vi.fn(() => []),
    createProducedWorkItem: vi.fn((input) => ({
      id: 1,
      group_folder: input.group_folder,
      chat_jid: input.chat_jid,
      agent_type: input.agent_type || 'claude-code',
      service_id: 'claude',
      delivery_role: input.delivery_role ?? null,
      status: 'produced',
      start_seq: input.start_seq,
      end_seq: input.end_seq,
      result_payload: input.result_payload,
      delivery_attempts: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      delivered_at: null,
      delivery_message_id: null,
      last_error: null,
    })),
    markWorkItemDelivered: vi.fn(),
    markWorkItemDeliveryRetry: vi.fn(),
    markPairedTurnRunning: vi.fn(),
    getLastBotFinalMessage: vi.fn(() => []),
    reservePairedTurnReservation: vi.fn((args) => {
      const key = buildReservationKey(args);
      if (pairedTurnReservations.has(key)) {
        return false;
      }
      pairedTurnReservations.add(key);
      return true;
    }),
    claimPairedTurnReservation: vi.fn((args) => {
      const revisionKey = [args.taskId, args.taskUpdatedAt].join(':');
      if (claimedTaskRevisions.has(revisionKey)) {
        return false;
      }
      claimedTaskRevisions.add(revisionKey);
      pairedTurnReservations.add(
        buildReservationKey({
          chatJid: args.chatJid,
          taskId: args.taskId,
          taskUpdatedAt: args.taskUpdatedAt,
          intentKind: args.intentKind,
        }),
      );
      return true;
    }),
    _clearPairedTurnReservationsForTests: vi.fn(() => {
      pairedTurnReservations.clear();
      claimedTaskRevisions.clear();
    }),
  };
};

export const createServiceRoutingMock = () => ({
  hasReviewerLease: vi.fn(() => false),
  getEffectiveChannelLease: vi.fn((chatJid: string) => ({
    chat_jid: chatJid,
    owner_agent_type: 'claude-code',
    reviewer_agent_type: 'claude-code',
    arbiter_agent_type: 'claude-code',
    owner_service_id: 'claude',
    reviewer_service_id: 'codex-main',
    arbiter_service_id: 'claude-arbiter',
    owner_failover_active: false,
    activated_at: null,
    reason: null,
    explicit: false,
  })),
  resolveLeaseServiceId: vi.fn(
    (
      lease: {
        owner_agent_type?: string;
        reviewer_agent_type?: string | null;
        arbiter_agent_type?: string | null;
        owner_service_id: string;
        reviewer_service_id: string | null;
        arbiter_service_id?: string | null;
        owner_failover_active?: boolean;
      },
      role: 'owner' | 'reviewer' | 'arbiter',
    ) => {
      if (role === 'owner') return lease.owner_service_id;
      if (role === 'reviewer') return lease.reviewer_service_id;
      return lease.arbiter_service_id ?? null;
    },
  ),
  shouldServiceProcessChat: vi.fn(() => true),
});

export const createLoggerMock = () => {
  const mockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: (_bindings?: Record<string, unknown>) => mockLogger,
  };
  return {
    logger: mockLogger,
    createScopedLogger: (_bindings?: Record<string, unknown>) => mockLogger,
  };
};

export const createSenderAllowlistMock = () => ({
  isTriggerAllowed: vi.fn(() => true),
  loadSenderAllowlist: vi.fn(() => ({})),
});

export const createSessionCommandsMock = () => ({
  extractSessionCommand: vi.fn(() => null),
  handleSessionCommand: vi.fn(async () => ({ handled: false })),
  isSessionCommandAllowed: vi.fn(() => true),
  isSessionCommandControlMessage: vi.fn(() => false),
});
