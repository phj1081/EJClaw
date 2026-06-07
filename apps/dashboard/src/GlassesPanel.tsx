import {
  type KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Check, Inbox, Mic, RefreshCw, Send, X } from 'lucide-react';

import {
  type DashboardInboxAction,
  type DashboardOverview,
  type StatusSnapshot,
} from './api';
import { formatDate } from './dashboardHelpers';
import type { Locale } from './i18n';

type InboxItem = DashboardOverview['inbox'][number];
type GlassesMode = 'queue' | 'voice';

interface RoomChoice {
  jid: string;
  label: string;
  status: StatusSnapshot['entries'][number]['status'];
  pendingTasks: number;
}

interface SpeechRecognitionResultLike {
  readonly 0?: { transcript?: string };
}

interface SpeechRecognitionEventLike {
  readonly results: ArrayLike<SpeechRecognitionResultLike>;
}

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  start: () => void;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

interface SpeechWindow extends Window {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
}

export interface GlassesPanelProps {
  createRequestId: () => string;
  error: string | null;
  freshnessText: string;
  inboxActionKey: `${string}:${DashboardInboxAction}` | null;
  locale: Locale;
  onInboxAction: (
    item: InboxItem,
    action: DashboardInboxAction,
  ) => Promise<boolean>;
  onRefresh: () => void;
  onSendRoomMessage: (
    roomJid: string,
    text: string,
    requestId: string,
  ) => Promise<boolean>;
  overview: DashboardOverview;
  refreshing: boolean;
  roomMessageKey: string | null;
  snapshots: StatusSnapshot[];
}

const QUEUE_KIND_ORDER: Record<InboxItem['kind'], number> = {
  approval: 0,
  'reviewer-request': 1,
  'arbiter-request': 2,
  'ci-failure': 3,
  mention: 4,
  'pending-room': 5,
};

const SEVERITY_ORDER: Record<InboxItem['severity'], number> = {
  error: 0,
  warn: 1,
  info: 2,
};

const SPEECH_LOCALES: Record<Locale, string> = {
  en: 'en-US',
  ja: 'ja-JP',
  ko: 'ko-KR',
  zh: 'zh-CN',
};

function getSpeechRecognition(): SpeechRecognitionConstructor | null {
  if (typeof window === 'undefined') return null;
  const speechWindow = window as SpeechWindow;
  return (
    speechWindow.SpeechRecognition ??
    speechWindow.webkitSpeechRecognition ??
    null
  );
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

function actionLabel(item: InboxItem, action: DashboardInboxAction): string {
  if (action === 'dismiss') return '닫기';
  if (action === 'decline') return '거절';
  if (item.kind === 'approval') return '최종화';
  if (item.kind === 'reviewer-request') return '리뷰';
  if (item.kind === 'arbiter-request') return '중재';
  return '실행';
}

function actionIcon(action: DashboardInboxAction) {
  if (action === 'decline') return <X size={16} aria-hidden />;
  if (action === 'dismiss') return <Check size={16} aria-hidden />;
  return <Send size={16} aria-hidden />;
}

function sortInboxItems(items: InboxItem[]): InboxItem[] {
  return [...items].sort((a, b) => {
    const severity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (severity !== 0) return severity;
    const kind = QUEUE_KIND_ORDER[a.kind] - QUEUE_KIND_ORDER[b.kind];
    if (kind !== 0) return kind;
    return b.lastOccurredAt.localeCompare(a.lastOccurredAt);
  });
}

function buildRoomChoices(snapshots: StatusSnapshot[]): RoomChoice[] {
  const rooms = new Map<string, RoomChoice>();
  for (const snapshot of snapshots) {
    const entries = Array.isArray(snapshot.entries) ? snapshot.entries : [];
    for (const entry of entries) {
      const existing = rooms.get(entry.jid);
      const label = entry.name || entry.folder || entry.jid;
      if (!existing) {
        rooms.set(entry.jid, {
          jid: entry.jid,
          label,
          pendingTasks: entry.pendingTasks,
          status: entry.status,
        });
        continue;
      }
      if (
        entry.status === 'processing' ||
        entry.pendingTasks > existing.pendingTasks
      ) {
        rooms.set(entry.jid, {
          jid: entry.jid,
          label,
          pendingTasks: entry.pendingTasks,
          status: entry.status,
        });
      }
    }
  }
  return [...rooms.values()].sort((a, b) => {
    if (a.status === 'processing' && b.status !== 'processing') return -1;
    if (b.status === 'processing' && a.status !== 'processing') return 1;
    return b.pendingTasks - a.pendingTasks || a.label.localeCompare(b.label);
  });
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(index, length - 1));
}

