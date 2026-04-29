import { SERVICE_SESSION_SCOPE } from '../config.js';
import { type PairedTurnIdentity } from '../paired-turn-identity.js';
import {
  AgentType,
  PairedProject,
  PairedRoomRole,
  PairedTask,
  PairedTurnOutput,
  PairedTurnReservationIntentKind,
  PairedWorkspace,
} from '../types.js';

import {
  clearChannelOwnerLeaseInDatabase,
  getAllChannelOwnerLeasesFromDatabase,
  getChannelOwnerLeaseFromDatabase,
  setChannelOwnerLeaseInDatabase,
  type ChannelOwnerLeaseRow,
  type SetChannelOwnerLeaseInput,
} from './channel-owner-leases.js';
import {
  claimPairedTurnReservationInDatabase,
  clearPairedTaskExecutionLeasesInDatabase,
  clearPairedTurnReservationsInDatabase,
  type PairedTaskUpdates,
  createPairedTaskInDatabase,
  getAllOpenPairedTasksFromDatabase,
  getLastBotFinalMessageFromDatabase,
  getLatestOpenPairedTaskForChatFromDatabase,
  getLatestPreviousPairedTaskForChatFromDatabase,
  getLatestPairedTaskForChatFromDatabase,
  getPairedProjectFromDatabase,
  getPairedTaskByIdFromDatabase,
  getPairedWorkspaceFromDatabase,
  listPairedWorkspacesForTaskFromDatabase,
  refreshPairedTaskExecutionLeaseInDatabase,
  releasePairedTaskExecutionLeaseInDatabase,
  reservePairedTurnReservationInDatabase,
  updatePairedTaskIfUnchangedInDatabase,
  updatePairedTaskInDatabase,
  upsertPairedProjectInDatabase,
  upsertPairedWorkspaceInDatabase,
} from './paired-state.js';
import {
  clearPairedTurnAttemptsInDatabase,
  getOwnerCodexBadRequestFailureSummaryForTaskFromDatabase,
  getPairedTurnAttemptsForTurnFromDatabase,
  type OwnerCodexBadRequestFailureSummary,
  type PairedTurnAttemptRecord,
} from './paired-turn-attempts.js';
import {
  getLatestTurnNumberFromDatabase,
  getPairedTurnOutputsFromDatabase,
  getRecentPairedTurnOutputsForChatFromDatabase,
  insertPairedTurnOutputInDatabase,
} from './paired-turn-outputs.js';
import {
  cancelPairedTurnInDatabase,
  clearPairedTurnsInDatabase,
  completePairedTurnInDatabase,
  failPairedTurnInDatabase,
  getPairedTurnByIdFromDatabase,
  getPairedTurnsForTaskFromDatabase,
  getLatestPairedTurnForTaskFromDatabase,
  updatePairedTurnProgressTextFromDatabase,
  markPairedTurnRunningInDatabase,
  type PairedTurnRecord,
} from './paired-turns.js';
import { requireDatabase } from './runtime-database.js';
import {
  type CompleteServiceHandoffCursorInput,
  type CreateServiceHandoffInput,
  type ServiceHandoff,
  claimServiceHandoffInDatabase,
  completeServiceHandoffAndAdvanceTargetCursorInDatabase,
  completeServiceHandoffInDatabase,
  createServiceHandoffInDatabase,
  failServiceHandoffInDatabase,
  getAllPendingServiceHandoffsFromDatabase,
  getPendingServiceHandoffsFromDatabase,
} from './service-handoffs.js';

export function upsertPairedProject(project: PairedProject): void {
  upsertPairedProjectInDatabase(requireDatabase(), project);
}

export function getPairedProject(chatJid: string): PairedProject | undefined {
  return getPairedProjectFromDatabase(requireDatabase(), chatJid);
}

export function createPairedTask(task: PairedTask): void {
  createPairedTaskInDatabase(requireDatabase(), task);
}

export function getPairedTaskById(id: string): PairedTask | undefined {
  return getPairedTaskByIdFromDatabase(requireDatabase(), id);
}

export function getLatestPairedTaskForChat(
  chatJid: string,
): PairedTask | undefined {
  return getLatestPairedTaskForChatFromDatabase(requireDatabase(), chatJid);
}

