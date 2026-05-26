import {
  isHostEvidenceAction,
  runHostEvidenceRequest,
  writeHostEvidenceResponse,
} from '../host-evidence.js';
import { logger } from '../logger.js';
import type { IpcDeps, TaskIpcPayload } from '../ipc-types.js';

export async function handleHostEvidenceRequest(
  data: TaskIpcPayload,
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
): Promise<void> {
  if (!data.requestId) {
    logger.warn(
      { sourceGroup },
      'Ignoring host_evidence_request without requestId',
    );
    return;
  }

  if (data.action === 'ejclaw_room_runtime') {
    handleRoomRuntimeReportRequest(data, sourceGroup, isMain, deps);
    return;
  }

  if (!isHostEvidenceAction(data.action)) {
    writeHostEvidenceResponse(sourceGroup, {
      requestId: data.requestId,
      ok: false,
      action: 'ejclaw_service_status',
      command: '',
      stdout: '',
      stderr: '',
      exitCode: 1,
      error: `Unsupported host evidence action: ${String(data.action)}`,
    });
    logger.warn(
      { sourceGroup, requestId: data.requestId, action: data.action },
      'Rejected unsupported host evidence action',
    );
    return;
  }

  const result = await runHostEvidenceRequest({
    requestId: data.requestId,
    action: data.action,
    tailLines:
      typeof data.tail_lines === 'number' ? data.tail_lines : undefined,
    taskId: typeof data.task_id === 'string' ? data.task_id : undefined,
    minutes: typeof data.minutes === 'number' ? data.minutes : undefined,
    limit: typeof data.limit === 'number' ? data.limit : undefined,
    repo: typeof data.repo === 'string' ? data.repo : undefined,
    prNumber: typeof data.pr_number === 'number' ? data.pr_number : undefined,
    runId: typeof data.run_id === 'number' ? data.run_id : undefined,
    artifactKind:
      typeof data.artifact_kind === 'string' ? data.artifact_kind : undefined,
    sourceGroup,
    isMain,
  });

  writeHostEvidenceResponse(sourceGroup, {
    requestId: data.requestId,
    ...result,
  });

  logger.info(
    {
      sourceGroup,
      requestId: data.requestId,
      action: data.action,
      ok: result.ok,
      exitCode: result.exitCode,
    },
    'Processed host evidence request via IPC',
  );
}

function handleRoomRuntimeReportRequest(
  data: TaskIpcPayload,
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
): void {
  if (!data.chatJid) {
    writeHostEvidenceResponse(sourceGroup, {
      requestId: data.requestId!,
      ok: false,
      action: 'ejclaw_room_runtime',
      command: 'internal:ejclaw_room_runtime',
      stdout: '',
      stderr: '',
      exitCode: 1,
      error: 'Missing chatJid for ejclaw_room_runtime request',
    });
    logger.warn(
      { sourceGroup, requestId: data.requestId },
      'Rejected ejclaw_room_runtime request without chatJid',
    );
    return;
  }

  if (!deps.getRoomRuntimeReport) {
    writeHostEvidenceResponse(sourceGroup, {
      requestId: data.requestId!,
      ok: false,
      action: 'ejclaw_room_runtime',
      command: 'internal:ejclaw_room_runtime',
      stdout: '',
      stderr: '',
      exitCode: 1,
      error: 'Room runtime reporting is not configured',
    });
    logger.warn(
      { sourceGroup, requestId: data.requestId, chatJid: data.chatJid },
      'Rejected ejclaw_room_runtime request because runtime reporter is unavailable',
    );
    return;
  }

  const report = deps.getRoomRuntimeReport({
    chatJid: data.chatJid,
    sourceGroup,
    isMain,
  });
  writeHostEvidenceResponse(sourceGroup, {
    requestId: data.requestId!,
    ok: true,
    action: 'ejclaw_room_runtime',
    command: 'internal:ejclaw_room_runtime',
    stdout: JSON.stringify(report, null, 2),
    stderr: '',
    exitCode: 0,
  });
  logger.info(
    {
      sourceGroup,
      requestId: data.requestId,
      action: data.action,
      chatJid: data.chatJid,
    },
    'Processed room runtime report request via IPC',
  );
}
