import type {
  PairedRoomRole,
  PairedTaskStatus,
  PairedTurnReservationIntentKind,
} from './types.js';

export interface PairedTurnIdentity {
  turnId: string;
  taskId: string;
  taskUpdatedAt: string;
  intentKind: PairedTurnReservationIntentKind;
  role: PairedRoomRole;
}

export function resolvePairedTurnRole(
  intentKind: PairedTurnReservationIntentKind,
): PairedRoomRole {
  switch (intentKind) {
    case 'reviewer-turn':
      return 'reviewer';
    case 'arbiter-turn':
      return 'arbiter';
    case 'owner-turn':
    case 'owner-follow-up':
    case 'finalize-owner-turn':
    default:
      return 'owner';
  }
}

export function buildPairedTurnId(args: {
  taskId: string;
  taskUpdatedAt: string;
  intentKind: PairedTurnReservationIntentKind;
}): string {
  return [args.taskId, args.taskUpdatedAt, args.intentKind].join(':');
}

export function buildPairedTurnIdentity(args: {
  taskId: string;
  taskUpdatedAt: string;
  intentKind: PairedTurnReservationIntentKind;
  role?: PairedRoomRole;
  turnId?: string | null;
}): PairedTurnIdentity {
  const role = args.role ?? resolvePairedTurnRole(args.intentKind);
  if (role !== resolvePairedTurnRole(args.intentKind)) {
    throw new Error(
      `paired turn identity role mismatch: ${role} does not match ${args.intentKind}`,
    );
  }

  return {
    turnId:
      args.turnId ??
      buildPairedTurnId({
        taskId: args.taskId,
        taskUpdatedAt: args.taskUpdatedAt,
        intentKind: args.intentKind,
      }),
    taskId: args.taskId,
    taskUpdatedAt: args.taskUpdatedAt,
    intentKind: args.intentKind,
    role,
  };
}

export function resolveOwnerTurnIntentKind(args: {
  taskStatus?: PairedTaskStatus | null;
  hasHumanMessage?: boolean;
}): 'owner-turn' | 'owner-follow-up' | 'finalize-owner-turn' {
  if (args.hasHumanMessage) {
    return 'owner-turn';
  }
  if (args.taskStatus === 'merge_ready') {
    return 'finalize-owner-turn';
  }
  return 'owner-follow-up';
}

export function resolveRuntimePairedTurnIdentity(args: {
  taskId: string;
  taskUpdatedAt: string;
  role: PairedRoomRole;
  taskStatus?: PairedTaskStatus | null;
  hasHumanMessage?: boolean;
}): PairedTurnIdentity {
  const intentKind =
    args.role === 'reviewer'
      ? 'reviewer-turn'
      : args.role === 'arbiter'
        ? 'arbiter-turn'
        : resolveOwnerTurnIntentKind({
            taskStatus: args.taskStatus,
            hasHumanMessage: args.hasHumanMessage,
          });
  return buildPairedTurnIdentity({
    taskId: args.taskId,
    taskUpdatedAt: args.taskUpdatedAt,
    intentKind,
    role: args.role,
  });
}
