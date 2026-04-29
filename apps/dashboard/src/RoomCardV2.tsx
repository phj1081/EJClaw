import { useEffect, useRef, useState } from 'react';
import { Send } from 'lucide-react';

import type { DashboardOverview, DashboardRoomActivity } from './api';
import type { Locale, Messages } from './i18n';
import { ParsedBody } from './ParsedBody';
import { RoomAttachmentGallery } from './RoomAttachmentGallery';
import { displayRole, displayVerdict } from './roomDisplayLabels';
import {
  buildRoomThreadEntries,
  isWatcherRoomMessage,
  type RoomThreadEntry,
} from './roomThread';

type InboxItem = DashboardOverview['inbox'][number];
type RoomMessage = DashboardRoomActivity['messages'][number];
type RoomOutput = NonNullable<
  DashboardRoomActivity['pairedTask']
>['outputs'][number];
type RoomTask = NonNullable<DashboardRoomActivity['pairedTask']>;
type RoomTurn = NonNullable<RoomTask['currentTurn']>;

export interface RoomEntryWithService {
  jid: string;
  name: string;
  folder: string;
  agentType: string;
  status: 'processing' | 'waiting' | 'inactive';
  elapsedMs: number | null;
  pendingMessages: boolean;
  pendingTasks: number;
  serviceId: string;
}

interface RoomCardFormatters {
  formatDate: (value: string | null | undefined, locale: Locale) => string;
  formatDuration: (value: number | null, t: Messages) => string;
  formatLiveElapsed: (value: number, t: Messages) => string;
  senderRoleClass: (value: string | null | undefined) => string;
  statusLabel: (status: string, t: Messages) => string;
}

interface RoomMessageFormProps {
  busy: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
  t: Messages;
  value: string;
}

function RoomMessageForm({
  busy,
  onChange,
  onSubmit,
  t,
  value,
}: RoomMessageFormProps) {
  return (
    <form
      className="room-compose"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <textarea
        aria-label={t.rooms.message}
        maxLength={8000}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return;
          if (event.shiftKey || event.nativeEvent.isComposing) return;
          if (busy || !value.trim()) return;
          event.preventDefault();
          onSubmit();
        }}
        placeholder={t.rooms.messagePlaceholder}
        rows={1}
        value={value}
      />
      <button
        aria-label={busy ? t.rooms.sending : t.rooms.send}
        disabled={busy || !value.trim()}
        title={busy ? t.rooms.sending : t.rooms.send}
        type="submit"
      >
        <Send size={16} strokeWidth={2} aria-hidden />
      </button>
    </form>
  );
}

export interface RoomCardV2Props extends RoomCardFormatters {
  activity: DashboardRoomActivity | undefined;
  activityLoading: boolean;
  busy: boolean;
  draft: string;
  entry: RoomEntryWithService;
  expanded: boolean;
  inboxItems: InboxItem[];
  locale: Locale;
  onDraftChange: (value: string) => void;
  onSendMessage: () => void;
  onToggle: () => void;
  pendingMessages?: RoomMessage[];
  pinned?: boolean;
  t: Messages;
}