function nextIndex(index: number, length: number, delta: number): number {
  if (length <= 0) return 0;
  return (index + delta + length) % length;
}

function readTranscript(event: SpeechRecognitionEventLike): string {
  return Array.from(event.results)
    .map((result) => result[0]?.transcript?.trim() ?? '')
    .filter(Boolean)
    .join(' ')
    .trim();
}

interface QueueCardProps {
  inboxActionKey: `${string}:${DashboardInboxAction}` | null;
  inboxActions: DashboardInboxAction[];
  inboxItems: InboxItem[];
  locale: Locale;
  onInboxAction: (
    item: InboxItem,
    action: DashboardInboxAction,
  ) => Promise<boolean>;
  selectedActionIndex: number;
  selectedInbox: InboxItem | undefined;
  selectedInboxIndex: number;
  setSelectedActionIndex: (index: number) => void;
}

function QueueCard({
  inboxActionKey,
  inboxActions,
  inboxItems,
  locale,
  onInboxAction,
  selectedActionIndex,
  selectedInbox,
  selectedInboxIndex,
  setSelectedActionIndex,
}: QueueCardProps) {
  if (!selectedInbox) {
    return (
      <section className="glasses-card glasses-queue-card" aria-live="polite">
        <div className="glasses-empty">
          <strong>Queue clear</strong>
          <span>새 요청 없음</span>
        </div>
      </section>
    );
  }

  return (
    <section className="glasses-card glasses-queue-card" aria-live="polite">
      <div className="glasses-card-head">
        <span className={`glasses-pill sev-${selectedInbox.severity}`}>
          {selectedInbox.kind}
        </span>
        <small>
          {selectedInboxIndex + 1}/{inboxItems.length}
        </small>
      </div>
      <h2>{selectedInbox.title}</h2>
      <p>{selectedInbox.summary}</p>
      <dl className="glasses-meta">
        <div>
          <dt>Target</dt>
          <dd>
            {selectedInbox.roomName ??
              selectedInbox.groupFolder ??
              selectedInbox.roomJid ??
              selectedInbox.taskId ??
              '-'}
          </dd>
        </div>
        <div>
          <dt>Time</dt>
          <dd>{formatDate(selectedInbox.lastOccurredAt, locale)}</dd>
        </div>
      </dl>
      <div className="glasses-actions">
        {inboxActions.map((action, index) => {
          const actionKey = `${selectedInbox.id}:${action}`;
          const busy = inboxActionKey === actionKey;
          return (
            <button
              aria-busy={busy || undefined}
              aria-pressed={index === selectedActionIndex}
              className={
                index === selectedActionIndex ? 'is-active' : undefined
              }
              disabled={busy || Boolean(inboxActionKey)}
              key={action}
              onClick={() => {
                setSelectedActionIndex(index);
                void onInboxAction(selectedInbox, action);
              }}
              type="button"
            >
              {actionIcon(action)}
              {busy ? '처리 중' : actionLabel(selectedInbox, action)}
            </button>
          );
        })}
      </div>
    </section>
  );
}

interface VoiceCardProps {
  canListen: boolean;
  listening: boolean;
  onSendVoiceText: () => void;
  onStartListening: () => void;
  selectedRoom: RoomChoice | undefined;
  sendingVoice: boolean;
  setSelectedRoomIndex: (index: number) => void;
  setVoiceText: (value: string) => void;
  rooms: RoomChoice[];
  voiceText: string;
}

