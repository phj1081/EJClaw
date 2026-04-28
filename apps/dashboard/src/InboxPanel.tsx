import { useMemo, useState } from 'react';

import type {
  DashboardInboxAction,
  DashboardOverview,
  DashboardTask,
  DashboardTaskAction,
} from './api';
import { formatDate } from './dashboardHelpers';
import { EmptyState } from './EmptyState';
import type { Locale, Messages } from './i18n';
import { TaskActionButtons } from './TaskActionButtons';

export type InboxItem = DashboardOverview['inbox'][number];
export type InboxActionKey = `${string}:${DashboardInboxAction}`;

type InboxFilter = 'all' | InboxItem['kind'];

export interface InboxPanelProps {
  inboxActionKey: InboxActionKey | null;
  locale: Locale;
  onInboxAction: (item: InboxItem, action: DashboardInboxAction) => void;
  onTaskAction: (task: DashboardTask, action: DashboardTaskAction) => void;
  overview: DashboardOverview;
  taskActionKey: string | null;
  tasks: DashboardTask[];
  t: Messages;
}

const INBOX_FILTERS: InboxFilter[] = [
  'all',
  'ci-failure',
  'approval',
  'reviewer-request',
  'arbiter-request',
  'pending-room',
  'mention',
];

function sanitizeInboxText(value: string | null | undefined): string {
  if (!value) return '';
  return value
    .replace(/<\/?internal[^>]*>/gi, '')
    .replace(/<\/?intern\.{3}/gi, '')
    .replace(/<\/?[a-z][a-z0-9-]*[^>]*>/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function inboxActionsFor(item: InboxItem): DashboardInboxAction[] {
  if (
    item.source === 'paired-task' &&
    (item.kind === 'reviewer-request' ||
      item.kind === 'approval' ||
      item.kind === 'arbiter-request')
  ) {
    return ['run', 'decline', 'dismiss'];
  }
  return ['dismiss'];
}

function inboxActionLabel(
  item: InboxItem,
  action: DashboardInboxAction,
  t: Messages,
): string {
  if (action === 'dismiss') return t.inbox.actions.dismiss;
  if (action === 'decline') return t.inbox.actions.decline;
  if (item.kind === 'reviewer-request') return t.inbox.actions.runReview;
  if (item.kind === 'approval') return t.inbox.actions.finalize;
  if (item.kind === 'arbiter-request') return t.inbox.actions.runArbiter;
  return t.inbox.actions.run;
}

function inboxTargetHref(item: InboxItem): string | null {
  if (item.taskId) return '#/scheduled';
  if (item.roomJid || item.groupFolder) return '#/rooms';
  return null;
}

interface InboxCardProps {
  inboxActionKey: InboxActionKey | null;
  item: InboxItem;
  locale: Locale;
  onInboxAction: (item: InboxItem, action: DashboardInboxAction) => void;
  onTaskAction: (task: DashboardTask, action: DashboardTaskAction) => void;
  taskActionKey: string | null;
  tasks: DashboardTask[];
  t: Messages;
}

function InboxCard({
  inboxActionKey,
  item,
  locale,
  onInboxAction,
  onTaskAction,
  taskActionKey,
  tasks,
  t,
}: InboxCardProps) {
  const href = inboxTargetHref(item);
  const linkedTask =
    item.source === 'scheduled-task' && item.taskId
      ? tasks.find((task) => task.id === item.taskId)
      : undefined;
  const inboxActions = inboxActionsFor(item);

  return (
    <article className={`inbox-card inbox-${item.severity}`}>
      <div className="inbox-card-head">
        <div>
          <span className="eyebrow">{t.inbox.kinds[item.kind]}</span>
          <strong>{sanitizeInboxText(item.title) || item.title}</strong>
        </div>
        <div className="inbox-card-badges">
          <span className={`pill pill-${item.severity}`}>
            {t.inbox.severity[item.severity]}
          </span>
          {item.occurrences > 1 ? (
            <span className="pill pill-info">x{item.occurrences}</span>
          ) : null}
        </div>
      </div>
      <p>{sanitizeInboxText(item.summary) || t.inbox.noSummary}</p>
      <div className="inbox-meta">
        <span>
          <small>{t.inbox.occurred}</small>
          <strong>{formatDate(item.occurredAt, locale)}</strong>
        </span>
        <span>
          <small>{t.inbox.source}</small>
          <strong>{item.source}</strong>
        </span>
        <span>
          <small>{t.inbox.target}</small>
          <strong>
            {item.taskId ??
              item.roomName ??
              item.groupFolder ??
              item.roomJid ??
              '-'}
          </strong>
        </span>
      </div>
      {href ? (
        <a className="inbox-target" href={href}>
          {item.taskId ? t.inbox.openTask : t.inbox.openRoom}
        </a>
      ) : null}
      {linkedTask ? (
        <TaskActionButtons
          className="inbox-actions"
          onTaskAction={onTaskAction}
          task={linkedTask}
          taskActionKey={taskActionKey}
          t={t}
        />
      ) : null}
      {inboxActions.length > 0 ? (
        <div className="task-actions inbox-actions">
          {inboxActions.map((action) => {
            const actionKey: InboxActionKey = `${item.id}:${action}`;
            const busy = inboxActionKey === actionKey;
            return (
              <button
                aria-busy={busy || undefined}
                className={`task-action task-action-${action}${busy ? ' is-busy' : ''}`}
                disabled={busy}
                key={action}
                onClick={() => onInboxAction(item, action)}
                type="button"
              >
                {busy
                  ? t.inbox.actions.busy
                  : inboxActionLabel(item, action, t)}
              </button>
            );
          })}
        </div>
      ) : null}
    </article>
  );
}

export function InboxPanel({
  overview,
  tasks,
  locale,
  onInboxAction,
  onTaskAction,
  inboxActionKey,
  taskActionKey,
  t,
}: InboxPanelProps) {
  const [filter, setFilter] = useState<InboxFilter>('all');
  const items = overview.inbox ?? [];
  const counts = useMemo(() => {
    const next: Record<InboxFilter, number> = {
      all: items.length,
      'pending-room': 0,
      'reviewer-request': 0,
      approval: 0,
      'arbiter-request': 0,
      'ci-failure': 0,
      mention: 0,
    };
    for (const item of items) next[item.kind] += 1;
    return next;
  }, [items]);
  const filteredItems =
    filter === 'all' ? items : items.filter((item) => item.kind === filter);
  const severityCounts = items.reduce(
    (acc, item) => {
      acc[item.severity] += 1;
      return acc;
    },
    { error: 0, warn: 0, info: 0 },
  );

  if (items.length === 0) {
    return <EmptyState>{t.inbox.empty}</EmptyState>;
  }

  return (
    <div className="inbox-board">
      <section className="inbox-summary" aria-label={t.inbox.summary}>
        <div>
          <span>{t.inbox.total}</span>
          <strong>{items.length}</strong>
        </div>
        <div>
          <span>{t.inbox.severity.error}</span>
          <strong>{severityCounts.error}</strong>
        </div>
        <div>
          <span>{t.inbox.severity.warn}</span>
          <strong>{severityCounts.warn}</strong>
        </div>
        <div>
          <span>{t.inbox.severity.info}</span>
          <strong>{severityCounts.info}</strong>
        </div>
      </section>

      <div className="inbox-filters" aria-label={t.inbox.filters}>
        {INBOX_FILTERS.map((item) => {
          if (item !== 'all' && counts[item] === 0) return null;
          const label = item === 'all' ? t.inbox.all : t.inbox.kinds[item];
          return (
            <button
              aria-pressed={filter === item}
              className={filter === item ? 'is-active' : undefined}
              key={item}
              onClick={() => setFilter(item)}
              type="button"
            >
              {label}
              <span>{counts[item]}</span>
            </button>
          );
        })}
      </div>

      <div className="inbox-list" aria-label={t.inbox.cardsAria}>
        {filteredItems.map((item) => (
          <InboxCard
            inboxActionKey={inboxActionKey}
            item={item}
            key={item.id}
            locale={locale}
            onInboxAction={onInboxAction}
            onTaskAction={onTaskAction}
            taskActionKey={taskActionKey}
            tasks={tasks}
            t={t}
          />
        ))}
      </div>
    </div>
  );
}