export function RoomCardV2({
  activity,
  activityLoading,
  busy,
  draft,
  entry,
  expanded,
  formatDate,
  formatDuration,
  formatLiveElapsed,
  inboxItems,
  locale,
  onDraftChange,
  onSendMessage,
  onToggle,
  pendingMessages = [],
  pinned = false,
  senderRoleClass,
  statusLabel,
  t,
}: RoomCardV2Props) {
  const task = activity?.pairedTask ?? null;
  const turn = task?.currentTurn ?? null;
  const outputs = task?.outputs ?? [];
  const latestOutput = outputs.at(-1) ?? null;
  const messages = activity?.messages ?? [];
  const isProcessing = entry.status === 'processing';
  const liveTurnStart =
    turn && turn.completedAt === null
      ? new Date(turn.createdAt).getTime()
      : null;
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    if (!isProcessing || liveTurnStart === null) return;
    const id = window.setInterval(() => setTick(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [isProcessing, liveTurnStart]);

  const liveElapsedMs =
    liveTurnStart === null ? null : Math.max(0, tick - liveTurnStart);
  const liveProgressDisplay =
    turn?.progressText && turn.progressText.trim()
      ? turn.progressText
      : getLiveStatusFallback({
          isProcessing,
          messages,
          senderRoleClass,
          turn,
        });
  const lastUpdated = turn?.updatedAt ?? task?.updatedAt ?? null;
  const watcherMessages = messages.filter(isWatcherRoomMessage);
  const lastWatcher = watcherMessages.at(-1) ?? null;
  const agentMessages = buildRoomThreadEntries({
    messages,
    outputs,
    pendingMessages,
  });

  useRoomDetailAutoscroll({
    entryJid: entry.jid,
    messagesLen: messages.length,
    outputsLen: outputs.length,
    pendingLen: pendingMessages.length,
  });

  const formatters = {
    formatDate,
    formatDuration,
    formatLiveElapsed,
    senderRoleClass,
    statusLabel,
  };

  return (
    <article
      aria-expanded={pinned ? undefined : expanded}
      className={`room-card-v2 status-${entry.status}${expanded ? ' is-expanded' : ''}${pinned ? ' is-pinned' : ''}`}
      onClick={pinned ? undefined : onToggle}
      onKeyDown={
        pinned
          ? undefined
          : (e) => {
              if (e.target !== e.currentTarget) return;
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onToggle();
              }
            }
      }
      role={pinned ? undefined : 'button'}
      tabIndex={pinned ? undefined : 0}
    >
      <RoomCardHead
        entry={entry}
        expanded={expanded}
        inboxItems={inboxItems}
        isProcessing={isProcessing}
        pinned={pinned}
        statusLabel={statusLabel}
        t={t}
      />
      <RoomCurrentTurnSummary
        formatDate={formatDate}
        lastUpdated={lastUpdated}
        locale={locale}
        senderRoleClass={senderRoleClass}
        task={task}
        turn={turn}
        t={t}
      />
      <RoomCardMeta
        entry={entry}
        formatDuration={formatDuration}
        isProcessing={isProcessing}
        t={t}
      />
      <CollapsedLiveTurn
        expanded={expanded}
        formatDate={formatDate}
        isProcessing={isProcessing}
        liveProgressDisplay={liveProgressDisplay}
        locale={locale}
        senderRoleClass={senderRoleClass}
        t={t}
        turn={turn}
      />
      <CollapsedOutputPreview
        agentMessages={agentMessages}
        expanded={expanded}
        isProcessing={isProcessing}
        latestOutput={latestOutput}
      />
      <CollapsedWatcherStrip
        expanded={expanded}
        formatDate={formatDate}
        lastWatcher={lastWatcher}
        locale={locale}
        senderRoleClass={senderRoleClass}
        watcherCount={watcherMessages.length}
      />
      <CollapsedEmptyState
        activity={activity}
        activityLoading={activityLoading}
        expanded={expanded}
        isProcessing={isProcessing}
        t={t}
        visibleActivityCount={agentMessages.length + watcherMessages.length}
      />
      {expanded ? (
        <RoomExpandedContent
          agentMessages={agentMessages}
          busy={busy}
          draft={draft}
          formatters={formatters}
          isProcessing={isProcessing}
          liveElapsedMs={liveElapsedMs}
          liveProgressDisplay={liveProgressDisplay}
          locale={locale}
          onDraftChange={onDraftChange}
          onSendMessage={onSendMessage}
          t={t}
          turn={turn}
          watcherMessages={watcherMessages}
        />
      ) : null}
    </article>
  );
}

function useRoomDetailAutoscroll({
  entryJid,
  messagesLen,
  outputsLen,
  pendingLen,
}: {
  entryJid: string;
  messagesLen: number;
  outputsLen: number;
  pendingLen: number;
}) {
  const wasNearBottomRef = useRef(true);
  useEffect(() => {
    const detail = document.querySelector(
      '.rooms-detail',
    ) as HTMLElement | null;
    if (!detail) return;
    if (!wasNearBottomRef.current) return;
    const run = () => {
      detail.scrollTop = detail.scrollHeight;
    };
    requestAnimationFrame(() => requestAnimationFrame(run));
  }, [entryJid, messagesLen, outputsLen, pendingLen]);
  useEffect(() => {
    const detail = document.querySelector(
      '.rooms-detail',
    ) as HTMLElement | null;
    if (!detail) return;
    const onScroll = () => {
      const distance =
        detail.scrollHeight - detail.scrollTop - detail.clientHeight;
      wasNearBottomRef.current = distance < 80;
    };
    detail.addEventListener('scroll', onScroll, { passive: true });
    return () => detail.removeEventListener('scroll', onScroll);
  }, [entryJid]);
}