function VoiceCard({
  canListen,
  listening,
  onSendVoiceText,
  onStartListening,
  selectedRoom,
  sendingVoice,
  setSelectedRoomIndex,
  setVoiceText,
  rooms,
  voiceText,
}: VoiceCardProps) {
  return (
    <section className="glasses-card glasses-voice-card">
      <div className="glasses-card-head">
        <span className="glasses-pill">voice</span>
        <small>{selectedRoom?.label ?? 'No room'}</small>
      </div>
      <textarea
        aria-label="음성 또는 키보드 입력"
        onChange={(event) => setVoiceText(event.target.value)}
        placeholder="말하거나 입력..."
        value={voiceText}
      />
      <div className="glasses-room-strip" aria-label="room target">
        {rooms.slice(0, 4).map((room, index) => (
          <button
            aria-pressed={room.jid === selectedRoom?.jid}
            className={room.jid === selectedRoom?.jid ? 'is-active' : undefined}
            key={room.jid}
            onClick={() => setSelectedRoomIndex(index)}
            type="button"
          >
            {room.label}
          </button>
        ))}
      </div>
      <div className="glasses-actions">
        <button
          disabled={!canListen || listening}
          onClick={onStartListening}
          type="button"
        >
          <Mic size={16} aria-hidden />
          {listening ? '듣는 중' : '말하기'}
        </button>
        <button
          className="is-active"
          disabled={!selectedRoom || !voiceText.trim() || sendingVoice}
          onClick={onSendVoiceText}
          type="button"
        >
          <Send size={16} aria-hidden />
          {sendingVoice ? '전송 중' : '전송'}
        </button>
      </div>
    </section>
  );
}

interface GlassesHeaderProps {
  onRefresh: () => void;
  refreshing: boolean;
}

function GlassesHeader({ onRefresh, refreshing }: GlassesHeaderProps) {
  return (
    <header className="glasses-header">
      <div>
        <span className="glasses-kicker">EJClaw</span>
        <h1>Display</h1>
      </div>
      <button
        aria-busy={refreshing || undefined}
        aria-label="새로고침"
        className="glasses-icon-button"
        disabled={refreshing}
        onClick={onRefresh}
        type="button"
      >
        <RefreshCw size={18} aria-hidden />
      </button>
    </header>
  );
}

interface ModeTabsProps {
  mode: GlassesMode;
  setMode: (mode: GlassesMode) => void;
}

function ModeTabs({ mode, setMode }: ModeTabsProps) {
  return (
    <nav className="glasses-tabs" aria-label="display modes">
      <button
        aria-pressed={mode === 'queue'}
        className={mode === 'queue' ? 'is-active' : undefined}
        onClick={() => setMode('queue')}
        type="button"
      >
        <Inbox size={16} aria-hidden />
        Queue
      </button>
      <button
        aria-pressed={mode === 'voice'}
        className={mode === 'voice' ? 'is-active' : undefined}
        onClick={() => setMode('voice')}
        type="button"
      >
        <Mic size={16} aria-hidden />
        Voice
      </button>
    </nav>
  );
}

function footerStatus(
  mode: GlassesMode,
  busyActionKey: string | null,
  selectedRoom: RoomChoice | undefined,
): string {
  if (mode === 'queue') return busyActionKey ?? 'ready';
  return selectedRoom?.status ?? 'ready';
}

