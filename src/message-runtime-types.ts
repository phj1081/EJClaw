import type {
  AgentType,
  Channel,
  PairedRoomRole,
  RegisteredGroup,
} from './types.js';
import type { PairedTurnIdentity } from './paired-turn-identity.js';

export type ExecuteTurnFn = (args: {
  group: RegisteredGroup;
  prompt: string;
  chatJid: string;
  runId: string;
  channel: Channel;
  startSeq: number | null;
  endSeq: number | null;
  deliveryRole?: PairedRoomRole;
  hasHumanMessage?: boolean;
  forcedRole?: PairedRoomRole;
  forcedAgentType?: AgentType;
  pairedTurnIdentity?: PairedTurnIdentity;
}) => Promise<{
  outputStatus: 'success' | 'error';
  deliverySucceeded: boolean;
  visiblePhase: unknown;
}>;

export type RoleToChannelMap = Record<
  'owner' | 'reviewer' | 'arbiter',
  Channel | null
>;
