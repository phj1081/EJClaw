import { useState } from 'react';

import {
  type CreateScheduledTaskInput,
  type DashboardTask,
  type DashboardTaskAction,
  type UpdateScheduledTaskInput,
  createScheduledTask,
  runServiceAction,
  runScheduledTaskAction,
  updateScheduledTask,
} from './api';
import { type Messages } from './i18n';
import { type TaskActionKey } from './TaskPanel';

export function makeClientRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

interface UseDashboardActionsOptions {
  refresh: (showSpinner?: boolean) => Promise<void>;
  setError: (error: string | null) => void;
  t: Messages;
}

export function useDashboardActions({
  refresh,
  setError,
  t,
}: UseDashboardActionsOptions): {
  handleServiceRestart: () => Promise<void>;
  handleTaskAction: (
    task: DashboardTask,
    action: DashboardTaskAction,
  ) => Promise<void>;
  handleTaskCreate: (input: CreateScheduledTaskInput) => Promise<void>;
  handleTaskUpdate: (
    task: DashboardTask,
    input: UpdateScheduledTaskInput,
  ) => Promise<void>;
  serviceRestarting: boolean;
  taskActionKey: TaskActionKey | null;
} {
  const [taskActionKey, setTaskActionKey] = useState<TaskActionKey | null>(
    null,
  );
  const [serviceRestarting, setServiceRestarting] = useState(false);

  async function handleTaskAction(
    task: DashboardTask,
    action: DashboardTaskAction,
  ) {
    if (action === 'cancel' && !window.confirm(t.tasks.actions.confirmCancel)) {
      return;
    }

    const actionKey: TaskActionKey = `${task.id}:${action}`;
    setTaskActionKey(actionKey);
    try {
      await runScheduledTaskAction(task.id, action);
      await refresh(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTaskActionKey(null);
    }
  }

  async function handleTaskCreate(input: CreateScheduledTaskInput) {
    setTaskActionKey('create');
    try {
      await createScheduledTask({ ...input, requestId: makeClientRequestId() });
      await refresh(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTaskActionKey(null);
    }
  }

  async function handleTaskUpdate(
    task: DashboardTask,
    input: UpdateScheduledTaskInput,
  ) {
    const actionKey: TaskActionKey = `${task.id}:edit`;
    setTaskActionKey(actionKey);
    try {
      await updateScheduledTask(task.id, input);
      await refresh(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTaskActionKey(null);
    }
  }

  async function handleServiceRestart() {
    if (
      typeof window !== 'undefined' &&
      !window.confirm(t.health.confirmRestart)
    ) {
      return;
    }

    setServiceRestarting(true);
    try {
      await runServiceAction('stack', 'restart', {
        requestId: makeClientRequestId(),
      });
      await refresh(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setServiceRestarting(false);
    }
  }

  return {
    handleServiceRestart,
    handleTaskAction,
    handleTaskCreate,
    handleTaskUpdate,
    serviceRestarting,
    taskActionKey,
  };
}