export function GlassesPanel({
  createRequestId,
  error,
  freshnessText,
  inboxActionKey,
  locale,
  onInboxAction,
  onRefresh,
  onSendRoomMessage,
  overview,
  refreshing,
  roomMessageKey,
  snapshots,
}: GlassesPanelProps) {
  const shellRef = useRef<HTMLElement | null>(null);
  const [mode, setMode] = useState<GlassesMode>('queue');
  const [selectedInboxIndex, setSelectedInboxIndex] = useState(0);
  const [selectedActionIndex, setSelectedActionIndex] = useState(0);
  const [selectedRoomIndex, setSelectedRoomIndex] = useState(0);
  const [voiceText, setVoiceText] = useState('');
  const [listening, setListening] = useState(false);
  const inboxItems = useMemo(
    () => sortInboxItems(Array.isArray(overview.inbox) ? overview.inbox : []),
    [overview.inbox],
  );
  const rooms = useMemo(
    () => buildRoomChoices(Array.isArray(snapshots) ? snapshots : []),
    [snapshots],
  );
  const selectedInbox =
    inboxItems[clampIndex(selectedInboxIndex, inboxItems.length)];
  const inboxActions = selectedInbox ? inboxActionsFor(selectedInbox) : [];
  const selectedAction =
    inboxActions[clampIndex(selectedActionIndex, inboxActions.length)];
  const selectedRoom = rooms[clampIndex(selectedRoomIndex, rooms.length)];
  const canListen = getSpeechRecognition() !== null;
  const busyActionKey =
    selectedInbox && selectedAction
      ? `${selectedInbox.id}:${selectedAction}`
      : null;
  const sendingVoice = selectedRoom
    ? roomMessageKey === selectedRoom.jid
    : false;

  useEffect(() => {
    shellRef.current?.focus();
  }, []);

  useEffect(() => {
    setSelectedInboxIndex((value) => clampIndex(value, inboxItems.length));
  }, [inboxItems.length]);

  useEffect(() => {
    setSelectedActionIndex((value) => clampIndex(value, inboxActions.length));
  }, [inboxActions.length]);

  useEffect(() => {
    setSelectedRoomIndex((value) => clampIndex(value, rooms.length));
  }, [rooms.length]);

  function startListening() {
    const SpeechRecognition = getSpeechRecognition();
    if (!SpeechRecognition || listening) return;
    const recognition = new SpeechRecognition();
    recognition.lang = SPEECH_LOCALES[locale];
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.onresult = (event) => {
      const nextText = readTranscript(event);
      if (nextText) setVoiceText(nextText);
    };
    recognition.onerror = () => setListening(false);
    recognition.onend = () => setListening(false);
    setListening(true);
    recognition.start();
  }

  async function runSelectedAction() {
    if (!selectedInbox || !selectedAction || inboxActionKey) return;
    await onInboxAction(selectedInbox, selectedAction);
  }

  async function sendVoiceText() {
    const text = voiceText.trim();
    if (!selectedRoom || !text || sendingVoice) return;
    const ok = await onSendRoomMessage(
      selectedRoom.jid,
      text,
      createRequestId(),
    );
    if (ok) setVoiceText('');
  }

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLTextAreaElement
    ) {
      return;
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      setMode((value) => (value === 'queue' ? 'voice' : 'queue'));
      return;
    }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      if (mode === 'queue') {
        setSelectedInboxIndex((value) =>
          nextIndex(value, inboxItems.length, delta),
        );
      } else {
        setSelectedRoomIndex((value) => nextIndex(value, rooms.length, delta));
      }
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (mode === 'queue') void runSelectedAction();
      else void sendVoiceText();
    }
  }

  return (
    <main
      aria-label="EJClaw Ray-Ban Display"
      className="glasses-shell"
      onKeyDown={handleKeyDown}
      ref={shellRef}
      tabIndex={0}
    >
      <GlassesHeader onRefresh={onRefresh} refreshing={refreshing} />

      <section className="glasses-status-row" aria-label="상태">
        <span>{freshnessText}</span>
        <strong>{inboxItems.length} items</strong>
      </section>

      {error ? <p className="glasses-error">{error}</p> : null}

      <ModeTabs mode={mode} setMode={setMode} />

      {mode === 'queue' ? (
        <QueueCard
          inboxActionKey={inboxActionKey}
          inboxActions={inboxActions}
          inboxItems={inboxItems}
          locale={locale}
          onInboxAction={onInboxAction}
          selectedActionIndex={selectedActionIndex}
          selectedInbox={selectedInbox}
          selectedInboxIndex={selectedInboxIndex}
          setSelectedActionIndex={setSelectedActionIndex}
        />
      ) : (
        <VoiceCard
          canListen={canListen}
          listening={listening}
          onSendVoiceText={() => void sendVoiceText()}
          onStartListening={startListening}
          rooms={rooms}
          selectedRoom={selectedRoom}
          sendingVoice={sendingVoice}
          setSelectedRoomIndex={setSelectedRoomIndex}
          setVoiceText={setVoiceText}
          voiceText={voiceText}
        />
      )}

      <footer className="glasses-footer">
        <span>{footerStatus(mode, busyActionKey, selectedRoom)}</span>
      </footer>
    </main>
  );
}
