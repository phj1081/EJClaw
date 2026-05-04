import { useMemo } from 'react';

import type {
  CreateScheduledTaskInput,
  DashboardTask,
  DashboardTaskAction,
  DashboardTaskContextMode,
  DashboardTaskScheduleType,
  UpdateScheduledTaskInput,
} from './api';
import { EmptyState } from './EmptyState';
import { localeTags, type Locale, type Messages } from './i18n';
import { redactSecretsForPreview } from './redaction';
import { statusLabel } from './dashboardHelpers';
import { TaskActionButtons, type TaskActionKey } from './TaskActionButtons';
import './TaskPanel.css';

export type { TaskActionKey } from './TaskActionButtons';

type TaskGroupKey = 'watchers' | 'scheduled' | 'paused' | 'completed';
type TaskResultTone = 'ok' | 'fail' | 'none';

export interface RoomOption {
  jid: string;
  name: string;
  folder: string;
}

export interface TaskPanelProps {
  tasks: DashboardTask[];
  rooms: RoomOption[];
  locale: Locale;
  onTaskAction: (task: DashboardTask, action: DashboardTaskAction) => void;
  onTaskCreate: (input: CreateScheduledTaskInput) => void;
  onTaskUpdate: (task: DashboardTask, input: UpdateScheduledTaskInput) => void;
  taskActionKey: TaskActionKey | null;
  t: Messages;
}

interface TaskGroup {
  key: TaskGroupKey;
  tasks: DashboardTask[];
}

interface TaskSummary {
  completed: number;
  nextTask: DashboardTask | null;
  paused: number;
  scheduled: number;
  total: number;
  watchers: number;
}

interface TaskCreateFormProps {
  rooms: RoomOption[];
  onTaskCreate: (input: CreateScheduledTaskInput) => void;
  taskActionKey: TaskActionKey | null;
  t: Messages;
}

interface TaskGroupSectionProps {
  group: TaskGroup;
  locale: Locale;
  onTaskAction: (task: DashboardTask, action: DashboardTaskAction) => void;
  onTaskUpdate: (task: DashboardTask, input: UpdateScheduledTaskInput) => void;
  taskActionKey: TaskActionKey | null;
  t: Messages;
}

interface TaskCardProps {
  groupKey: TaskGroupKey;
  locale: Locale;
  onTaskAction: (task: DashboardTask, action: DashboardTaskAction) => void;
  onTaskUpdate: (task: DashboardTask, input: UpdateScheduledTaskInput) => void;
  task: DashboardTask;
  taskActionKey: TaskActionKey | null;
  t: Messages;
}

interface TaskDateProps {
  locale: Locale;
  t: Messages;
  task: DashboardTask;
}

interface TaskEditFormProps {
  onTaskUpdate: (task: DashboardTask, input: UpdateScheduledTaskInput) => void;
  task: DashboardTask;
  taskActionKey: TaskActionKey | null;
  t: Messages;
}