export function getLatestOpenPairedTaskForChat(
  chatJid: string,
): PairedTask | undefined {
  return getLatestOpenPairedTaskForChatFromDatabase(requireDatabase(), chatJid);
}

export function getLatestPreviousPairedTaskForChat(
  chatJid: string,
  currentTaskId: string,
): PairedTask | undefined {
  return getLatestPreviousPairedTaskForChatFromDatabase(
    requireDatabase(),
    chatJid,
    currentTaskId,
  );
}

export function getAllOpenPairedTasks(): PairedTask[] {
  return getAllOpenPairedTasksFromDatabase(requireDatabase());
}

export function updatePairedTask(id: string, updates: PairedTaskUpdates): void {
  updatePairedTaskInDatabase(requireDatabase(), id, updates);
}

export function updatePairedTaskIfUnchanged(
  id: string,
  expectedUpdatedAt: string,
  updates: PairedTaskUpdates,
): boolean {
  return updatePairedTaskIfUnchangedInDatabase(
    requireDatabase(),
    id,
    expectedUpdatedAt,
    updates,
  );
}

export function reservePairedTurnReservation(args: {
  chatJid: string;
  taskId: string;
  taskStatus: PairedTask['status'];
  roundTripCount: number;
  taskUpdatedAt: string;
  intentKind: PairedTurnReservationIntentKind;
  runId: string;
}): boolean {
  return reservePairedTurnReservationInDatabase(requireDatabase(), args);
}

export function claimPairedTurnReservation(args: {
  chatJid: string;
  taskId: string;
  taskStatus: PairedTask['status'];
  roundTripCount: number;
  taskUpdatedAt: string;
  intentKind: PairedTurnReservationIntentKind;
  runId: string;
}): boolean {
  return claimPairedTurnReservationInDatabase(requireDatabase(), args);
}

export function releasePairedTaskExecutionLease(args: {
  taskId: string;
  runId: string;
}): void {
  releasePairedTaskExecutionLeaseInDatabase(requireDatabase(), args);
}

export function refreshPairedTaskExecutionLease(args: {
  taskId: string;
  runId: string;
  now?: string;
}): boolean {
  return refreshPairedTaskExecutionLeaseInDatabase(requireDatabase(), args);
}

export function markPairedTurnRunning(args: {
  turnIdentity: PairedTurnIdentity;
  executorServiceId?: string | null;
  executorAgentType?: AgentType | null;
  runId?: string | null;
}): void {
  markPairedTurnRunningInDatabase(requireDatabase(), args);
}

export function completePairedTurn(turnIdentity: PairedTurnIdentity): void {
  completePairedTurnInDatabase(requireDatabase(), turnIdentity);
}

export function failPairedTurn(args: {
  turnIdentity: PairedTurnIdentity;
  error?: string | null;
}): void {
  failPairedTurnInDatabase(requireDatabase(), args);
}

export function cancelPairedTurn(args: {
  turnIdentity: PairedTurnIdentity;
  error?: string | null;
}): void {
  cancelPairedTurnInDatabase(requireDatabase(), args);
}

export function getPairedTurnById(
  turnId: string,
): PairedTurnRecord | undefined {
  return getPairedTurnByIdFromDatabase(requireDatabase(), turnId);
}

export function getPairedTurnsForTask(taskId: string): PairedTurnRecord[] {
  return getPairedTurnsForTaskFromDatabase(requireDatabase(), taskId);
}

export function getLatestPairedTurnForTask(
  taskId: string,
): PairedTurnRecord | null {
  return getLatestPairedTurnForTaskFromDatabase(requireDatabase(), taskId);
}

export function updatePairedTurnProgressText(
  turnId: string,
  progressText: string | null,
): void {
  updatePairedTurnProgressTextFromDatabase(
    requireDatabase(),
    turnId,
    progressText,
  );
}

export function getPairedTurnAttempts(
  turnId: string,
): PairedTurnAttemptRecord[] {
  return getPairedTurnAttemptsForTurnFromDatabase(requireDatabase(), turnId);
}

export function getOwnerCodexBadRequestFailureSummaryForTask(args: {
  taskId: string;
  threshold: number;
}): OwnerCodexBadRequestFailureSummary | null {
  return getOwnerCodexBadRequestFailureSummaryForTaskFromDatabase(
    requireDatabase(),
    args,
  );
}

