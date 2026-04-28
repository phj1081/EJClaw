import type { DashboardTask, DashboardTaskAction } from './api';
import { taskActionsFor } from './dashboardHelpers';
import type { Messages } from './i18n';

export type TaskActionKey =
  | 'create'
  | `${string}:edit`
  | `${string}:${DashboardTaskAction}`;

interface TaskActionButtonsProps {
  className?: string;
  onTaskAction: (task: DashboardTask, action: DashboardTaskAction) => void;
  task: DashboardTask;
  taskActionKey: string | null;
  t: Messages;
}

export function TaskActionButtons({
  className,
  onTaskAction,
  task,
  taskActionKey,
  t,
}: TaskActionButtonsProps) {
  const taskActions = taskActionsFor(task);
  if (taskActions.length === 0) return null;

  const rootClassName = className
    ? `task-actions ${className}`
    : 'task-actions';

  return (
    <div className={rootClassName}>
      {taskActions.map((action) => {
        const actionKey: TaskActionKey = `${task.id}:${action}`;
        const busy = taskActionKey === actionKey;
        return (
          <button
            aria-busy={busy || undefined}
            className={`task-action task-action-${action}${busy ? ' is-busy' : ''}`}
            disabled={busy}
            key={action}
            onClick={() => onTaskAction(task, action)}
            type="button"
          >
            {busy ? t.tasks.actions.busy : t.tasks.actions[action]}
          </button>
        );
      })}
    </div>
  );
}