const TASK_STATUS_PREFIX = '⁣⁣⁣';

function getLiveStatusFallback({
  isProcessing,
  messages,
  senderRoleClass,
  turn,
}: {
  isProcessing: boolean;
  messages: RoomMessage[];
  senderRoleClass: RoomCardFormatters['senderRoleClass'];
  turn: RoomTurn | null;
}): string | null {
  if (!isProcessing) return null;
  if (!turn) return null;
  if (turn.progressText && turn.progressText.trim()) return null;
  const turnStartMs = turn.createdAt ? new Date(turn.createdAt).getTime() : 0;
  const turnRole = senderRoleClass(turn.role);
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message.content.startsWith(TASK_STATUS_PREFIX)) continue;
    const ts = message.timestamp ? new Date(message.timestamp).getTime() : 0;
    if (ts < turnStartMs) continue;
    const senderRole = senderRoleClass(message.senderName);
    if (senderRole !== turnRole) continue;
    const body = message.content.slice(TASK_STATUS_PREFIX.length);
    const stripped = body.replace(/\n\n\d+[초smhMSH]?$/, '').trim();
    return stripped || null;
  }
  return null;
}

function RoomCardHead({
  entry,
  expanded,
  inboxItems,
  isProcessing,
  pinned,
  statusLabel,
  t,
}: {
  entry: RoomEntryWithService;
  expanded: boolean;
  inboxItems: InboxItem[];
  isProcessing: boolean;
  pinned: boolean;
  statusLabel: RoomCardFormatters['statusLabel'];
  t: Messages;
}) {
  return (
    <div className="room-card-head">
      <span className={`room-pulse pulse-${entry.status}`}>
        {isProcessing ? <span className="pulse-dot" /> : null}
      </span>
      <span className="room-title-block">
        <strong>{entry.name}</strong>
        <span className="room-sub">
          <em>{entry.agentType}</em>
          {inboxItems.length > 0 ? (
            <span className="room-inbox-badges" aria-label={t.panels.inbox}>
              {inboxItems.slice(0, 3).map((item) => (
                <span
                  className={`room-inbox-pip sev-${item.severity}`}
                  key={item.id}
                  title={t.inbox.kinds[item.kind]}
                >
                  {t.inbox.kinds[item.kind]}
                </span>
              ))}
            </span>
          ) : null}
        </span>
      </span>
      {!isProcessing ? (
        <span className={`room-status pill pill-${entry.status}`}>
          {statusLabel(entry.status, t)}
        </span>
      ) : (
        <span />
      )}
      {!pinned ? (
        <span className="room-toggle" aria-hidden>
          {expanded ? '▾' : '▸'}
        </span>
      ) : null}
    </div>
  );
}

function RoomCurrentTurnSummary({
  formatDate,
  lastUpdated,
  locale,
  senderRoleClass,
  task,
  turn,
  t,
}: {
  formatDate: RoomCardFormatters['formatDate'];
  lastUpdated: string | null;
  locale: Locale;
  senderRoleClass: RoomCardFormatters['senderRoleClass'];
  task: RoomTask | null;
  turn: RoomTurn | null;
  t: Messages;
}) {
  if (!turn || turn.completedAt === null) return null;
  return (
    <div className="room-current-turn">
      <span>
        <strong className={senderRoleClass(turn.role)}>
          {displayRole(turn.role, locale)}
        </strong>
        <em>{turn.intentKind}</em>
        {turn.attemptNo > 1 ? (
          <small>
            {t.rooms.attempt} {turn.attemptNo}
          </small>
        ) : null}
      </span>
      {task && task.roundTripCount > 0 ? (
        <small>
          · {t.rooms.round} {task.roundTripCount}
        </small>
      ) : null}
      {lastUpdated ? (
        <small style={{ marginLeft: 'auto' }}>
          {formatDate(lastUpdated, locale)}
        </small>
      ) : null}
    </div>
  );
}

