import { useEffect, useState } from 'react';

import type {
  DashboardOverview,
  DashboardRoomActivity,
  StatusSnapshot,
} from './api';
import type { Locale, Messages } from './i18n';
import { RoomCardV2, type RoomEntryWithService } from './RoomCardV2';
import { EmptyState } from './EmptyState';
import type { RoomActivityMap } from './useRoomActivity';

type InboxItem = DashboardOverview['inbox'][number];
type RoomFilter = 'all' | 'processing' | 'waiting' | 'inactive';
type RoomSort = 'recent' | 'name' | 'queue';

const ROOM_FILTER_ORDER: RoomFilter[] = [
  'all',
  'processing',
  'waiting',
  'inactive',
];

export interface RoomBoardV2Props {
  createRequestId: () => string;
  formatDate: (value: string | null | undefined, locale: Locale) => string;
  formatDuration: (value: number | null, t: Messages) => string;
  formatLiveElapsed: (value: number, t: Messages) => string;
  inbox: InboxItem[];
  locale: Locale;
  onSelectedJidChange: (jid: string | null) => void;
  onSendRoomMessage: (
    roomJid: string,
    text: string,
    requestId: string,
  ) => Promise<boolean>;
  pendingMessages: Record<
    string,
    Array<DashboardRoomActivity['messages'][number]>
  >;
  roomActivity: RoomActivityMap;
  roomActivityLoading: boolean;
  roomMessageKey: string | null;
  selectedJid: string | null;
  senderRoleClass: (value: string | null | undefined) => string;
  snapshots: StatusSnapshot[];
  statusLabel: (status: string, t: Messages) => string;
  t: Messages;
}

function roomFilterLabel(
  filter: RoomFilter,
  statusLabel: (status: string, t: Messages) => string,
  t: Messages,
): string {
  if (filter === 'all') return t.rooms.filterAll;
  return statusLabel(filter, t);
}

function roomSortLabel(sort: RoomSort, t: Messages): string {
  if (sort === 'recent') return t.rooms.sortRecent;
  if (sort === 'queue') return t.rooms.sortQueue;
  return t.rooms.sortName;
}

function scrollDetailToBottom() {
  if (typeof window === 'undefined') return;
  const detail = document.querySelector('.rooms-detail') as HTMLElement | null;
  if (!detail) return;
  const tick = (n: number) => {
    detail.scrollTop = detail.scrollHeight;
    if (n > 0) requestAnimationFrame(() => tick(n - 1));
  };
  requestAnimationFrame(() => tick(3));
}

interface RoomsToolbarProps {
  counts: Record<RoomFilter, number>;
  filter: RoomFilter;
  onFilterChange: (filter: RoomFilter) => void;
  onSortChange: (sort: RoomSort) => void;
  sort: RoomSort;
  statusLabel: (status: string, t: Messages) => string;
  t: Messages;
}

function RoomsToolbar({
  counts,
  filter,
  onFilterChange,
  onSortChange,
  sort,
  statusLabel,
  t,
}: RoomsToolbarProps) {
  return (
    <div className="rooms-toolbar" role="toolbar" aria-label="Rooms filters">
      <div className="rooms-filters">
        {ROOM_FILTER_ORDER.map((filterKey) => (
          <button
            aria-pressed={filter === filterKey}
            className={filter === filterKey ? 'is-active' : undefined}
            key={filterKey}
            onClick={() => onFilterChange(filterKey)}
            type="button"
          >
            {roomFilterLabel(filterKey, statusLabel, t)}
            <span>{counts[filterKey]}</span>
          </button>
        ))}
      </div>
      <label className="rooms-sort">
        <span>{t.rooms.sortLabel}</span>
        <select
          onChange={(event) => onSortChange(event.target.value as RoomSort)}
          value={sort}
        >
          <option value="recent">{roomSortLabel('recent', t)}</option>
          <option value="queue">{roomSortLabel('queue', t)}</option>
          <option value="name">{roomSortLabel('name', t)}</option>
        </select>
      </label>
    </div>
  );
}

interface RoomsListProps {
  entries: RoomEntryWithService[];
  inbox: InboxItem[];
  onSelect: (jid: string) => void;
  selectedJid: string | null;
  t: Messages;
}