function formatTaskDate(
  value: string | null | undefined,
  locale: Locale,
): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const time = new Intl.DateTimeFormat(localeTags[locale], {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
  if (locale === 'ko')
    return `${date.getMonth() + 1}월 ${date.getDate()}일 ${time}`;
  if (locale === 'ja' || locale === 'zh')
    return `${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
  return new Intl.DateTimeFormat(localeTags[locale], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function formatRelativeDate(
  value: string | null | undefined,
  locale: Locale,
  t: Messages,
): string {
  if (!value) return t.tasks.noTime;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const diffMs = date.getTime() - Date.now();
  const absMs = Math.abs(diffMs);
  if (absMs < 45_000) return t.tasks.now;

  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['day', 86_400_000],
    ['hour', 3_600_000],
    ['minute', 60_000],
  ];
  const [unit, unitMs] =
    units.find(([, threshold]) => absMs >= threshold) ?? units.at(-1)!;
  return new Intl.RelativeTimeFormat(localeTags[locale], {
    numeric: 'auto',
    style: 'short',
  }).format(Math.round(diffMs / unitMs), unit);
}

function safePreview(
  value: string | null | undefined,
  fallback: string,
): string {
  const cleaned = redactSecretsForPreview(value ?? '')
    .replace(/<\/?internal[^>]*>/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return fallback;
  return cleaned.length > 120 ? `${cleaned.slice(0, 120)}...` : cleaned;
}

function taskGroupKey(task: DashboardTask): TaskGroupKey {
  if (task.status === 'completed') return 'completed';
  if (task.status === 'paused') return 'paused';
  if (task.isWatcher) return 'watchers';
  return 'scheduled';
}

function taskResultTone(task: DashboardTask): TaskResultTone {
  if (!task.lastResult) return 'none';
  const normalized = task.lastResult.toLowerCase();
  if (
    normalized.includes('fail') ||
    normalized.includes('error') ||
    normalized.includes('timeout') ||
    normalized.includes('cancel') ||
    normalized.includes('reject')
  ) {
    return 'fail';
  }
  return 'ok';
}

function taskDisplayName(task: DashboardTask, t: Messages): string {
  if (task.isWatcher) return t.tasks.ciWatch;
  if (task.scheduleType) return task.scheduleType;
  return task.id;
}

function taskHeadline(task: DashboardTask, t: Messages): string {
  if (task.isWatcher && task.ciProvider) {
    return `${t.tasks.ciWatch} · ${task.ciProvider}`;
  }
  return safePreview(task.promptPreview, taskDisplayName(task, t));
}

function taskScheduleText(task: DashboardTask, t: Messages): string {
  const scheduleType =
    task.scheduleType === 'cron' ||
    task.scheduleType === 'interval' ||
    task.scheduleType === 'once'
      ? t.tasks.scheduleTypes[task.scheduleType]
      : task.scheduleType;
  return `${scheduleType} · ${task.scheduleValue || '-'}`;
}

function isTaskScheduleType(
  value: FormDataEntryValue | null,
): value is DashboardTaskScheduleType {
  return value === 'cron' || value === 'interval' || value === 'once';
}

function isTaskContextMode(
  value: FormDataEntryValue | null,
): value is DashboardTaskContextMode {
  return value === 'group' || value === 'isolated';
}

function readRequiredText(form: FormData, name: string): string | null {
  const value = form.get(name);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function readTaskForm(
  form: FormData,
  includeRoom: true,
): CreateScheduledTaskInput | null;
function readTaskForm(
  form: FormData,
  includeRoom: false,
): UpdateScheduledTaskInput | null;
function readTaskForm(
  form: FormData,
  includeRoom: boolean,
): CreateScheduledTaskInput | UpdateScheduledTaskInput | null {
  const prompt = readRequiredText(form, 'prompt');
  const scheduleValue = readRequiredText(form, 'scheduleValue');
  const scheduleTypeValue = form.get('scheduleType');
  if (!scheduleValue || !isTaskScheduleType(scheduleTypeValue)) {
    return null;
  }
  const scheduleType = scheduleTypeValue;

  if (!includeRoom) {
    return prompt
      ? { prompt, scheduleType, scheduleValue }
      : { scheduleType, scheduleValue };
  }

  if (!prompt) {
    return null;
  }

  const roomJid = readRequiredText(form, 'roomJid');
  const contextMode = form.get('contextMode');
  if (!roomJid || !isTaskContextMode(contextMode)) return null;
  return {
    contextMode,
    prompt,
    roomJid,
    scheduleType,
    scheduleValue,
  };
}

function buildTaskGroups(tasks: DashboardTask[]): TaskGroup[] {
  const groups: Record<TaskGroupKey, DashboardTask[]> = {
    watchers: [],
    scheduled: [],
    paused: [],
    completed: [],
  };

  for (const task of tasks) {
    groups[taskGroupKey(task)].push(task);
  }

  for (const groupTasks of Object.values(groups)) {
    groupTasks.sort((a, b) =>
      (a.nextRun ?? a.lastRun ?? a.createdAt).localeCompare(
        b.nextRun ?? b.lastRun ?? b.createdAt,
      ),
    );
  }

  return [
    { key: 'watchers', tasks: groups.watchers },
    { key: 'scheduled', tasks: groups.scheduled },
    { key: 'paused', tasks: groups.paused },
    { key: 'completed', tasks: groups.completed },
  ];
}

function buildTaskSummary(tasks: DashboardTask[]): TaskSummary {
  const summary: TaskSummary = {
    completed: 0,
    nextTask: null,
    paused: 0,
    scheduled: 0,
    total: tasks.length,
    watchers: 0,
  };

  for (const task of tasks) {
    const group = taskGroupKey(task);
    if (group === 'watchers') summary.watchers += 1;
    if (group === 'scheduled') summary.scheduled += 1;
    if (group === 'paused') summary.paused += 1;
    if (group === 'completed') summary.completed += 1;

    if (task.status !== 'active' || !task.nextRun) continue;
    const nextTime = new Date(task.nextRun).getTime();
    if (Number.isNaN(nextTime)) continue;
    const currentTime = summary.nextTask?.nextRun
      ? new Date(summary.nextTask.nextRun).getTime()
      : Number.POSITIVE_INFINITY;
    if (nextTime < currentTime) {
      summary.nextTask = task;
    }
  }

  return summary;
}

function TaskSummaryMetric({ label, value }: { label: string; value: number }) {
  return (
    <span className="task-summary-metric">
      <strong>{value}</strong>
      <small>{label}</small>
    </span>
  );
}

function TaskBoardSummary({
  locale,
  summary,
  t,
}: {
  locale: Locale;
  summary: TaskSummary;
  t: Messages;
}) {
  const nextTask = summary.nextTask;
  return (
    <section className="task-command-center" aria-label={t.panels.scheduled}>
      <div className="task-command-copy">
        <span className="eyebrow">{t.panels.scheduled}</span>
        <strong>
          {summary.total} {t.tasks.count}
        </strong>
        <p>
          {nextTask
            ? `${t.tasks.next}: ${taskHeadline(nextTask, t)}`
            : t.tasks.empty}
        </p>
      </div>
      <div className="task-command-next">
        <small>{t.tasks.next}</small>
        <strong>
          {nextTask ? formatRelativeDate(nextTask.nextRun, locale, t) : '-'}
        </strong>
        <span>
          {nextTask
            ? `${nextTask.groupFolder} · ${taskScheduleText(nextTask, t)}`
            : t.tasks.noTime}
        </span>
      </div>
      <div className="task-command-metrics">
        <TaskSummaryMetric
          label={t.tasks.groups.scheduled}
          value={summary.scheduled}
        />
        <TaskSummaryMetric
          label={t.tasks.groups.watchers}
          value={summary.watchers}
        />
        <TaskSummaryMetric
          label={t.tasks.groups.paused}
          value={summary.paused}
        />
        <TaskSummaryMetric
          label={t.tasks.groups.completed}
          value={summary.completed}
        />
      </div>
    </section>
  );
}

function TaskCreateForm({
  rooms,
  onTaskCreate,
  taskActionKey,
  t,
}: TaskCreateFormProps) {
  return (
    <form
      className="task-create-form"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const input = readTaskForm(form, true);
        if (!input) return;
        onTaskCreate(input);
        event.currentTarget.reset();
      }}
    >
      <div className="task-create-head">
        <span className="eyebrow">{t.tasks.createTitle}</span>
        <strong>{t.tasks.createSubtitle}</strong>
        <p>{t.tasks.scheduleValueHint}</p>
      </div>
      <div className="task-create-body">
        <label className="task-form-wide">
          <span>{t.tasks.prompt}</span>
          <textarea
            name="prompt"
            placeholder={t.tasks.promptPlaceholder}
            required
          />
        </label>
        <div className="task-form-controls">
          <label>
            <span>{t.tasks.room}</span>
            <select name="roomJid" required>
              <option value="">{t.tasks.selectRoom}</option>
              {rooms.map((room) => (
                <option key={room.jid} value={room.jid}>
                  {room.name} · {room.folder}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>{t.tasks.scheduleType}</span>
            <select name="scheduleType" required>
              <option value="once">{t.tasks.scheduleTypes.once}</option>
              <option value="interval">{t.tasks.scheduleTypes.interval}</option>
              <option value="cron">{t.tasks.scheduleTypes.cron}</option>
            </select>
          </label>
          <label>
            <span>{t.tasks.scheduleValue}</span>
            <input
              name="scheduleValue"
              placeholder={t.tasks.scheduleValueHint}
              required
            />
          </label>
          <label>
            <span>{t.tasks.context}</span>
            <select name="contextMode" required>
              <option value="isolated">{t.tasks.contextModes.isolated}</option>
              <option value="group">{t.tasks.contextModes.group}</option>
            </select>
          </label>
        </div>
        <div className="task-form-footer">
          <span>{t.tasks.schedule}</span>
          <button disabled={taskActionKey === 'create'} type="submit">
            {taskActionKey === 'create'
              ? t.tasks.actions.busy
              : t.tasks.actions.create}
          </button>
        </div>
      </div>
    </form>
  );
}

function TaskTimeGrid({ locale, t, task }: TaskDateProps) {
  return (
    <div className="task-time-grid">
      <span className="task-next-run">
        <small>{t.tasks.next}</small>
        <strong>{formatRelativeDate(task.nextRun, locale, t)}</strong>
        <em>{formatTaskDate(task.nextRun, locale)}</em>
      </span>
      <span>
        <small>{t.tasks.last}</small>
        <strong>{formatTaskDate(task.lastRun, locale)}</strong>
        <em>{formatRelativeDate(task.lastRun, locale, t)}</em>
      </span>
      <span>
        <small>{t.tasks.schedule}</small>
        <strong>{taskScheduleText(task, t)}</strong>
        <em>{task.contextMode}</em>
      </span>
    </div>
  );
}

function TaskSuspendedUntil({ locale, t, task }: TaskDateProps) {
  if (!task.suspendedUntil) return null;

  return (
    <div className="task-suspended">
      <span>{t.tasks.suspendedUntil}</span>
      <strong>{formatTaskDate(task.suspendedUntil, locale)}</strong>
      <em>{formatRelativeDate(task.suspendedUntil, locale, t)}</em>
    </div>
  );
}

function TaskResult({ task, t }: { task: DashboardTask; t: Messages }) {
  const resultTone = taskResultTone(task);
  const lastResult = safePreview(task.lastResult, t.tasks.noResult);

  return (
    <div className={`task-result result-${resultTone}`}>
      <span>
        {resultTone === 'fail'
          ? t.tasks.resultFail
          : resultTone === 'ok'
            ? t.tasks.resultOk
            : t.tasks.result}
      </span>
      <strong>{lastResult}</strong>
    </div>
  );
}

function TaskPromptDetails({ task, t }: { task: DashboardTask; t: Messages }) {
  return (
    <details className="task-prompt">
      <summary>{t.tasks.prompt}</summary>
      <p>{safePreview(task.promptPreview, t.tasks.emptyPrompt)}</p>
      <small>
        {task.id} · {taskScheduleText(task, t)} · {task.promptLength}{' '}
        {t.units.chars}
      </small>
    </details>
  );
}

function TaskMetaStrip({ task, t }: { task: DashboardTask; t: Messages }) {
  return (
    <div className="task-meta-strip">
      <span>{task.groupFolder}</span>
      <span>{task.agentType ?? t.tasks.task}</span>
      {task.ciProvider ? <span>{task.ciProvider}</span> : null}
    </div>
  );
}

function TaskEditForm({
  onTaskUpdate,
  task,
  taskActionKey,
  t,
}: TaskEditFormProps) {
  if (task.isWatcher || task.status === 'completed') return null;

  return (
    <details className="task-edit">
      <summary>{t.tasks.actions.edit}</summary>
      <form
        className="task-edit-form"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const input = readTaskForm(form, false);
          if (!input) return;
          onTaskUpdate(task, input);
        }}
      >
        <label className="task-form-wide">
          <span>{t.tasks.prompt}</span>
          <textarea name="prompt" placeholder={t.tasks.editPromptPlaceholder} />
        </label>
        <label>
          <span>{t.tasks.scheduleType}</span>
          <select name="scheduleType" defaultValue={task.scheduleType} required>
            <option value="once">{t.tasks.scheduleTypes.once}</option>
            <option value="interval">{t.tasks.scheduleTypes.interval}</option>
            <option value="cron">{t.tasks.scheduleTypes.cron}</option>
          </select>
        </label>
        <label>
          <span>{t.tasks.scheduleValue}</span>
          <input
            name="scheduleValue"
            defaultValue={task.scheduleValue}
            required
          />
        </label>
        <button disabled={taskActionKey === `${task.id}:edit`} type="submit">
          {taskActionKey === `${task.id}:edit`
            ? t.tasks.actions.busy
            : t.tasks.actions.save}
        </button>
      </form>
    </details>
  );
}

function TaskCard({
  groupKey,
  locale,
  onTaskAction,
  onTaskUpdate,
  task,
  taskActionKey,
  t,
}: TaskCardProps) {
  return (
    <article className={`task-card task-card-${groupKey}`}>
      <div className="task-card-main">
        <div className="task-title">
          <span className="task-kind">{taskDisplayName(task, t)}</span>
          <strong>{taskHeadline(task, t)}</strong>
          <TaskMetaStrip task={task} t={t} />
        </div>
        <div className="task-status-line">
          <span className={`pill pill-${task.status}`}>
            {statusLabel(task.status, t)}
          </span>
        </div>
      </div>
      <TaskActionButtons
        onTaskAction={onTaskAction}
        task={task}
        taskActionKey={taskActionKey}
        t={t}
      />
      <TaskTimeGrid locale={locale} t={t} task={task} />
      <TaskSuspendedUntil locale={locale} t={t} task={task} />
      <TaskResult task={task} t={t} />
      <TaskPromptDetails task={task} t={t} />
      <TaskEditForm
        onTaskUpdate={onTaskUpdate}
        task={task}
        taskActionKey={taskActionKey}
        t={t}
      />
    </article>
  );
}

function TaskGroupBody({
  group,
  locale,
  onTaskAction,
  onTaskUpdate,
  taskActionKey,
  t,
}: TaskGroupSectionProps) {
  if (group.tasks.length === 0) {
    return <div className="task-group-empty">{t.tasks.groupEmpty}</div>;
  }

  return (
    <div className="task-list">
      {group.tasks.map((task) => (
        <TaskCard
          groupKey={group.key}
          key={task.id}
          locale={locale}
          onTaskAction={onTaskAction}
          onTaskUpdate={onTaskUpdate}
          task={task}
          taskActionKey={taskActionKey}
          t={t}
        />
      ))}
    </div>
  );
}

function TaskGroupHead({
  countLabel,
  group,
  label,
}: {
  countLabel: string;
  group: TaskGroup;
  label: string;
}) {
  return (
    <div className="task-group-head">
      <div>
        <span className="eyebrow">{label}</span>
        <strong>
          {group.tasks.length} {countLabel}
        </strong>
      </div>
      <span className={`pill pill-${group.key}`}>{group.tasks.length}</span>
    </div>
  );
}

function TaskGroupSection(props: TaskGroupSectionProps) {
  const { group, t } = props;
  if (group.tasks.length === 0) return null;

  const label = t.tasks.groups[group.key];
  const body = <TaskGroupBody {...props} />;

  if (group.key === 'completed') {
    return (
      <details className="task-group task-group-completed">
        <summary className="task-group-head">
          <div>
            <span className="eyebrow">{label}</span>
            <strong>
              {group.tasks.length} {t.tasks.count}
            </strong>
          </div>
          <span className={`pill pill-${group.key}`}>{group.tasks.length}</span>
        </summary>
        {body}
      </details>
    );
  }

  return (
    <section className={`task-group task-group-${group.key}`}>
      <TaskGroupHead countLabel={t.tasks.count} group={group} label={label} />
      {body}
    </section>
  );
}

export function TaskPanel({
  tasks,
  rooms,
  locale,
  onTaskAction,
  onTaskCreate,
  onTaskUpdate,
  taskActionKey,
  t,
}: TaskPanelProps) {
  const taskGroups = useMemo(() => buildTaskGroups(tasks), [tasks]);
  const taskSummary = useMemo(() => buildTaskSummary(tasks), [tasks]);

  return (
    <div className="task-board" aria-label={t.tasks.cardsAria}>
      <TaskBoardSummary locale={locale} summary={taskSummary} t={t} />
      <TaskCreateForm
        rooms={rooms}
        onTaskCreate={onTaskCreate}
        taskActionKey={taskActionKey}
        t={t}
      />

      {tasks.length === 0 ? <EmptyState>{t.tasks.empty}</EmptyState> : null}
      <div className="task-lanes">
        {taskGroups.map((group) => (
          <TaskGroupSection
            group={group}
            key={group.key}
            locale={locale}
            onTaskAction={onTaskAction}
            onTaskUpdate={onTaskUpdate}
            taskActionKey={taskActionKey}
            t={t}
          />
        ))}
      </div>
    </div>
  );
}