function RoomCardMeta({
  entry,
  formatDuration,
  isProcessing,
  t,
}: {
  entry: RoomEntryWithService;
  formatDuration: RoomCardFormatters['formatDuration'];
  isProcessing: boolean;
  t: Messages;
}) {
  const queueChips: string[] = [];
  if (entry.pendingTasks > 0)
    queueChips.push(`${entry.pendingTasks} ${t.rooms.tasks}`);
  if (entry.pendingMessages) queueChips.push(t.rooms.queueWaitingMessages);
  if (
    queueChips.length === 0 &&
    !(entry.elapsedMs && entry.elapsedMs > 0 && isProcessing)
  ) {
    return null;
  }

  return (
    <div className="room-card-meta">
      {queueChips.length > 0 ? (
        <span className="meta-cell">
          <strong>{queueChips.join(' · ')}</strong>
        </span>
      ) : null}
      {isProcessing && entry.elapsedMs ? (
        <span className="meta-cell">
          <strong>{formatDuration(entry.elapsedMs, t)}</strong>
        </span>
      ) : null}
    </div>
  );
}

function CollapsedLiveTurn({
  expanded,
  formatDate,
  isProcessing,
  liveProgressDisplay,
  locale,
  senderRoleClass,
  t,
  turn,
}: {
  expanded: boolean;
  formatDate: RoomCardFormatters['formatDate'];
  isProcessing: boolean;
  liveProgressDisplay: string | null;
  locale: Locale;
  senderRoleClass: RoomCardFormatters['senderRoleClass'];
  t: Messages;
  turn: RoomTurn | null;
}) {
  if (expanded || !isProcessing || !turn || !liveProgressDisplay) return null;
  return (
    <div className="room-live">
      <header>
        <span className="live-dot" aria-hidden />
        <span className="live-label">LIVE</span>
        <strong className={senderRoleClass(turn.role)}>
          {displayRole(turn.role, locale)}
        </strong>
        <em>{turn.intentKind}</em>
        <span className="live-state pill pill-processing">{turn.state}</span>
        {turn.executorServiceId ? (
          <span className="live-exec">{turn.executorServiceId}</span>
        ) : null}
        {turn.attemptNo > 1 ? (
          <span className="live-attempt">
            {t.rooms.attempt} {turn.attemptNo}
          </span>
        ) : null}
        <time>
          {formatDate(turn.progressUpdatedAt ?? turn.updatedAt, locale)}
        </time>
      </header>
      <LiveProgressBody text={liveProgressDisplay} />
    </div>
  );
}

function LiveProgressBody({ text }: { text: string }) {
  return (
    <div className="live-progress">
      <ParsedBody text={text} />
    </div>
  );
}

function CollapsedOutputPreview({
  agentMessages,
  expanded,
  isProcessing,
  latestOutput,
}: {
  agentMessages: RoomThreadEntry[];
  expanded: boolean;
  isProcessing: boolean;
  latestOutput: RoomOutput | null;
}) {
  const latestThreadEntry = agentMessages.at(-1) ?? null;
  const previewText =
    latestOutput?.outputText ?? latestThreadEntry?.content ?? null;
  if (expanded || !previewText || isProcessing) return null;
  return (
    <div className="room-preview">
      <ParsedBody text={previewText} truncate={140} />
    </div>
  );
}

function CollapsedWatcherStrip({
  expanded,
  formatDate,
  lastWatcher,
  locale,
  senderRoleClass,
  watcherCount,
}: {
  expanded: boolean;
  formatDate: RoomCardFormatters['formatDate'];
  lastWatcher: RoomMessage | null;
  locale: Locale;
  senderRoleClass: RoomCardFormatters['senderRoleClass'];
  watcherCount: number;
}) {
  if (expanded || watcherCount === 0 || !lastWatcher) return null;
  return (
    <div className="room-watcher-strip">
      <span className="watcher-tag">워쳐 {watcherCount}</span>
      <span className="watcher-line">
        <strong className={senderRoleClass(lastWatcher.senderName)}>
          {displayRole(lastWatcher.senderName, locale)}
        </strong>
        <span>{lastWatcher.content.slice(0, 90)}</span>
      </span>
      <time>{formatDate(lastWatcher.timestamp, locale)}</time>
    </div>
  );
}