export function upsertPairedWorkspace(workspace: PairedWorkspace): void {
  upsertPairedWorkspaceInDatabase(requireDatabase(), workspace);
}

export function getPairedWorkspace(
  taskId: string,
  role: PairedWorkspace['role'],
): PairedWorkspace | undefined {
  return getPairedWorkspaceFromDatabase(requireDatabase(), taskId, role);
}

export function listPairedWorkspacesForTask(taskId: string): PairedWorkspace[] {
  return listPairedWorkspacesForTaskFromDatabase(requireDatabase(), taskId);
}

/** @internal - for tests only. */
export function _clearPairedTurnReservationsForTests(): void {
  const db = requireDatabase();
  clearPairedTurnReservationsInDatabase(db);
  clearPairedTaskExecutionLeasesInDatabase(db);
  clearPairedTurnAttemptsInDatabase(db);
  clearPairedTurnsInDatabase(db);
}

export function getLastBotFinalMessage(
  chatJid: string,
  agentType: AgentType = 'claude-code',
  limit: number = 1,
): Array<{ content: string; timestamp: string }> {
  return getLastBotFinalMessageFromDatabase(
    requireDatabase(),
    chatJid,
    agentType,
    limit,
  );
}

export function getChannelOwnerLease(
  chatJid: string,
): ChannelOwnerLeaseRow | undefined {
  return getChannelOwnerLeaseFromDatabase(requireDatabase(), chatJid);
}

export function getAllChannelOwnerLeases(): ChannelOwnerLeaseRow[] {
  return getAllChannelOwnerLeasesFromDatabase(requireDatabase());
}

export function setChannelOwnerLease(input: SetChannelOwnerLeaseInput): void {
  setChannelOwnerLeaseInDatabase(requireDatabase(), input);
}

export function clearChannelOwnerLease(chatJid: string): void {
  clearChannelOwnerLeaseInDatabase(requireDatabase(), chatJid);
}

export function createServiceHandoff(
  input: CreateServiceHandoffInput,
): ServiceHandoff {
  return createServiceHandoffInDatabase(requireDatabase(), input);
}

export function getPendingServiceHandoffs(
  targetServiceId: string = SERVICE_SESSION_SCOPE,
): ServiceHandoff[] {
  return getPendingServiceHandoffsFromDatabase(
    requireDatabase(),
    targetServiceId,
  );
}

export function getAllPendingServiceHandoffs(): ServiceHandoff[] {
  return getAllPendingServiceHandoffsFromDatabase(requireDatabase());
}

export function claimServiceHandoff(id: number): boolean {
  return claimServiceHandoffInDatabase(requireDatabase(), id);
}

export function completeServiceHandoff(id: number): void {
  completeServiceHandoffInDatabase(requireDatabase(), id);
}

export function failServiceHandoff(id: number, error: string): void {
  failServiceHandoffInDatabase(requireDatabase(), id, error);
}

export function completeServiceHandoffAndAdvanceTargetCursor(
  input: CompleteServiceHandoffCursorInput,
): string | null {
  return completeServiceHandoffAndAdvanceTargetCursorInDatabase(
    requireDatabase(),
    input,
  );
}

export function insertPairedTurnOutput(
  taskId: string,
  turnNumber: number,
  role: PairedRoomRole,
  outputText: string,
  createdAt?: string,
): void {
  insertPairedTurnOutputInDatabase(
    requireDatabase(),
    taskId,
    turnNumber,
    role,
    outputText,
    createdAt,
  );
}

export function getPairedTurnOutputs(taskId: string): PairedTurnOutput[] {
  return getPairedTurnOutputsFromDatabase(requireDatabase(), taskId);
}

export function getRecentPairedTurnOutputsForChat(
  chatJid: string,
  limit: number = 8,
): PairedTurnOutput[] {
  return getRecentPairedTurnOutputsForChatFromDatabase(
    requireDatabase(),
    chatJid,
    limit,
  );
}

export function getLatestTurnNumber(taskId: string): number {
  return getLatestTurnNumberFromDatabase(requireDatabase(), taskId);
}