function RoomsList({
  entries,
  inbox,
  onSelect,
  selectedJid,
  t,
}: RoomsListProps) {
  return (
    <aside className="rooms-list" aria-label={t.rooms.cardsAria}>
      {entries.map((entry) => {
        const items = inbox.filter((item) => item.roomJid === entry.jid);
        const queue = entry.pendingTasks + (entry.pendingMessages ? 1 : 0);
        const active = selectedJid === entry.jid;
        return (
          <button
            aria-current={active ? 'page' : undefined}
            className={`rooms-list-item status-${entry.status}${active ? ' is-active' : ''}`}
            key={`${entry.serviceId}:${entry.jid}`}
            onClick={() => onSelect(entry.jid)}
            type="button"
          >
            <span className={`room-pulse pulse-${entry.status}`}>
              {entry.status === 'processing' ? (
                <span className="pulse-dot" />
              ) : null}
            </span>
            <span className="rooms-list-text">
              <strong>{entry.name}</strong>
              <small>{entry.agentType}</small>
            </span>
            {items.length > 0 ? (
              <span
                className={`rooms-list-bell sev-${items[0].severity}`}
                title={items.map((item) => t.inbox.kinds[item.kind]).join(', ')}
              >
                {items.length}
              </span>
            ) : null}
            {queue > 0 ? (
              <span className="rooms-list-queue">{queue}</span>
            ) : null}
          </button>
        );
      })}
    </aside>
  );
}

interface RoomsDetailProps extends Pick<
  RoomBoardV2Props,
  | 'formatDate'
  | 'formatDuration'
  | 'formatLiveElapsed'
  | 'locale'
  | 'pendingMessages'
  | 'roomActivity'
  | 'roomActivityLoading'
  | 'roomMessageKey'
  | 'senderRoleClass'
  | 'statusLabel'
  | 't'
> {
  drafts: Record<string, string>;
  inbox: InboxItem[];
  onBack: () => void;
  onDraftChange: (jid: string, value: string) => void;
  onSubmit: (jid: string) => void;
  selectedEntry: RoomEntryWithService | null;
}

function RoomsDetail({
  drafts,
  formatDate,
  formatDuration,
  formatLiveElapsed,
  inbox,
  locale,
  onBack,
  onDraftChange,
  onSubmit,
  pendingMessages,
  roomActivity,
  roomActivityLoading,
  roomMessageKey,
  selectedEntry,
  senderRoleClass,
  statusLabel,
  t,
}: RoomsDetailProps) {
  return (
    <main className="rooms-detail">
      <button className="rooms-mobile-back" onClick={onBack} type="button">
        ← {t.panels.rooms}
      </button>
      {selectedEntry ? (
        <RoomCardV2
          activity={roomActivity[selectedEntry.jid]}
          activityLoading={roomActivityLoading}
          busy={roomMessageKey === selectedEntry.jid}
          draft={drafts[selectedEntry.jid] ?? ''}
          entry={selectedEntry}
          expanded={true}
          formatDate={formatDate}
          formatDuration={formatDuration}
          formatLiveElapsed={formatLiveElapsed}
          inboxItems={inbox.filter(
            (item) => item.roomJid === selectedEntry.jid,
          )}
          key={`${selectedEntry.serviceId}:${selectedEntry.jid}`}
          locale={locale}
          onDraftChange={(value) => onDraftChange(selectedEntry.jid, value)}
          onSendMessage={() => onSubmit(selectedEntry.jid)}
          onToggle={() => {}}
          pendingMessages={pendingMessages[selectedEntry.jid] ?? []}
          pinned={true}
          senderRoleClass={senderRoleClass}
          statusLabel={statusLabel}
          t={t}
        />
      ) : (
        <EmptyState>{t.rooms.empty}</EmptyState>
      )}
    </main>
  );
}