function CollapsedEmptyState({
  activity,
  activityLoading,
  expanded,
  isProcessing,
  t,
  visibleActivityCount,
}: {
  activity: DashboardRoomActivity | undefined;
  activityLoading: boolean;
  expanded: boolean;
  isProcessing: boolean;
  t: Messages;
  visibleActivityCount: number;
}) {
  if (expanded) return null;
  if (visibleActivityCount === 0 && !isProcessing && !activityLoading) {
    return <p className="room-empty">{t.rooms.noActivity}</p>;
  }
  if (activityLoading && !activity) {
    return <p className="room-empty">{t.rooms.loadingActivity}</p>;
  }
  return null;
}

function RoomExpandedContent({
  agentMessages,
  busy,
  draft,
  formatters,
  isProcessing,
  liveElapsedMs,
  liveProgressDisplay,
  locale,
  onDraftChange,
  onSendMessage,
  t,
  turn,
  watcherMessages,
}: {
  agentMessages: RoomThreadEntry[];
  busy: boolean;
  draft: string;
  formatters: RoomCardFormatters;
  isProcessing: boolean;
  liveElapsedMs: number | null;
  liveProgressDisplay: string | null;
  locale: Locale;
  onDraftChange: (value: string) => void;
  onSendMessage: () => void;
  t: Messages;
  turn: RoomTurn | null;
  watcherMessages: RoomMessage[];
}) {
  return (
    <div
      className="room-expanded"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {turn?.lastError ? (
        <div className="room-alert">
          <strong>{t.rooms.error}</strong>
          <ParsedBody text={turn.lastError} />
        </div>
      ) : null}
      <RoomThreadSection
        agentMessages={agentMessages}
        formatters={formatters}
        isProcessing={isProcessing}
        liveElapsedMs={liveElapsedMs}
        liveProgressDisplay={liveProgressDisplay}
        locale={locale}
        t={t}
        turn={turn}
      />
      <RoomWatcherFold
        formatDate={formatters.formatDate}
        locale={locale}
        senderRoleClass={formatters.senderRoleClass}
        watcherMessages={watcherMessages}
      />
      <section className="room-section room-compose-section">
        <RoomMessageForm
          busy={busy}
          onChange={onDraftChange}
          onSubmit={onSendMessage}
          t={t}
          value={draft}
        />
      </section>
    </div>
  );
}

function RoomThreadSection({
  agentMessages,
  formatters,
  isProcessing,
  liveElapsedMs,
  liveProgressDisplay,
  locale,
  t,
  turn,
}: {
  agentMessages: RoomThreadEntry[];
  formatters: RoomCardFormatters;
  isProcessing: boolean;
  liveElapsedMs: number | null;
  liveProgressDisplay: string | null;
  locale: Locale;
  t: Messages;
  turn: RoomTurn | null;
}) {
  const showLiveItem = !!(
    turn &&
    turn.completedAt === null &&
    liveProgressDisplay
  );
  return (
    <section className="room-section room-thread-section">
      <header>
        <h4>{t.rooms.activity}</h4>
        <small>{agentMessages.length}</small>
      </header>
      {agentMessages.length === 0 && !showLiveItem ? (
        <p className="room-empty">{t.rooms.noActivity}</p>
      ) : (
        <ol className="room-timeline">
          {agentMessages.map((entry) => (
            <RoomTimelineEntry
              entry={entry}
              formatDate={formatters.formatDate}
              key={entry.id}
              locale={locale}
              senderRoleClass={formatters.senderRoleClass}
            />
          ))}
          {showLiveItem ? (
            <RoomLiveTimelineEntry
              formatLiveElapsed={formatters.formatLiveElapsed}
              formatDate={formatters.formatDate}
              isProcessing={isProcessing}
              liveElapsedMs={liveElapsedMs}
              liveProgressDisplay={liveProgressDisplay}
              locale={locale}
              senderRoleClass={formatters.senderRoleClass}
              t={t}
              turn={turn}
            />
          ) : null}
        </ol>
      )}
    </section>
  );
}

