import { ConversationWorkspaceManager } from "./conversation-workspace";
import { StateStore } from "./store";
import type { JobRecord, RouteConfig } from "./types";

export interface PrepareConversationRouteInput {
  route: RouteConfig;
  job: JobRecord;
  store: StateStore;
  workspaceManager: ConversationWorkspaceManager;
  cleanup: () => Promise<void>;
}

export async function prepareConversationRoute({
  route,
  job,
  store,
  workspaceManager,
  cleanup,
}: PrepareConversationRouteInput): Promise<RouteConfig> {
  await cleanup();
  const sourceSessionId = job.continuationSessionId ?? job.sessionId;
  const branch = store.sessionBranchForSession(job.conversationKey, sourceSessionId);
  const managedBranchPath =
    branch?.workspacePath && workspaceManager.isManagedWorkspacePath(branch.workspacePath)
      ? branch.workspacePath
      : undefined;
  let baseRef = branch?.workspaceRevision ?? undefined;

  if (store.forkRequested(job.conversationKey) && managedBranchPath) {
    baseRef = await workspaceManager.captureCleanRevision(route, managedBranchPath);
    if (!store.setSessionBranchRevision(job.conversationKey, sourceSessionId, baseRef)) {
      throw new Error(`source branch disappeared before fork preparation: ${sourceSessionId}`);
    }
  }

  const restoreIdentity =
    branch && !managedBranchPath && baseRef
      ? `${job.threadId ?? job.conversationKey}:session:${sourceSessionId}`
      : undefined;

  return workspaceManager.prepare(
    route,
    job,
    (workspacePath) => {
      if (!store.bindPreparedWorkspace(job.id, workspacePath)) {
        throw new Error(`job ${job.id} stopped before workspace binding`);
      }
    },
    {
      ...(managedBranchPath ? { workspacePath: managedBranchPath } : {}),
      ...(restoreIdentity ? { identity: restoreIdentity } : {}),
      ...(baseRef ? { baseRef } : {}),
    },
  );
}