export function RoomBoardV2({
  createRequestId,
  formatDate,
  formatDuration,
  formatLiveElapsed,
  inbox,
  onSendRoomMessage,
  pendingMessages,
  roomActivity,
  roomActivityLoading,
  roomMessageKey,
  selectedJid,
  locale,
  onSelectedJidChange,
  senderRoleClass,
  snapshots,
  statusLabel,
  t,
}: RoomBoardV2Props) {
  const [filter, setFilter] = useState<RoomFilter>('all');
  const [sort, setSort] = useState<RoomSort>('recent');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);

  const allEntries: RoomEntryWithService[] = snapshots.flatMap((snapshot) =>
    snapshot.entries.map((entry) => ({
      ...entry,
      serviceId: snapshot.serviceId,
    })),
  );

  const counts = {
    all: allEntries.length,
    processing: allEntries.filter((entry) => entry.status === 'processing')
      .length,
    waiting: allEntries.filter((entry) => entry.status === 'waiting').length,
    inactive: allEntries.filter((entry) => entry.status === 'inactive').length,
  };

  const filtered = allEntries.filter(
    (entry) => filter === 'all' || entry.status === filter,
  );
  const sorted = [...filtered].sort((a, b) => {
    if (sort === 'name') return a.name.localeCompare(b.name);
    if (sort === 'queue') {
      const aQ = a.pendingTasks + (a.pendingMessages ? 1 : 0);
      const bQ = b.pendingTasks + (b.pendingMessages ? 1 : 0);
      return bQ - aQ;
    }
    const aA = roomActivity[a.jid]?.pairedTask?.updatedAt;
    const bA = roomActivity[b.jid]?.pairedTask?.updatedAt;
    const aT = aA ? new Date(aA).getTime() : (a.elapsedMs ?? 0);
    const bT = bA ? new Date(bA).getTime() : (b.elapsedMs ?? 0);
    return bT - aT;
  });

  const selectedEntry =
    sorted.find((entry) => entry.jid === selectedJid) ?? sorted[0] ?? null;

  useEffect(() => {
    const nextJid = selectedEntry?.jid ?? null;
    if (nextJid !== selectedJid) {
      onSelectedJidChange(nextJid);
      setMobileDetailOpen(false);
    }
  }, [onSelectedJidChange, selectedEntry?.jid, selectedJid]);

  if (allEntries.length === 0) {
    return <EmptyState>{t.rooms.empty}</EmptyState>;
  }

  function setDraft(jid: string, value: string) {
    setDrafts((previous) => ({ ...previous, [jid]: value }));
  }

  async function submitRoomMessage(jid: string) {
    const text = drafts[jid]?.trim();
    if (!text) return;
    scrollDetailToBottom();
    const success = await onSendRoomMessage(jid, text, createRequestId());
    if (success) {
      setDraft(jid, '');
      scrollDetailToBottom();
    }
  }

  return (
    <div className="rooms-v2">
      <RoomsToolbar
        counts={counts}
        filter={filter}
        onFilterChange={setFilter}
        onSortChange={setSort}
        sort={sort}
        statusLabel={statusLabel}
        t={t}
      />

      {sorted.length === 0 ? (
        <EmptyState>{t.rooms.empty}</EmptyState>
      ) : (
        <div
          className={`rooms-twopane${mobileDetailOpen ? ' is-detail-open' : ''}`}
        >
          <RoomsList
            entries={sorted}
            inbox={inbox}
            onSelect={(jid) => {
              onSelectedJidChange(jid);
              setMobileDetailOpen(true);
            }}
            selectedJid={selectedEntry?.jid ?? null}
            t={t}
          />
          <RoomsDetail
            drafts={drafts}
            formatDate={formatDate}
            formatDuration={formatDuration}
            formatLiveElapsed={formatLiveElapsed}
            inbox={inbox}
            locale={locale}
            onBack={() => setMobileDetailOpen(false)}
            onDraftChange={setDraft}
            onSubmit={(jid) => void submitRoomMessage(jid)}
            pendingMessages={pendingMessages}
            roomActivity={roomActivity}
            roomActivityLoading={roomActivityLoading}
            roomMessageKey={roomMessageKey}
            selectedEntry={selectedEntry}
            senderRoleClass={senderRoleClass}
            statusLabel={statusLabel}
            t={t}
          />
        </div>
      )}
    </div>
  );
}