function RoomTimelineEntry({
  entry,
  formatDate,
  locale,
  senderRoleClass,
}: {
  entry: RoomThreadEntry;
  formatDate: RoomCardFormatters['formatDate'];
  locale: Locale;
  senderRoleClass: RoomCardFormatters['senderRoleClass'];
}) {
  const verdict = entry.verdict;
  const verdictTone = verdict
    ? /fail|error/i.test(verdict)
      ? 'fail'
      : /done|ok|pass/i.test(verdict)
        ? 'done'
        : 'info'
    : null;
  const sectionClass = senderRoleClass(entry.senderName).replace(
    'role-',
    'role-section-',
  );
  return (
    <li className={`room-timeline-item ${sectionClass}`}>
      <header className="room-timeline-header">
        <span className={`role-chip ${senderRoleClass(entry.senderName)}`}>
          {displayRole(entry.senderName, locale)}
        </span>
        <time>{formatDate(entry.timestamp, locale)}</time>
        {entry.turnNumber !== undefined ? (
          <span className="parsed-marker parsed-marker-info">
            #{entry.turnNumber}
          </span>
        ) : null}
        {verdict ? (
          <span className={`parsed-marker parsed-marker-${verdictTone}`}>
            {displayVerdict(verdict, locale)}
          </span>
        ) : null}
      </header>
      <div className="room-timeline-body">
        <ParsedBody text={entry.content} />
        <RoomAttachmentGallery attachments={entry.attachments} />
      </div>
    </li>
  );
}

function RoomLiveTimelineEntry({
  formatDate,
  formatLiveElapsed,
  isProcessing,
  liveElapsedMs,
  liveProgressDisplay,
  locale,
  senderRoleClass,
  t,
  turn,
}: {
  formatDate: RoomCardFormatters['formatDate'];
  formatLiveElapsed: RoomCardFormatters['formatLiveElapsed'];
  isProcessing: boolean;
  liveElapsedMs: number | null;
  liveProgressDisplay: string | null;
  locale: Locale;
  senderRoleClass: RoomCardFormatters['senderRoleClass'];
  t: Messages;
  turn: RoomTurn;
}) {
  return (
    <li
      className={`room-timeline-item ${senderRoleClass(turn.role).replace('role-', 'role-section-')} ${isProcessing ? 'room-timeline-live' : 'room-timeline-paused'}`}
    >
      <header className="room-timeline-header">
        {isProcessing ? (
          <span className="live-dot live-dot-inline" aria-hidden />
        ) : (
          <span className="paused-dot" aria-hidden />
        )}
        <span className={`role-chip ${senderRoleClass(turn.role)}`}>
          {displayRole(turn.role, locale)}
        </span>
        <time>
          {formatDate(turn.progressUpdatedAt ?? turn.updatedAt, locale)}
        </time>
        {liveElapsedMs !== null ? (
          <span className="live-elapsed">
            +{formatLiveElapsed(liveElapsedMs, t)}
          </span>
        ) : null}
        {!isProcessing ? (
          <span className="live-label paused">중단됨</span>
        ) : null}
      </header>
      <div className="room-timeline-body">
        {liveProgressDisplay ? (
          <LiveProgressBody text={liveProgressDisplay} />
        ) : (
          <p className="room-empty">{t.rooms.loadingActivity}</p>
        )}
      </div>
    </li>
  );
}

function RoomWatcherFold({
  formatDate,
  locale,
  senderRoleClass,
  watcherMessages,
}: {
  formatDate: RoomCardFormatters['formatDate'];
  locale: Locale;
  senderRoleClass: RoomCardFormatters['senderRoleClass'];
  watcherMessages: RoomMessage[];
}) {
  if (watcherMessages.length === 0) return null;
  return (
    <details className="room-watcher-fold">
      <summary>
        <span className="watcher-tag">워쳐</span>
        <small>{watcherMessages.length}</small>
      </summary>
      <ul className="room-watcher-list">
        {watcherMessages.map((message) => (
          <li className="room-watcher-item" key={message.id}>
            <header>
              <strong className={senderRoleClass(message.senderName)}>
                {displayRole(message.senderName, locale)}
              </strong>
              <time>{formatDate(message.timestamp, locale)}</time>
            </header>
            <ParsedBody text={message.content} />
          </li>
        ))}
      </ul>
    </details>
  );
}
