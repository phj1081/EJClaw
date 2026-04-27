import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Activity,
  Clock,
  Download,
  Gauge,
  Inbox as InboxIcon,
  MessageSquare,
  RefreshCw,
  Send,
  Settings,
} from 'lucide-react';

import {
  type ClaudeAccountSummary,
  type CodexAccountSummary,
  type CreateScheduledTaskInput,
  type DashboardInboxAction,
  type DashboardRoomActivity,
  type DashboardTaskContextMode,
  type DashboardTaskScheduleType,
  type DashboardTaskAction,
  type DashboardOverview,
  type DashboardTask,
  type FastModeSnapshot,
  type ModelConfigSnapshot,
  type ModelRoleConfig,
  type UpdateScheduledTaskInput,
  type StatusSnapshot,
  addClaudeAccount,
  createScheduledTask,
  deleteAccount,
  fetchAccounts,
  fetchDashboardData,
  fetchFastMode,
  fetchModelConfig,
  refreshAllCodexAccounts as refreshAllCodexAccountsApi,
  refreshCodexAccount as refreshCodexAccountApi,
  runInboxAction,
  runServiceAction,
  runScheduledTaskAction,
  sendRoomMessage,
  setCurrentCodexAccount as setCurrentCodexAccountApi,
  updateFastMode,
  updateModels,
  updateScheduledTask,
} from './api';
import {
  LOCALES,
  isLocale,
  languageNames,
  localeTags,
  matchLocale,
  messages,
  type Locale,
  type Messages,
} from './i18n';
import {
  useSelectedRoomActivity,
  type RoomActivityMap,
} from './useRoomActivity';
import './styles.css';

interface DashboardState {
  overview: DashboardOverview;
  snapshots: StatusSnapshot[];
  tasks: DashboardTask[];
}

type UsageRow = DashboardOverview['usage']['rows'][number];
type InboxItem = DashboardOverview['inbox'][number];
type RiskLevel = 'ok' | 'warn' | 'critical';
type UsageGroup = 'primary' | 'codex';
type UsageLimitWindow = 'h5' | 'd7';
type DashboardView =
  | 'usage'
  | 'inbox'
  | 'health'
  | 'rooms'
  | 'scheduled'
  | 'settings';
type TaskGroupKey = 'watchers' | 'scheduled' | 'paused' | 'completed';
type TaskResultTone = 'ok' | 'fail' | 'none';
type TaskActionKey =
  | 'create'
  | `${string}:edit`
  | `${string}:${DashboardTaskAction}`;
type InboxActionKey = `${string}:${DashboardInboxAction}`;
type ServiceActionKey = 'stack:restart';
type InboxFilter = 'all' | InboxItem['kind'];
type HealthLevel = 'ok' | 'stale' | 'down';
type FreshnessLevel = 'fresh' | 'stale' | 'offline';

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
};

interface RoomOption {
  jid: string;
  name: string;
  folder: string;
}

const REFRESH_INTERVAL_MS = 15_000;
const LOCALE_STORAGE_KEY = 'ejclaw.dashboard.locale.v2';
const DEFAULT_VIEW: DashboardView = 'rooms';
const HEALTH_STALE_MS = 5 * 60_000;
const HEALTH_DOWN_MS = 15 * 60_000;
const DASHBOARD_STALE_MS = 75_000;

function makeClientRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function isDashboardView(
  value: string | null | undefined,
): value is DashboardView {
  return (
    value === 'usage' ||
    value === 'inbox' ||
    value === 'health' ||
    value === 'rooms' ||
    value === 'scheduled' ||
    value === 'settings'
  );
}

function readViewFromHash(): DashboardView {
  if (typeof window === 'undefined') return DEFAULT_VIEW;
  const raw = window.location.hash.replace(/^#\/?/, '');
  return isDashboardView(raw) ? raw : DEFAULT_VIEW;
}

function readInitialLocale(): Locale {
  const stored =
    typeof window === 'undefined'
      ? null
      : window.localStorage.getItem(LOCALE_STORAGE_KEY);
  if (isLocale(stored)) return stored;

  const languages =
    typeof navigator === 'undefined'
      ? []
      : [...(navigator.languages || []), navigator.language];
  for (const language of languages) {
    const matched = matchLocale(language);
    if (matched) return matched;
  }

  return 'en';
}

function humanizeError(raw: string, t: Messages): string {
  const lower = raw.toLowerCase();
  if (/abort|timeout|timed out/.test(lower)) return t.error.timeout;
  if (/network|fetch failed|failed to fetch|networkerror|offline/.test(lower))
    return t.error.network;
  const statusMatch = lower.match(/\b(\d{3})\b/);
  if (statusMatch) {
    const code = Number(statusMatch[1]);
    if (code === 401 || code === 403) return t.error.auth;
    if (code === 404) return t.error.notFound;
    if (code >= 500) return t.error.server;
    if (code >= 400) return t.error.unknown;
  }
  return raw || t.error.unknown;
}

type ParsedSegment =
  | { kind: 'text'; value: string }
  | { kind: 'code'; lang: string; value: string }
  | { kind: 'inline-code'; value: string }
  | { kind: 'bold'; value: string }
  | { kind: 'italic'; value: string }
  | { kind: 'strike'; value: string }
  | { kind: 'url'; href: string; label: string }
  | { kind: 'mention'; value: string }
  | { kind: 'marker'; tone: 'done' | 'fail' | 'info'; value: string }
  | { kind: 'path'; value: string };

const URL_RE = /\bhttps?:\/\/[^\s)<>]+/g;
const MENTION_RE = /(^|\s)(@[A-Za-z0-9_-]+)/g;
const MARKER_RE =
  /\b(TASK_DONE|TASK_FAILED|TASK_FAIL|TASK_OK|DONE|FAILED|FAIL|OK|ERROR|WARNING|RETRY|STATUS|PASS|PASSED)\b/g;
const PATH_RE = /(?:^|\s)((?:\/|\.\/|\.\.\/)[^\s)<>]+)/g;

function tokenizeInline(input: string): ParsedSegment[] {
  if (!input) return [];
  const segments: ParsedSegment[] = [];
  const matches: Array<{
    start: number;
    end: number;
    seg: ParsedSegment;
    priority: number;
  }> = [];
  for (const m of input.matchAll(/`([^`\n]+)`/g)) {
    matches.push({
      start: m.index ?? 0,
      end: (m.index ?? 0) + m[0].length,
      seg: { kind: 'inline-code', value: m[1] },
      priority: 0,
    });
  }
  for (const m of input.matchAll(/\*\*([^*\n]+)\*\*/g)) {
    matches.push({
      start: m.index ?? 0,
      end: (m.index ?? 0) + m[0].length,
      seg: { kind: 'bold', value: m[1] },
      priority: 0,
    });
  }
  for (const m of input.matchAll(/(?<![*\w])\*([^*\n]+?)\*(?!\w)/g)) {
    matches.push({
      start: m.index ?? 0,
      end: (m.index ?? 0) + m[0].length,
      seg: { kind: 'italic', value: m[1] },
      priority: 0,
    });
  }
  for (const m of input.matchAll(/~~([^~\n]+)~~/g)) {
    matches.push({
      start: m.index ?? 0,
      end: (m.index ?? 0) + m[0].length,
      seg: { kind: 'strike', value: m[1] },
      priority: 0,
    });
  }
  for (const m of input.matchAll(URL_RE)) {
    matches.push({
      start: m.index ?? 0,
      end: (m.index ?? 0) + m[0].length,
      seg: { kind: 'url', href: m[0], label: m[0].replace(/^https?:\/\//, '') },
      priority: 1,
    });
  }
  for (const m of input.matchAll(MENTION_RE)) {
    const idx = (m.index ?? 0) + m[1].length;
    matches.push({
      start: idx,
      end: idx + m[2].length,
      seg: { kind: 'mention', value: m[2] },
      priority: 2,
    });
  }
  for (const m of input.matchAll(PATH_RE)) {
    const lead = m[0].startsWith(' ') ? 1 : 0;
    const idx = (m.index ?? 0) + lead;
    matches.push({
      start: idx,
      end: idx + m[1].length,
      seg: { kind: 'path', value: m[1] },
      priority: 3,
    });
  }
  for (const m of input.matchAll(MARKER_RE)) {
    const v = m[1];
    const tone: 'done' | 'fail' | 'info' = /FAIL|ERROR/.test(v)
      ? 'fail'
      : /DONE|OK|PASS/.test(v)
        ? 'done'
        : 'info';
    matches.push({
      start: m.index ?? 0,
      end: (m.index ?? 0) + v.length,
      seg: { kind: 'marker', tone, value: v },
      priority: 4,
    });
  }
  matches.sort((a, b) =>
    a.start === b.start ? a.priority - b.priority : a.start - b.start,
  );
  let cursor = 0;
  const used: Array<[number, number]> = [];
  for (const match of matches) {
    if (match.start < cursor) continue;
    const overlaps = used.some(
      ([s, e]) => !(match.end <= s || match.start >= e),
    );
    if (overlaps) continue;
    if (match.start > cursor) {
      segments.push({ kind: 'text', value: input.slice(cursor, match.start) });
    }
    segments.push(match.seg);
    used.push([match.start, match.end]);
    cursor = match.end;
  }
  if (cursor < input.length) {
    segments.push({ kind: 'text', value: input.slice(cursor) });
  }
  return segments;
}

type ParsedBlock =
  | { kind: 'paragraph'; segments: ParsedSegment[] }
  | { kind: 'code'; lang: string; value: string }
  | { kind: 'heading'; level: 1 | 2 | 3 | 4; segments: ParsedSegment[] }
  | { kind: 'list'; items: ParsedSegment[][] }
  | { kind: 'olist'; items: ParsedSegment[][]; start: number }
  | { kind: 'quote'; segments: ParsedSegment[] };

function parseTextBlocks(raw: string): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];
  const lines = raw.split(/\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) {
      i++;
      continue;
    }
    const heading = trimmed.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      const level = Math.min(heading[1].length, 4) as 1 | 2 | 3 | 4;
      blocks.push({
        kind: 'heading',
        level,
        segments: tokenizeInline(heading[2]),
      });
      i++;
      continue;
    }
    if (/^>\s+/.test(trimmed)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      blocks.push({
        kind: 'quote',
        segments: tokenizeInline(quoteLines.join('\n')),
      });
      continue;
    }
    if (/^[-*]\s+/.test(trimmed)) {
      const items: ParsedSegment[][] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        const itemText = lines[i].replace(/^\s*[-*]\s+/, '');
        items.push(tokenizeInline(itemText));
        i++;
      }
      blocks.push({ kind: 'list', items });
      continue;
    }
    const olistMatch = trimmed.match(/^(\d+)\.\s+/);
    if (olistMatch) {
      const items: ParsedSegment[][] = [];
      const start = Number(olistMatch[1]);
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        const itemText = lines[i].replace(/^\s*\d+\.\s+/, '');
        items.push(tokenizeInline(itemText));
        i++;
      }
      blocks.push({ kind: 'olist', items, start });
      continue;
    }
    // Plain paragraph: gather consecutive non-empty lines
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,4})\s+/.test(lines[i].trim()) &&
      !/^[-*]\s+/.test(lines[i].trim()) &&
      !/^\d+\.\s+/.test(lines[i].trim()) &&
      !/^>\s+/.test(lines[i].trim())
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length > 0) {
      blocks.push({
        kind: 'paragraph',
        segments: tokenizeInline(paraLines.join('\n')),
      });
    }
  }
  return blocks;
}

function parseMessageBody(raw: string | null | undefined): ParsedBlock[] {
  if (!raw) return [];
  const cleaned = raw
    .replace(/<\/?internal[^>]*>/gi, '')
    .replace(/<\/?intern\.{3}/gi, '')
    .trim();
  if (!cleaned) return [];
  const blocks: ParsedBlock[] = [];
  const fenceRe = /```([A-Za-z0-9_+-]*)\n?([\s\S]*?)```/g;
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(cleaned)) !== null) {
    if (m.index > cursor) {
      const pre = cleaned.slice(cursor, m.index).trim();
      if (pre) blocks.push(...parseTextBlocks(pre));
    }
    blocks.push({ kind: 'code', lang: m[1] || '', value: m[2] });
    cursor = m.index + m[0].length;
  }
  if (cursor < cleaned.length) {
    const tail = cleaned.slice(cursor).trim();
    if (tail) blocks.push(...parseTextBlocks(tail));
  }
  return blocks;
}

function renderInlineSegments(
  segments: ParsedSegment[],
  truncate: number | undefined,
  usedRef: { used: number },
): ReactNode[] {
  const out: ReactNode[] = [];
  segments.forEach((s, j) => {
    if (truncate && usedRef.used >= truncate) return;
    const remaining = truncate ? truncate - usedRef.used : Infinity;
    if (s.kind === 'text') {
      const v =
        s.value.length > remaining
          ? `${s.value.slice(0, remaining)}…`
          : s.value;
      usedRef.used += v.length;
      out.push(<span key={j}>{v}</span>);
      return;
    }
    if (s.kind === 'inline-code') {
      usedRef.used += s.value.length;
      out.push(
        <code className="parsed-icode" key={j}>
          {s.value}
        </code>,
      );
      return;
    }
    if (s.kind === 'bold') {
      usedRef.used += s.value.length;
      out.push(<strong key={j}>{s.value}</strong>);
      return;
    }
    if (s.kind === 'italic') {
      usedRef.used += s.value.length;
      out.push(<em key={j}>{s.value}</em>);
      return;
    }
    if (s.kind === 'strike') {
      usedRef.used += s.value.length;
      out.push(<s key={j}>{s.value}</s>);
      return;
    }
    if (s.kind === 'url') {
      usedRef.used += s.label.length;
      out.push(
        <a
          className="parsed-url"
          href={s.href}
          key={j}
          rel="noreferrer noopener"
          target="_blank"
        >
          {s.label}
        </a>,
      );
      return;
    }
    if (s.kind === 'mention') {
      usedRef.used += s.value.length;
      out.push(
        <span className="parsed-mention" key={j}>
          {s.value}
        </span>,
      );
      return;
    }
    if (s.kind === 'path') {
      usedRef.used += s.value.length;
      out.push(
        <code className="parsed-path" key={j}>
          {s.value}
        </code>,
      );
      return;
    }
    if (s.kind === 'marker') {
      usedRef.used += s.value.length;
      out.push(
        <span className={`parsed-marker parsed-marker-${s.tone}`} key={j}>
          {s.value}
        </span>,
      );
      return;
    }
  });
  return out;
}

function ParsedBody({
  text,
  truncate,
}: {
  text: string | null | undefined;
  truncate?: number;
}): ReactNode {
  const cleaned = useMemo(() => {
    if (!text) return '';
    let out = text
      .replace(SECRET_ASSIGNMENT_RE, (_m, key) => `${key}=***`)
      .replace(SECRET_VALUE_RE, '***');
    if (truncate && out.length > truncate) {
      out = out.slice(0, truncate) + '…';
    }
    return out;
  }, [text, truncate]);

  if (!cleaned.trim()) {
    return <span className="parsed-empty">—</span>;
  }

  return (
    <div className="parsed-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{cleaned}</ReactMarkdown>
    </div>
  );
}

function isInternalProtocolPayload(
  content: string | null | undefined,
): boolean {
  if (!content) return false;
  if (/<\/?(sub-agent[-\w]*|tool-call|internal)\b/i.test(content)) return true;
  if (/"author"\s*:\s*"[^"]+"\s*,\s*"recipient"\s*:\s*"[^"]+"/.test(content)) {
    return true;
  }
  return false;
}

function senderRoleClass(value: string | null | undefined): string {
  const v = (value ?? '').toLowerCase();
  if (v.includes('오너') || v.includes('owner')) return 'role-owner';
  if (v.includes('리뷰어') || v.includes('reviewer')) return 'role-reviewer';
  if (v.includes('중재자') || v.includes('arbiter')) return 'role-arbiter';
  if (v.includes('cron') || v.includes('sentry') || v.includes('webhook'))
    return 'role-cron';
  return 'role-human';
}

function sanitizeInboxText(value: string | null | undefined): string {
  if (!value) return '';
  return value
    .replace(/<\/?internal[^>]*>/gi, '')
    .replace(/<\/?intern\.{3}/gi, '')
    .replace(/<\/?[a-z][a-z0-9-]*[^>]*>/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function formatDate(value: string | null | undefined, locale: Locale): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const now = Date.now();
  const ageMs = now - date.getTime();
  if (ageMs >= 0 && ageMs < 60_000) {
    return locale === 'ko'
      ? '방금'
      : locale === 'ja'
        ? 'たった今'
        : locale === 'zh'
          ? '刚刚'
          : 'just now';
  }
  if (ageMs >= 0 && ageMs < 3_600_000) {
    const mins = Math.floor(ageMs / 60_000);
    return locale === 'ko'
      ? `${mins}분 전`
      : locale === 'ja'
        ? `${mins}分前`
        : locale === 'zh'
          ? `${mins} 分钟前`
          : `${mins}m ago`;
  }
  const sameDay = new Date().toDateString() === date.toDateString();
  if (sameDay) {
    return new Intl.DateTimeFormat(localeTags[locale], {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date);
  }
  const time = new Intl.DateTimeFormat(localeTags[locale], {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
  if (locale === 'ko')
    return `${date.getMonth() + 1}월 ${date.getDate()}일 ${time}`;
  if (locale === 'ja')
    return `${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
  if (locale === 'zh')
    return `${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
  return new Intl.DateTimeFormat(localeTags[locale], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function dashboardAgeMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return Math.max(0, Date.now() - date.getTime());
}

function dashboardFreshness(
  online: boolean,
  generatedAt: string | null | undefined,
): FreshnessLevel {
  if (!online) return 'offline';
  const age = dashboardAgeMs(generatedAt);
  if (age !== null && age > DASHBOARD_STALE_MS) return 'stale';
  return 'fresh';
}

function freshnessLabel(level: FreshnessLevel, t: Messages): string {
  if (level === 'offline') return t.pwa.offline;
  if (level === 'stale') return t.pwa.stale;
  return t.pwa.fresh;
}

function isStandaloneDisplay(): boolean {
  if (typeof window === 'undefined') return false;
  const standaloneNavigator = navigator as Navigator & { standalone?: boolean };
  return (
    standaloneNavigator.standalone === true ||
    (typeof window.matchMedia === 'function' &&
      window.matchMedia('(display-mode: standalone)').matches)
  );
}

function canUsePwaCore(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    'serviceWorker' in navigator
  );
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

function formatPct(value: number): string {
  if (value < 0) return '-';
  return `${Math.round(value)}%`;
}

function usagePeak(row: UsageRow): number {
  return Math.max(row.h5pct, row.d7pct);
}

function usageLimitWindow(row: UsageRow): UsageLimitWindow {
  return row.d7pct >= row.h5pct ? 'd7' : 'h5';
}

function usageWindowRemaining(
  row: UsageRow,
  window: UsageLimitWindow,
): number | null {
  const pct = window === 'h5' ? row.h5pct : row.d7pct;
  if (pct < 0) return null;
  return Math.max(0, 100 - pct);
}

function usageRiskLevel(row: UsageRow): RiskLevel {
  const peak = usagePeak(row);
  if (peak >= 85) return 'critical';
  if (peak >= 65) return 'warn';
  return 'ok';
}

function usageActive(row: UsageRow): boolean {
  return row.name.includes('*');
}

function usageLimited(row: UsageRow): boolean {
  return row.name.includes('!');
}

function usageNameParts(row: UsageRow): {
  account: string;
  plan: string | null;
} {
  const cleaned = row.name.replace(/[*!]/g, '').replace(/\s+/g, ' ').trim();
  const parts = cleaned.split(' ');
  const plan = parts.at(-1) ?? null;
  if (plan && ['max', 'mid', 'pro', 'team'].includes(plan.toLowerCase())) {
    return { account: parts.slice(0, -1).join(' ') || cleaned, plan };
  }
  return { account: cleaned, plan: null };
}

function usageWindowReset(row: UsageRow, window: UsageLimitWindow): string {
  return (window === 'd7' ? row.d7reset : row.h5reset).trim();
}

function usageBurnRate(row: UsageRow): number | null {
  if (row.h5pct < 0) return null;
  return row.h5pct / 5;
}

function usageSpeedLevel(rate: number | null): RiskLevel {
  if (rate === null) return 'ok';
  if (rate >= 12) return 'critical';
  if (rate >= 7) return 'warn';
  return 'ok';
}

function formatUsageRate(rate: number | null): string {
  if (rate === null) return '-';
  if (rate > 0 && rate < 1) return '<1%/h';
  return `${Math.round(rate)}%/h`;
}

function usageGroup(row: UsageRow): UsageGroup {
  return row.name.toLowerCase().startsWith('codex') ? 'codex' : 'primary';
}

function statusLabel(status: string, t: Messages): string {
  if (status in t.status) return t.status[status as keyof Messages['status']];
  return status;
}

function formatDuration(value: number | null, t: Messages): string {
  if (value === null) return '-';
  const seconds = Math.floor(value / 1000);
  if (seconds < 60) return `${seconds}${t.units.second}`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}${t.units.minute}`;
  const hours = Math.floor(minutes / 60);
  return `${hours}${t.units.hour} ${minutes % 60}${t.units.minute}`;
}

function formatLiveElapsed(value: number, t: Messages): string {
  const seconds = Math.max(0, Math.floor(value / 1000));
  if (seconds < 60) return `${seconds}${t.units.second}`;
  const minutes = Math.floor(seconds / 60);
  const remSec = seconds % 60;
  if (minutes < 60)
    return `${minutes}${t.units.minute} ${remSec}${t.units.second}`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return `${hours}${t.units.hour} ${remMin}${t.units.minute} ${remSec}${t.units.second}`;
}

function queueLabel(
  pendingTasks: number,
  pendingMessages: boolean,
  t: Messages,
) {
  const parts = [`${pendingTasks} ${t.units.task}`];
  if (pendingMessages) parts.push(t.units.messageShort);
  return parts.join(' · ');
}

const SECRET_ASSIGNMENT_RE =
  /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|AUTH|PRIVATE_KEY)[A-Z0-9_]*)\s*=\s*([^\s"'`]+)/gi;
const SECRET_VALUE_RE =
  /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,})\b/g;

function safePreview(
  value: string | null | undefined,
  fallback: string,
): string {
  const cleaned = (value ?? '')
    .replace(SECRET_ASSIGNMENT_RE, '$1=<redacted>')
    .replace(SECRET_VALUE_RE, '<redacted-token>')
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

function taskActionsFor(task: DashboardTask): DashboardTaskAction[] {
  if (task.status === 'active') return ['pause', 'cancel'];
  if (task.status === 'paused') return ['resume', 'cancel'];
  return [];
}

function buildRoomOptions(snapshots: StatusSnapshot[]): RoomOption[] {
  const rooms = new Map<string, RoomOption>();
  for (const snapshot of snapshots) {
    for (const entry of snapshot.entries) {
      if (!rooms.has(entry.jid)) {
        rooms.set(entry.jid, {
          jid: entry.jid,
          name: entry.name || entry.folder || entry.jid,
          folder: entry.folder,
        });
      }
    }
  }
  return [...rooms.values()].sort((a, b) =>
    `${a.name} ${a.folder}`.localeCompare(`${b.name} ${b.folder}`),
  );
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

const INBOX_FILTERS: InboxFilter[] = [
  'all',
  'ci-failure',
  'approval',
  'reviewer-request',
  'arbiter-request',
  'pending-room',
  'mention',
];

function serviceAgeMs(
  service: DashboardOverview['services'][number],
  generatedAt: string,
): number | null {
  const updated = new Date(service.updatedAt).getTime();
  const now = new Date(generatedAt).getTime();
  if (Number.isNaN(updated) || Number.isNaN(now)) return null;
  return Math.max(0, now - updated);
}

function serviceHealthLevel(
  service: DashboardOverview['services'][number],
  generatedAt: string,
): HealthLevel {
  const age = serviceAgeMs(service, generatedAt);
  if (age === null) return 'stale';
  if (age >= HEALTH_DOWN_MS) return 'down';
  if (age >= HEALTH_STALE_MS) return 'stale';
  return 'ok';
}

function inboxTargetHref(item: InboxItem): string | null {
  if (item.taskId) return '#/scheduled';
  if (item.roomJid || item.groupFolder) return '#/rooms';
  return null;
}

const NAV_ICONS: Record<DashboardView, ReactNode> = {
  usage: <Gauge size={20} strokeWidth={2} aria-hidden />,
  inbox: <InboxIcon size={20} strokeWidth={2} aria-hidden />,
  health: <Activity size={20} strokeWidth={2} aria-hidden />,
  rooms: <MessageSquare size={20} strokeWidth={2} aria-hidden />,
  scheduled: <Clock size={20} strokeWidth={2} aria-hidden />,
  settings: <Settings size={20} strokeWidth={2} aria-hidden />,
};

function navItems(t: Messages) {
  return [
    { href: '#/rooms', label: t.nav.rooms, view: 'rooms' as const },
    { href: '#/inbox', label: t.nav.inbox, view: 'inbox' as const },
    { href: '#/scheduled', label: t.nav.scheduled, view: 'scheduled' as const },
    { href: '#/health', label: t.nav.health, view: 'health' as const },
    { href: '#/usage', label: t.nav.usage, view: 'usage' as const },
    { href: '#/settings', label: t.nav.settings, view: 'settings' as const },
  ];
}

function EmptyState({ children }: { children: ReactNode }) {
  return <div className="empty-state">{children}</div>;
}

function LanguageSelector({
  locale,
  onLocaleChange,
  t,
}: {
  locale: Locale;
  onLocaleChange: (locale: Locale) => void;
  t: Messages;
}) {
  return (
    <label className="language-select">
      <span>{t.language.label}</span>
      <select
        aria-label={t.language.label}
        onChange={(event) => onLocaleChange(event.target.value as Locale)}
        value={locale}
      >
        {LOCALES.map((item) => (
          <option key={item} value={item}>
            {languageNames[item]}
          </option>
        ))}
      </select>
    </label>
  );
}

function SettingsPanel({
  locale,
  nickname,
  onLocaleChange,
  onNicknameChange,
  onRestartStack,
  t,
}: {
  locale: Locale;
  nickname: string;
  onLocaleChange: (locale: Locale) => void;
  onNicknameChange: (next: string) => void;
  onRestartStack: () => void;
  t: Messages;
}) {
  return (
    <div className="settings-panel">
      <section className="settings-section">
        <h3>일반</h3>
        <label className="settings-row">
          <span className="settings-label">{t.settings.nicknameLabel}</span>
          <input
            maxLength={32}
            onChange={(event) => onNicknameChange(event.target.value)}
            placeholder={t.settings.nicknamePlaceholder}
            type="text"
            value={nickname}
          />
          <small className="settings-hint">{t.settings.nicknameHelp}</small>
        </label>
        <label className="settings-row">
          <span className="settings-label">{t.settings.languageLabel}</span>
          <select
            aria-label={t.settings.languageLabel}
            onChange={(event) => onLocaleChange(event.target.value as Locale)}
            value={locale}
          >
            {LOCALES.map((item) => (
              <option key={item} value={item}>
                {languageNames[item]}
              </option>
            ))}
          </select>
        </label>
      </section>

      <ModelSettings onRestartStack={onRestartStack} />

      <FastModeSettings />

      <AccountSettings onRestartStack={onRestartStack} />
    </div>
  );
}

function ModelSettings({ onRestartStack }: { onRestartStack: () => void }) {
  const [config, setConfig] = useState<ModelConfigSnapshot | null>(null);
  const [draft, setDraft] = useState<ModelConfigSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    fetchModelConfig()
      .then((c) => {
        if (cancelled) return;
        setConfig(c);
        setDraft(c);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function save() {
    if (!draft || !config) return;
    setBusy(true);
    setError(null);
    try {
      const next = await updateModels(draft);
      setConfig(next);
      setDraft(next);
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function setRole(
    role: keyof ModelConfigSnapshot,
    patch: Partial<ModelRoleConfig>,
  ) {
    setDraft((prev) =>
      prev
        ? {
            ...prev,
            [role]: { ...prev[role], ...patch },
          }
        : prev,
    );
  }

  const dirty =
    draft !== null &&
    config !== null &&
    JSON.stringify(draft) !== JSON.stringify(config);

  return (
    <section className="settings-section">
      <h3>모델</h3>
      {error ? <p className="settings-error">{error}</p> : null}
      {!draft ? (
        <p className="settings-hint">
          {busy ? '불러오는 중…' : '모델 정보 없음'}
        </p>
      ) : (
        <>
          {(['owner', 'reviewer', 'arbiter'] as const).map((role) => (
            <div className="settings-row settings-row-inline" key={role}>
              <span className="settings-label">{role}</span>
              <input
                aria-label={`${role} model`}
                onChange={(e) => setRole(role, { model: e.target.value })}
                placeholder="claude / codex / claude-opus-4-7 …"
                type="text"
                value={draft[role].model}
              />
              <input
                aria-label={`${role} effort`}
                className="settings-input-narrow"
                onChange={(e) => setRole(role, { effort: e.target.value })}
                placeholder="effort"
                type="text"
                value={draft[role].effort}
              />
            </div>
          ))}
          <div className="settings-actions">
            <button
              className="settings-save"
              disabled={!dirty || busy}
              onClick={() => void save()}
              type="button"
            >
              {busy ? '저장 중…' : '저장'}
            </button>
            {savedAt && !dirty ? (
              <small className="settings-hint">
                저장됨. 적용하려면 스택 재시작 필요.
              </small>
            ) : null}
            <button
              className="settings-restart"
              disabled={busy}
              onClick={() => {
                if (
                  window.confirm(
                    '스택을 재시작하면 진행 중인 모든 에이전트 작업이 중단됩니다. 진행할까요?',
                  )
                ) {
                  onRestartStack();
                }
              }}
              type="button"
            >
              스택 재시작
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function FastModeSettings() {
  const [state, setState] = useState<FastModeSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchFastMode()
      .then((s) => {
        if (cancelled) return;
        setState(s);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function toggle(provider: keyof FastModeSnapshot) {
    if (!state) return;
    const next = !state[provider];
    const optimistic = { ...state, [provider]: next };
    setState(optimistic);
    setBusy(true);
    setError(null);
    try {
      const fresh = await updateFastMode({ [provider]: next });
      setState(fresh);
    } catch (err) {
      setState(state);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-section">
      <h3>패스트 모드</h3>
      {error ? <p className="settings-error">{error}</p> : null}
      {!state ? (
        <p className="settings-hint">불러오는 중…</p>
      ) : (
        <>
          <label className="settings-toggle-row">
            <span className="settings-toggle-label">
              <span className="settings-toggle-title">Codex (GPT)</span>
              <small className="settings-hint">
                ~/.codex/config.toml [features].fast_mode — 사용량 더 소모하지만
                응답이 빨라집니다.
              </small>
            </span>
            <input
              checked={state.codex}
              disabled={busy}
              onChange={() => void toggle('codex')}
              type="checkbox"
            />
          </label>
          <label className="settings-toggle-row">
            <span className="settings-toggle-label">
              <span className="settings-toggle-title">Claude</span>
              <small className="settings-hint">
                ~/.claude/settings.json fastMode — 인터랙티브 세션의 /fast 와
                동일 키. opus-4-6 한정으로 동작.
              </small>
            </span>
            <input
              checked={state.claude}
              disabled={busy}
              onChange={() => void toggle('claude')}
              type="checkbox"
            />
          </label>
        </>
      )}
    </section>
  );
}

function formatExpiry(
  iso: string | null,
): { label: string; cls: string } | null {
  if (!iso) return null;
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return null;
  const days = (dt.getTime() - Date.now()) / 86400000;
  const dateStr = dt.toLocaleDateString('ko-KR', {
    year: '2-digit',
    month: '2-digit',
    day: '2-digit',
  });
  if (days < 0) {
    const ago = Math.ceil(-days);
    return {
      label: `결제 만료 ${dateStr} (${ago}일 전)`,
      cls: 'is-expired',
    };
  }
  if (days < 7) {
    return {
      label: `결제 ${dateStr}까지 (${Math.floor(days)}일)`,
      cls: 'is-soon',
    };
  }
  return {
    label: `결제 ${dateStr}까지 (${Math.floor(days)}일)`,
    cls: 'is-active',
  };
}

function AccountSettings({ onRestartStack }: { onRestartStack: () => void }) {
  const [data, setData] = useState<{
    claude: ClaudeAccountSummary[];
    codex: CodexAccountSummary[];
    codexCurrentIndex?: number;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [perRowBusy, setPerRowBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tokenInput, setTokenInput] = useState('');

  async function refresh() {
    setBusy(true);
    setError(null);
    try {
      const fresh = await fetchAccounts();
      setData(fresh);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function handleDelete(provider: 'claude' | 'codex', index: number) {
    if (
      !window.confirm(
        `${provider} 계정 #${index} 디렉터리를 삭제합니다. 되돌릴 수 없습니다. 계속할까요?`,
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await deleteAccount(provider, index);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleAdd() {
    const token = tokenInput.trim();
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      await addClaudeAccount(token);
      setTokenInput('');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleCodexRefresh(index: number) {
    setPerRowBusy(`refresh:${index}`);
    setError(null);
    try {
      await refreshCodexAccountApi(index);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPerRowBusy(null);
    }
  }

  async function handleRefreshAllCodex() {
    setBusy(true);
    setError(null);
    try {
      const result = await refreshAllCodexAccountsApi();
      await refresh();
      if (result.failed.length > 0) {
        setError(
          `일부 갱신 실패: ${result.failed.map((f) => `#${f.index}`).join(', ')}`,
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleSwitchCodex(index: number) {
    setPerRowBusy(`switch:${index}`);
    setError(null);
    try {
      await setCurrentCodexAccountApi(index);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPerRowBusy(null);
    }
  }

  return (
    <section className="settings-section">
      <h3>계정</h3>
      {error ? <p className="settings-error">{error}</p> : null}

      <div className="settings-account-group">
        <h4>Claude</h4>
        {!data ? (
          <p className="settings-hint">{busy ? '불러오는 중…' : '없음'}</p>
        ) : data.claude.length === 0 ? (
          <p className="settings-hint">계정 없음</p>
        ) : (
          <ul className="settings-account-list">
            {data.claude.map((acc) => (
              <li key={acc.index} className="settings-account-row">
                <div className="settings-account-main">
                  <span className="settings-account-tag">#{acc.index}</span>
                  <span className="settings-account-email">
                    {acc.subscriptionType ?? 'unknown'}
                    {acc.rateLimitTier ? ` · ${acc.rateLimitTier}` : ''}
                  </span>
                  <span className="settings-account-plan">claude</span>
                  <span className="settings-account-badge is-active">
                    토큰 자동갱신
                  </span>
                </div>
                {acc.index > 0 ? (
                  <button
                    className="settings-delete"
                    disabled={busy}
                    onClick={() => void handleDelete('claude', acc.index)}
                    type="button"
                  >
                    삭제
                  </button>
                ) : (
                  <span className="settings-account-default">기본</span>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="settings-add-token">
          <textarea
            onChange={(e) => setTokenInput(e.target.value)}
            placeholder="Claude OAuth 토큰 (claude CLI 로그인 후 ~/.claude/.credentials.json 에서 accessToken 값을 페이스트)"
            rows={2}
            value={tokenInput}
          />
          <button
            disabled={!tokenInput.trim() || busy}
            onClick={() => void handleAdd()}
            type="button"
          >
            추가
          </button>
        </div>
      </div>

      <div className="settings-account-group">
        <div className="settings-account-group-head">
          <h4>Codex</h4>
          <button
            className="settings-secondary"
            disabled={busy}
            onClick={() => void handleRefreshAllCodex()}
            type="button"
          >
            전체 갱신
          </button>
        </div>
        {!data ? (
          <p className="settings-hint">{busy ? '불러오는 중…' : '없음'}</p>
        ) : data.codex.length === 0 ? (
          <p className="settings-hint">계정 없음</p>
        ) : (
          <ul className="settings-account-list">
            {data.codex.map((acc) => {
              const expiry = formatExpiry(acc.subscriptionUntil);
              const isActive = data.codexCurrentIndex === acc.index;
              const refreshing = perRowBusy === `refresh:${acc.index}`;
              const switching = perRowBusy === `switch:${acc.index}`;
              return (
                <li
                  key={acc.index}
                  className={`settings-account-row${isActive ? ' is-active-account' : ''}`}
                >
                  <div className="settings-account-main">
                    <span className="settings-account-tag">
                      {isActive ? '●' : ''}#{acc.index}
                    </span>
                    {acc.email ? (
                      <span
                        className="settings-account-email"
                        title={acc.email}
                      >
                        {acc.email}
                      </span>
                    ) : null}
                    <span className="settings-account-plan">
                      {acc.planType ?? 'unknown'}
                    </span>
                    {expiry ? (
                      <span
                        className={`settings-account-badge ${expiry.cls}`}
                        title={
                          acc.subscriptionLastChecked
                            ? `last checked: ${acc.subscriptionLastChecked.slice(0, 10)}`
                            : undefined
                        }
                      >
                        {expiry.label}
                      </span>
                    ) : null}
                  </div>
                  <div className="settings-account-actions">
                    <button
                      className="settings-secondary"
                      disabled={busy || perRowBusy !== null}
                      onClick={() => void handleCodexRefresh(acc.index)}
                      title="OAuth 토큰을 다시 받아 구독 상태를 갱신합니다"
                      type="button"
                    >
                      {refreshing ? '갱신중…' : '갱신'}
                    </button>
                    {!isActive ? (
                      <button
                        className="settings-secondary"
                        disabled={busy || perRowBusy !== null}
                        onClick={() => void handleSwitchCodex(acc.index)}
                        title="이 계정으로 즉시 전환합니다 (다음 codex 호출부터 적용)"
                        type="button"
                      >
                        {switching ? '전환중…' : '전환'}
                      </button>
                    ) : (
                      <span className="settings-account-default">사용중</span>
                    )}
                    {acc.index > 0 ? (
                      <button
                        className="settings-delete"
                        disabled={busy || perRowBusy !== null}
                        onClick={() => void handleDelete('codex', acc.index)}
                        type="button"
                      >
                        삭제
                      </button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <p className="settings-hint">
          OAuth 토큰은 6시간마다 자동 갱신됩니다. plan 변경/해지가 즉시 반영되게
          하려면 수동으로 “전체 갱신”을 누르세요.
        </p>
      </div>

      <div className="settings-actions">
        <button
          className="settings-restart"
          disabled={busy}
          onClick={() => {
            if (
              window.confirm(
                '스택을 재시작하면 진행 중인 모든 에이전트 작업이 중단됩니다. 진행할까요?',
              )
            ) {
              onRestartStack();
            }
          }}
          type="button"
        >
          스택 재시작 (변경 적용)
        </button>
      </div>
    </section>
  );
}

function LoadingSkeleton({ t }: { t: Messages }) {
  return (
    <main className="shell shell-loading" aria-busy="true">
      <section className="section-nav skeleton-topbar">
        <span className="skeleton-button" />
        <span className="skeleton-line skeleton-copy" />
        <span className="skeleton-button" />
      </section>
      <section className="skeleton-grid" aria-label={t.app.loading}>
        {Array.from({ length: 4 }, (_, index) => (
          <div className="card skeleton-card" key={index}>
            <span className="skeleton-line skeleton-short" />
            <span className="skeleton-line skeleton-number" />
            <span className="skeleton-line skeleton-copy" />
          </div>
        ))}
      </section>
    </main>
  );
}

function SideRail({
  activeView,
  canInstall,
  data,
  installed,
  onNavigate,
  onInstall,
  onRefresh,
  online,
  offlineReady,
  refreshing,
  secureContext,
  t,
}: {
  activeView: DashboardView;
  canInstall: boolean;
  data: DashboardState | null;
  installed: boolean;
  onNavigate: (view: DashboardView) => void;
  onInstall: () => void;
  onRefresh: () => void;
  online: boolean;
  offlineReady: boolean;
  refreshing: boolean;
  secureContext: boolean;
  t: Messages;
}) {
  const pwaState = !secureContext
    ? t.pwa.secureRequired
    : installed
      ? t.pwa.installed
      : offlineReady
        ? t.pwa.ready
        : t.pwa.app;

  const stats = data
    ? (() => {
        const queue = data.snapshots.reduce(
          (acc, snapshot) => {
            for (const entry of snapshot.entries) {
              acc.pendingTasks += entry.pendingTasks;
              if (entry.pendingMessages) acc.pendingMessageRooms += 1;
              if (entry.status === 'processing') acc.processing += 1;
            }
            return acc;
          },
          { pendingTasks: 0, pendingMessageRooms: 0, processing: 0 },
        );
        return {
          rooms: data.overview.rooms,
          inbox: data.overview.inbox.length,
          processing: queue.processing,
          pendingTasks: queue.pendingTasks,
          pendingMessageRooms: queue.pendingMessageRooms,
        };
      })()
    : null;

  return (
    <aside className="side-rail icon-rail" aria-label={t.nav.drawerAria}>
      <a
        className="rail-brand"
        href="#/usage"
        onClick={() => onNavigate('usage')}
        title="EJClaw"
      >
        EJ
      </a>
      <nav className="rail-nav" aria-label={t.nav.drawerNavAria}>
        {navItems(t).map((item) => {
          const badge =
            item.view === 'inbox' && stats && stats.inbox > 0
              ? stats.inbox
              : item.view === 'rooms' && stats && stats.processing > 0
                ? stats.processing
                : null;
          return (
            <a
              aria-current={activeView === item.view ? 'page' : undefined}
              aria-label={item.label}
              className={`rail-item${activeView === item.view ? ' is-active' : ''}`}
              href={item.href}
              key={item.href}
              onClick={() => onNavigate(item.view)}
              title={item.label}
            >
              <span className="rail-icon">{NAV_ICONS[item.view]}</span>
              {badge !== null ? (
                <span className="rail-badge">{badge}</span>
              ) : null}
            </a>
          );
        })}
      </nav>
      <div className="rail-foot">
        <span
          className={`rail-status-dot ${online ? 'is-online' : 'is-offline'}`}
          title={`${online ? t.pwa.online : t.pwa.offline} · ${pwaState}`}
          aria-label={`${online ? t.pwa.online : t.pwa.offline}`}
        />
        {canInstall ? (
          <button
            className="rail-btn"
            onClick={onInstall}
            title={t.pwa.install}
            aria-label={t.pwa.install}
            type="button"
          >
            <Download size={16} strokeWidth={2} aria-hidden />
          </button>
        ) : null}
        <button
          aria-busy={refreshing}
          aria-label={t.actions.refresh}
          className={`rail-btn${refreshing ? ' is-spinning' : ''}`}
          disabled={refreshing}
          onClick={onRefresh}
          title={refreshing ? t.actions.refreshing : t.actions.refresh}
          type="button"
        >
          <RefreshCw size={16} strokeWidth={2} aria-hidden />
        </button>
      </div>
    </aside>
  );
}

function SectionNav({
  activeView,
  drawerOpen,
  freshness,
  installed,
  locale,
  canInstall,
  onCloseDrawer,
  onInstall,
  onLocaleChange,
  onNavigate,
  onOpenDrawer,
  offlineReady,
  refreshing,
  onRefresh,
  secureContext,
  t,
}: {
  activeView: DashboardView;
  drawerOpen: boolean;
  freshness: FreshnessLevel;
  installed: boolean;
  locale: Locale;
  canInstall: boolean;
  onCloseDrawer: () => void;
  onInstall: () => void;
  onLocaleChange: (locale: Locale) => void;
  onNavigate: (view: DashboardView) => void;
  onOpenDrawer: () => void;
  offlineReady: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  secureContext: boolean;
  t: Messages;
}) {
  const activeLabel =
    navItems(t).find((item) => item.view === activeView)?.label ?? t.nav.rooms;

  return (
    <>
      <nav className="section-nav" aria-label={t.nav.aria}>
        <button
          aria-controls="dashboard-menu"
          aria-expanded={drawerOpen}
          aria-label={drawerOpen ? t.nav.menuClose : t.nav.menuOpen}
          className="menu-button"
          onClick={drawerOpen ? onCloseDrawer : onOpenDrawer}
          type="button"
        >
          <span />
          <span />
          <span />
        </button>
        <strong className="topbar-label">{activeLabel}</strong>
        <span className={`topbar-status topbar-status-${freshness}`}>
          {freshnessLabel(freshness, t)}
        </span>
        <button
          aria-busy={refreshing}
          aria-label={refreshing ? t.actions.refreshing : t.actions.refresh}
          className="refresh-button"
          disabled={refreshing}
          onClick={onRefresh}
          type="button"
        >
          {refreshing ? '...' : t.actions.refresh}
        </button>
      </nav>

      {drawerOpen ? (
        <>
          <button
            aria-label={t.nav.menuClose}
            className="drawer-backdrop"
            onClick={onCloseDrawer}
            type="button"
          />
          <aside
            aria-label={t.nav.drawerAria}
            aria-modal="true"
            className="nav-drawer"
            id="dashboard-menu"
            role="dialog"
          >
            <div className="drawer-head">
              <div>
                <span className="eyebrow">EJClaw</span>
                <strong>{t.nav.operations}</strong>
              </div>
              <button
                aria-label={t.nav.menuClose}
                onClick={onCloseDrawer}
                type="button"
              >
                {t.actions.close}
              </button>
            </div>
            <nav aria-label={t.nav.drawerNavAria}>
              {navItems(t).map((item) => (
                <a
                  aria-current={activeView === item.view ? 'page' : undefined}
                  className={activeView === item.view ? 'is-active' : undefined}
                  href={item.href}
                  key={item.href}
                  onClick={() => {
                    onNavigate(item.view);
                    onCloseDrawer();
                  }}
                >
                  {item.label}
                </a>
              ))}
            </nav>
            <div className="drawer-pwa-row">
              <span>
                {!secureContext
                  ? t.pwa.secureRequired
                  : installed
                    ? t.pwa.installed
                    : offlineReady
                      ? t.pwa.ready
                      : t.pwa.app}
              </span>
              {canInstall ? (
                <button onClick={onInstall} type="button">
                  {t.pwa.install}
                </button>
              ) : null}
            </div>
          </aside>
        </>
      ) : null}
    </>
  );
}

function ControlRail({
  canInstall,
  data,
  installed,
  locale,
  offlineReady,
  onInstall,
  online,
  secureContext,
  t,
}: {
  canInstall: boolean;
  data: DashboardState;
  installed: boolean;
  locale: Locale;
  offlineReady: boolean;
  onInstall: () => void;
  online: boolean;
  secureContext: boolean;
  t: Messages;
}) {
  const queue = data.snapshots.reduce(
    (acc, snapshot) => {
      for (const entry of snapshot.entries) {
        acc.pendingTasks += entry.pendingTasks;
        if (entry.pendingMessages) acc.pendingMessageRooms += 1;
      }
      return acc;
    },
    { pendingTasks: 0, pendingMessageRooms: 0 },
  );
  const freshness = dashboardFreshness(online, data.overview.generatedAt);
  const age = dashboardAgeMs(data.overview.generatedAt);

  return (
    <section className="ops-strip" id="overview" aria-label={t.control.aria}>
      <div className={`ops-tile-freshness ops-${freshness}`}>
        <span>{t.pwa.updated}</span>
        <strong>{freshnessLabel(freshness, t)}</strong>
        <small>
          {formatDate(data.overview.generatedAt, locale)}
          {age === null ? '' : ` · ${formatDuration(age, t)}`}
        </small>
      </div>
      <div className="ops-tile-pwa">
        <span>{t.pwa.app}</span>
        <strong>
          {!secureContext
            ? t.pwa.secureRequired
            : installed
              ? t.pwa.installed
              : offlineReady
                ? t.pwa.ready
                : t.pwa.app}
        </strong>
        {canInstall ? (
          <button onClick={onInstall} type="button">
            {t.pwa.install}
          </button>
        ) : (
          <small>
            {!secureContext
              ? t.pwa.secureRequired
              : offlineReady
                ? t.pwa.cached
                : t.pwa.online}
          </small>
        )}
      </div>
      <div>
        <span>{t.metrics.rooms}</span>
        <strong>
          {data.overview.rooms.active + data.overview.rooms.waiting}/
          {data.overview.rooms.total}
        </strong>
        <small>{t.control.activeRooms}</small>
      </div>
      <div>
        <span>{t.control.queue}</span>
        <strong>{queue.pendingTasks}</strong>
        <small>
          {queue.pendingMessageRooms} {t.control.pendingRooms}
        </small>
      </div>
      <div>
        <span>{t.metrics.agents}</span>
        <strong>{data.overview.services.length}</strong>
        <small>{t.panels.heartbeat}</small>
      </div>
      <div>
        <span>{t.metrics.ciWatchers}</span>
        <strong>{data.overview.tasks.watchers.active}</strong>
        <small>
          {data.overview.tasks.watchers.paused} {t.status.paused}
        </small>
      </div>
    </section>
  );
}

function InboxPanel({
  overview,
  tasks,
  locale,
  onInboxAction,
  onTaskAction,
  inboxActionKey,
  taskActionKey,
  t,
}: {
  overview: DashboardOverview;
  tasks: DashboardTask[];
  locale: Locale;
  onInboxAction: (item: InboxItem, action: DashboardInboxAction) => void;
  onTaskAction: (task: DashboardTask, action: DashboardTaskAction) => void;
  inboxActionKey: InboxActionKey | null;
  taskActionKey: TaskActionKey | null;
  t: Messages;
}) {
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
        {filteredItems.map((item) => {
          const href = inboxTargetHref(item);
          const linkedTask =
            item.source === 'scheduled-task' && item.taskId
              ? tasks.find((task) => task.id === item.taskId)
              : undefined;
          const linkedTaskActions = linkedTask
            ? taskActionsFor(linkedTask)
            : [];
          const inboxActions = inboxActionsFor(item);
          return (
            <article
              className={`inbox-card inbox-${item.severity}`}
              key={item.id}
            >
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
              {linkedTask && linkedTaskActions.length > 0 ? (
                <div className="task-actions inbox-actions">
                  {linkedTaskActions.map((action) => {
                    const actionKey: TaskActionKey = `${linkedTask.id}:${action}`;
                    const busy = taskActionKey === actionKey;
                    return (
                      <button
                        aria-busy={busy || undefined}
                        className={`task-action task-action-${action}${busy ? ' is-busy' : ''}`}
                        disabled={busy}
                        key={action}
                        onClick={() => onTaskAction(linkedTask, action)}
                        type="button"
                      >
                        {busy ? t.tasks.actions.busy : t.tasks.actions[action]}
                      </button>
                    );
                  })}
                </div>
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
        })}
      </div>
    </div>
  );
}

function HealthPanel({
  data,
  locale,
  onRestartStack,
  serviceActionKey,
  t,
}: {
  data: DashboardState;
  locale: Locale;
  onRestartStack: () => void;
  serviceActionKey: ServiceActionKey | null;
  t: Messages;
}) {
  const services = data.overview.services;
  const restarts = data.overview.operations?.serviceRestarts ?? [];
  const serviceLevels = services.map((service) => ({
    service,
    level: serviceHealthLevel(service, data.overview.generatedAt),
    age: serviceAgeMs(service, data.overview.generatedAt),
  }));
  const down = serviceLevels.filter((item) => item.level === 'down').length;
  const stale = serviceLevels.filter((item) => item.level === 'stale').length;
  const queue = data.snapshots.reduce(
    (acc, snapshot) => {
      for (const entry of snapshot.entries) {
        acc.pendingTasks += entry.pendingTasks;
        if (entry.pendingMessages) acc.pendingMessageRooms += 1;
      }
      return acc;
    },
    { pendingTasks: 0, pendingMessageRooms: 0 },
  );
  const ciFailures = data.overview.inbox.reduce(
    (count, item) =>
      item.kind === 'ci-failure' ? count + item.occurrences : count,
    0,
  );
  const healthLevel: HealthLevel =
    down > 0 ? 'down' : stale > 0 || ciFailures > 0 ? 'stale' : 'ok';
  const affectedServices = serviceLevels.filter((item) => item.level !== 'ok');

  return (
    <div className="health-board">
      <section className={`health-overview health-${healthLevel}`}>
        <span className="eyebrow">{t.health.system}</span>
        <strong>{t.health.levels[healthLevel]}</strong>
      </section>

      <section className="health-signals" aria-label={t.health.signals}>
        <div>
          <span>{t.health.services}</span>
          <strong>
            {services.length - stale - down}/{services.length}
          </strong>
          <small>{t.health.fresh}</small>
        </div>
        <div>
          <span>{t.health.stale}</span>
          <strong>{stale + down}</strong>
          <small>
            {down} {t.health.levels.down}
          </small>
        </div>
        <div>
          <span>{t.health.queue}</span>
          <strong>{queue.pendingTasks}</strong>
          <small>
            {queue.pendingMessageRooms} {t.control.pendingRooms}
          </small>
        </div>
        <div>
          <span>{t.health.ciFailures}</span>
          <strong>{ciFailures}</strong>
        </div>
      </section>

      <section className="health-actions" aria-label={t.health.restart}>
        <div>
          <span className="eyebrow">{t.health.restart}</span>
          <strong>{t.health.restartStack}</strong>
          <small>{t.health.restartHint}</small>
        </div>
        <button
          disabled={serviceActionKey === 'stack:restart'}
          onClick={onRestartStack}
          type="button"
        >
          {serviceActionKey === 'stack:restart'
            ? t.health.restarting
            : t.health.restartStack}
        </button>
      </section>

      {restarts.length > 0 ? (
        <details className="health-restart-log">
          <summary>
            {t.health.restartLog}
            <strong>{restarts.length}</strong>
          </summary>
          <div className="health-restart-list">
            {restarts.map((restart) => {
              const pill =
                restart.status === 'success'
                  ? 'ok'
                  : restart.status === 'failed'
                    ? 'error'
                    : 'stale';
              return (
                <article className="health-restart-record" key={restart.id}>
                  <div>
                    <small>{t.health.restartTarget}</small>
                    <strong>{restart.target}</strong>
                  </div>
                  <span
                    aria-label={`${t.health.restartStatus}: ${restart.status}`}
                    className={`pill pill-${pill}`}
                  >
                    {restart.status}
                  </span>
                  <div>
                    <small>{t.health.restartRequested}</small>
                    <strong>{formatDate(restart.requestedAt, locale)}</strong>
                  </div>
                  <div>
                    <small>{t.health.restartServices}</small>
                    <strong>
                      {restart.services.length > 0
                        ? restart.services.join(', ')
                        : '-'}
                    </strong>
                  </div>
                  {restart.error ? (
                    <p className="health-restart-error">{restart.error}</p>
                  ) : null}
                </article>
              );
            })}
          </div>
        </details>
      ) : null}

      {services.length === 0 ? (
        <EmptyState>{t.service.empty}</EmptyState>
      ) : affectedServices.length === 0 ? null : (
        <details className="health-service-details">
          <summary>
            {t.health.affectedServices}
            <strong>{affectedServices.length}</strong>
          </summary>
          <div className="health-service-list">
            {affectedServices.map(({ service, level, age }) => (
              <article className="health-service" key={service.serviceId}>
                <div>
                  <strong>{service.assistantName || service.serviceId}</strong>
                </div>
                <span className={`pill pill-${level}`}>
                  {t.health.levels[level]}
                </span>
                <div>
                  <small>{t.service.updated}</small>
                  <strong>{formatDate(service.updatedAt, locale)}</strong>
                  <em>{formatDuration(age, t)}</em>
                </div>
                <div>
                  <small>{t.service.rooms}</small>
                  <strong>
                    {service.activeRooms}/{service.totalRooms}
                  </strong>
                </div>
              </article>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function RoomMessageForm({
  busy,
  onChange,
  onSubmit,
  t,
  value,
}: {
  busy: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
  t: Messages;
  value: string;
}) {
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

function RoomActivityPanel({
  activity,
  loading,
  locale,
  t,
}: {
  activity: DashboardRoomActivity | undefined;
  loading: boolean;
  locale: Locale;
  t: Messages;
}) {
  if (!activity) {
    return (
      <div className="room-activity room-activity-empty">
        {loading ? t.rooms.loadingActivity : t.rooms.noActivity}
      </div>
    );
  }

  const task = activity.pairedTask;
  const turn = task?.currentTurn ?? null;
  const outputs = task?.outputs ?? [];
  const latestOutput = outputs.at(-1) ?? null;
  const progressText = turn
    ? `${turn.role} · ${turn.intentKind} · ${t.rooms.attempt} ${turn.attemptNo}`
    : t.rooms.noTurn;

  return (
    <div className="room-activity">
      <div className="room-progress-strip">
        {turn ? (
          <span className={`pill pill-${turn.state}`}>
            {statusLabel(turn.state, t)}
          </span>
        ) : (
          <span className="pill pill-inactive">{t.rooms.noTurn}</span>
        )}
        <strong>{progressText}</strong>
        <span>{task ? `${t.rooms.round} ${task.roundTripCount}` : '-'}</span>
        {turn?.executorServiceId ? <span>{turn.executorServiceId}</span> : null}
        <time>{formatDate(turn?.updatedAt ?? task?.updatedAt, locale)}</time>
      </div>

      <section className="room-latest-output">
        <header>
          <strong>{t.rooms.latestOutput}</strong>
          {latestOutput ? (
            <span>
              #{latestOutput.turnNumber} · {latestOutput.role}
              {latestOutput.verdict ? ` · ${latestOutput.verdict}` : ''}
            </span>
          ) : null}
        </header>
        {latestOutput ? (
          <p>{latestOutput.outputText}</p>
        ) : (
          <p className="room-muted">{t.rooms.noOutput}</p>
        )}
      </section>

      <details className="room-activity-details">
        <summary>{t.rooms.details}</summary>
        <div className="room-detail-grid">
          <section>
            <strong>{t.rooms.task}</strong>
            <p className="room-muted">
              {task?.title || task?.id || t.rooms.noTask}
            </p>
            <div className="room-turn-line">
              {turn?.activeRunId ? (
                <span className="mono-chip">{turn.activeRunId}</span>
              ) : null}
              {turn?.lastError ? (
                <span className="room-activity-error">{turn.lastError}</span>
              ) : null}
            </div>
          </section>
          <section>
            <strong>{t.rooms.outputHistory}</strong>
            {outputs.length === 0 ? (
              <p className="room-muted">{t.rooms.noOutput}</p>
            ) : (
              <div className="room-output-list">
                {[...outputs].reverse().map((output) => (
                  <article key={output.id} className="room-output-item">
                    <header>
                      <span>
                        #{output.turnNumber} · {output.role}
                        {output.verdict ? ` · ${output.verdict}` : ''}
                      </span>
                      <time>{formatDate(output.createdAt, locale)}</time>
                    </header>
                    <p>{output.outputText}</p>
                  </article>
                ))}
              </div>
            )}
          </section>
          <section>
            <strong>{t.rooms.messageHistory}</strong>
            {activity.messages.length === 0 ? (
              <p className="room-muted">{t.rooms.noMessages}</p>
            ) : (
              <div className="room-message-list">
                {activity.messages.map((message) => (
                  <article
                    className={`room-message-item ${
                      message.isBotMessage ? 'room-message-bot' : ''
                    }`}
                    key={message.id}
                  >
                    <header>
                      <span>{message.senderName}</span>
                      <time>{formatDate(message.timestamp, locale)}</time>
                    </header>
                    <p>{message.content}</p>
                  </article>
                ))}
              </div>
            )}
          </section>
        </div>
      </details>
    </div>
  );
}

function RoomComposeDetails({
  busy,
  onChange,
  onSubmit,
  t,
  value,
}: {
  busy: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
  t: Messages;
  value: string;
}) {
  return (
    <details className="room-compose-details">
      <summary>{t.rooms.message}</summary>
      <RoomMessageForm
        busy={busy}
        onChange={onChange}
        onSubmit={onSubmit}
        t={t}
        value={value}
      />
    </details>
  );
}

function RoomPanel({
  onSendRoomMessage,
  roomActivity,
  roomActivityLoading,
  roomMessageKey,
  locale,
  snapshots,
  t,
}: {
  onSendRoomMessage: (
    roomJid: string,
    text: string,
    requestId: string,
  ) => Promise<boolean>;
  roomActivity: RoomActivityMap;
  roomActivityLoading: boolean;
  roomMessageKey: string | null;
  locale: Locale;
  snapshots: StatusSnapshot[];
  t: Messages;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const entries = snapshots.flatMap((snapshot) =>
    snapshot.entries.map((entry) => ({
      ...entry,
      serviceId: snapshot.serviceId,
    })),
  );

  if (entries.length === 0) {
    return <EmptyState>{t.rooms.empty}</EmptyState>;
  }

  function setDraft(jid: string, value: string) {
    setDrafts((previous) => ({ ...previous, [jid]: value }));
  }

  async function submitRoomMessage(jid: string) {
    const text = drafts[jid]?.trim();
    if (!text) return;
    const success = await onSendRoomMessage(jid, text, makeClientRequestId());
    if (success) {
      setDraft(jid, '');
    }
  }

  return (
    <>
      <div className="table-wrap desktop-table">
        <table>
          <thead>
            <tr>
              <th>{t.rooms.room}</th>
              <th>{t.rooms.status}</th>
              <th>{t.rooms.queue}</th>
              <th>{t.rooms.elapsed}</th>
              <th>{t.rooms.activity}</th>
              <th>{t.rooms.message}</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={`${entry.serviceId}:${entry.jid}`}>
                <td>
                  <strong>{entry.name}</strong>
                  <details className="record-details">
                    <summary>{t.rooms.details}</summary>
                    <span>
                      {entry.folder} · {entry.jid} · {entry.serviceId} ·{' '}
                      {entry.agentType}
                    </span>
                  </details>
                </td>
                <td>
                  <span className={`pill pill-${entry.status}`}>
                    {statusLabel(entry.status, t)}
                  </span>
                </td>
                <td>
                  {queueLabel(entry.pendingTasks, entry.pendingMessages, t)}
                </td>
                <td>{formatDuration(entry.elapsedMs, t)}</td>
                <td className="room-activity-cell">
                  <RoomActivityPanel
                    activity={roomActivity[entry.jid]}
                    loading={roomActivityLoading}
                    locale={locale}
                    t={t}
                  />
                </td>
                <td className="room-message-cell">
                  <RoomComposeDetails
                    busy={roomMessageKey === entry.jid}
                    onChange={(value) => setDraft(entry.jid, value)}
                    onSubmit={() => void submitRoomMessage(entry.jid)}
                    t={t}
                    value={drafts[entry.jid] ?? ''}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mobile-record-list" aria-label={t.rooms.cardsAria}>
        {entries.map((entry) => (
          <article
            className="record-card"
            key={`${entry.serviceId}:${entry.jid}`}
          >
            <div className="record-card-head">
              <div>
                <strong>{entry.name}</strong>
                <span className="mono-chip">{entry.folder}</span>
              </div>
              <span className={`pill pill-${entry.status}`}>
                {statusLabel(entry.status, t)}
              </span>
            </div>
            <div className="record-card-grid">
              <span>
                <small>{t.rooms.queue}</small>
                <strong>
                  {queueLabel(entry.pendingTasks, entry.pendingMessages, t)}
                </strong>
              </span>
              <span>
                <small>{t.rooms.elapsed}</small>
                <strong>{formatDuration(entry.elapsedMs, t)}</strong>
              </span>
            </div>
            <RoomActivityPanel
              activity={roomActivity[entry.jid]}
              loading={roomActivityLoading}
              locale={locale}
              t={t}
            />
            <RoomComposeDetails
              busy={roomMessageKey === entry.jid}
              onChange={(value) => setDraft(entry.jid, value)}
              onSubmit={() => void submitRoomMessage(entry.jid)}
              t={t}
              value={drafts[entry.jid] ?? ''}
            />
            <details className="record-details">
              <summary>{t.rooms.details}</summary>
              <p className="record-id">
                {entry.folder} · {entry.jid} · {entry.serviceId} ·{' '}
                {entry.agentType}
              </p>
            </details>
          </article>
        ))}
      </div>
    </>
  );
}

type RoomFilter = 'all' | 'processing' | 'waiting' | 'inactive';
type RoomSort = 'recent' | 'name' | 'queue';

const ROOM_FILTER_ORDER: RoomFilter[] = [
  'all',
  'processing',
  'waiting',
  'inactive',
];

function roomFilterLabel(f: RoomFilter, t: Messages): string {
  if (f === 'all') return t.rooms.filterAll;
  return statusLabel(f, t);
}

function roomSortLabel(s: RoomSort, t: Messages): string {
  if (s === 'recent') return t.rooms.sortRecent;
  if (s === 'queue') return t.rooms.sortQueue;
  return t.rooms.sortName;
}

interface RoomEntryWithService {
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

function RoomBoardV2({
  inbox,
  onSendRoomMessage,
  pendingMessages,
  roomActivity,
  roomActivityLoading,
  roomMessageKey,
  selectedJid,
  locale,
  onSelectedJidChange,
  snapshots,
  t,
}: {
  inbox: InboxItem[];
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
  locale: Locale;
  onSelectedJidChange: (jid: string | null) => void;
  snapshots: StatusSnapshot[];
  t: Messages;
}) {
  const [filter, setFilter] = useState<RoomFilter>('all');
  const [sort, setSort] = useState<RoomSort>('recent');
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const allEntries: RoomEntryWithService[] = snapshots.flatMap((snapshot) =>
    snapshot.entries.map((entry) => ({
      ...entry,
      serviceId: snapshot.serviceId,
    })),
  );

  const counts = {
    all: allEntries.length,
    processing: allEntries.filter((e) => e.status === 'processing').length,
    waiting: allEntries.filter((e) => e.status === 'waiting').length,
    inactive: allEntries.filter((e) => e.status === 'inactive').length,
  };

  const filtered = allEntries.filter(
    (e) => filter === 'all' || e.status === filter,
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
    sorted.find((e) => e.jid === selectedJid) ?? sorted[0] ?? null;

  useEffect(() => {
    const nextJid = selectedEntry?.jid ?? null;
    if (nextJid !== selectedJid) onSelectedJidChange(nextJid);
  }, [onSelectedJidChange, selectedEntry?.jid, selectedJid]);

  if (allEntries.length === 0) {
    return <EmptyState>{t.rooms.empty}</EmptyState>;
  }

  function setDraft(jid: string, value: string) {
    setDrafts((previous) => ({ ...previous, [jid]: value }));
  }

  function scrollDetailToBottom() {
    if (typeof window === 'undefined') return;
    const detail = document.querySelector(
      '.rooms-detail',
    ) as HTMLElement | null;
    if (!detail) return;
    const tick = (n: number) => {
      detail.scrollTop = detail.scrollHeight;
      if (n > 0) requestAnimationFrame(() => tick(n - 1));
    };
    requestAnimationFrame(() => tick(3));
  }

  async function submitRoomMessage(jid: string) {
    const text = drafts[jid]?.trim();
    if (!text) return;
    scrollDetailToBottom();
    const success = await onSendRoomMessage(jid, text, makeClientRequestId());
    if (success) {
      setDraft(jid, '');
      scrollDetailToBottom();
    }
  }

  return (
    <div className="rooms-v2">
      <div className="rooms-toolbar" role="toolbar" aria-label="Rooms filters">
        <div className="rooms-filters">
          {ROOM_FILTER_ORDER.map((f) => (
            <button
              aria-pressed={filter === f}
              className={filter === f ? 'is-active' : undefined}
              key={f}
              onClick={() => setFilter(f)}
              type="button"
            >
              {roomFilterLabel(f, t)}
              <span>{counts[f]}</span>
            </button>
          ))}
        </div>
        <label className="rooms-sort">
          <span>{t.rooms.sortLabel}</span>
          <select
            onChange={(e) => setSort(e.target.value as RoomSort)}
            value={sort}
          >
            <option value="recent">{roomSortLabel('recent', t)}</option>
            <option value="queue">{roomSortLabel('queue', t)}</option>
            <option value="name">{roomSortLabel('name', t)}</option>
          </select>
        </label>
      </div>

      {sorted.length === 0 ? (
        <EmptyState>{t.rooms.empty}</EmptyState>
      ) : (
        <div className="rooms-twopane">
          <aside className="rooms-list" aria-label={t.rooms.cardsAria}>
            {sorted.map((entry) => {
              const items = inbox.filter((it) => it.roomJid === entry.jid);
              const queue =
                entry.pendingTasks + (entry.pendingMessages ? 1 : 0);
              const active = (selectedEntry?.jid ?? null) === entry.jid;
              return (
                <button
                  aria-current={active ? 'page' : undefined}
                  className={`rooms-list-item status-${entry.status}${active ? ' is-active' : ''}`}
                  key={`${entry.serviceId}:${entry.jid}`}
                  onClick={() => onSelectedJidChange(entry.jid)}
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
                      title={items.map((i) => t.inbox.kinds[i.kind]).join(', ')}
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
          <main className="rooms-detail">
            {selectedEntry ? (
              <RoomCardV2
                activity={roomActivity[selectedEntry.jid]}
                activityLoading={roomActivityLoading}
                busy={roomMessageKey === selectedEntry.jid}
                draft={drafts[selectedEntry.jid] ?? ''}
                entry={selectedEntry}
                expanded={true}
                inboxItems={inbox.filter(
                  (item) => item.roomJid === selectedEntry.jid,
                )}
                key={`${selectedEntry.serviceId}:${selectedEntry.jid}`}
                locale={locale}
                onDraftChange={(v) => setDraft(selectedEntry.jid, v)}
                onSendMessage={() => void submitRoomMessage(selectedEntry.jid)}
                onToggle={() => {}}
                pendingMessages={pendingMessages[selectedEntry.jid] ?? []}
                pinned={true}
                t={t}
              />
            ) : (
              <EmptyState>{t.rooms.empty}</EmptyState>
            )}
          </main>
        </div>
      )}
    </div>
  );
}

function RoomCardV2({
  activity,
  activityLoading,
  busy,
  draft,
  entry,
  expanded,
  inboxItems,
  locale,
  onDraftChange,
  onSendMessage,
  onToggle,
  pendingMessages = [],
  pinned = false,
  t,
}: {
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
  pendingMessages?: Array<DashboardRoomActivity['messages'][number]>;
  pinned?: boolean;
  t: Messages;
}) {
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

  // Discord live-edit messages are stored with this 3-character invisible
  // prefix (TASK_STATUS_MESSAGE_PREFIX). When paired_turns.progress_text
  // hasn't been written yet (codex runner timing), fall back to scanning
  // the messages table for the most recent prefixed message — but only
  // ones from the current turn (timestamp >= turn.createdAt) and matching
  // the current turn's role to avoid showing a stale reviewer status while
  // owner is now speaking.
  const TASK_STATUS_PREFIX = '⁣⁣⁣';
  const liveStatusFallback = (() => {
    if (!isProcessing) return null;
    if (!turn) return null;
    if (turn.progressText && turn.progressText.trim()) return null;
    const turnStartMs = turn.createdAt ? new Date(turn.createdAt).getTime() : 0;
    const turnRole = senderRoleClass(turn.role); // role-owner / -reviewer / -arbiter / -human
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (!m.content.startsWith(TASK_STATUS_PREFIX)) continue;
      const ts = m.timestamp ? new Date(m.timestamp).getTime() : 0;
      if (ts < turnStartMs) continue;
      const senderRole = senderRoleClass(m.senderName);
      if (senderRole !== turnRole) continue;
      const body = m.content.slice(TASK_STATUS_PREFIX.length);
      const stripped = body.replace(/\n\n\d+[초smhMSH]?$/, '').trim();
      return stripped || null;
    }
    return null;
  })();
  const liveProgressDisplay =
    turn?.progressText && turn.progressText.trim()
      ? turn.progressText
      : liveStatusFallback;

  const messagesLen = messages.length;
  const outputsLen = outputs.length;
  const pendingLen = pendingMessages.length;
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
  }, [entry.jid, messagesLen, outputsLen, pendingLen]);
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
  }, [entry.jid]);

  const queueChips: string[] = [];
  if (entry.pendingTasks > 0)
    queueChips.push(`${entry.pendingTasks} ${t.rooms.tasks}`);
  if (entry.pendingMessages) queueChips.push(t.rooms.queueWaitingMessages);
  const lastUpdated = turn?.updatedAt ?? task?.updatedAt ?? null;
  const WATCHER_RE =
    /^\s*(?:CI 완료|Build |Deploy |Lint |Release |\[CI\]|\[Watcher\]|GitHub Actions)/i;
  const isWatcherMsg = (m: (typeof messages)[number]) =>
    m.sourceKind === 'bot' && WATCHER_RE.test(m.content);
  const isCronTriggerMsg = (m: (typeof messages)[number]) =>
    m.sourceKind === 'trusted_external_bot';
  const lastWatcher = [...messages].reverse().find(isWatcherMsg) ?? null;
  const watcherCount = messages.filter(isWatcherMsg).length;
  const watcherMessages = messages.filter(isWatcherMsg);
  type ThreadEntry = {
    id: string;
    senderName: string;
    content: string;
    timestamp: string;
    isFromMe: boolean;
    isBotMessage: boolean;
    sourceKind: string;
    verdict?: string | null;
    turnNumber?: number;
  };
  const humanMessages: ThreadEntry[] = messages
    .filter(
      (m) =>
        (m.sourceKind === 'human' || m.sourceKind === 'ipc_injected_human') &&
        !isInternalProtocolPayload(m.content),
    )
    .map((m) => ({
      id: m.id,
      senderName: m.senderName,
      content: m.content,
      timestamp: m.timestamp,
      isFromMe: m.isFromMe,
      isBotMessage: false,
      sourceKind: m.sourceKind,
    }));
  const cronMessages: ThreadEntry[] = messages
    .filter((m) => isCronTriggerMsg(m) && !isInternalProtocolPayload(m.content))
    .map((m) => ({
      id: m.id,
      senderName: m.senderName,
      content: m.content,
      timestamp: m.timestamp,
      isFromMe: false,
      isBotMessage: true,
      sourceKind: m.sourceKind,
    }));
  const confirmedKey = (m: { content: string; senderName: string }) =>
    `${m.senderName}${m.content}`;
  const confirmedSet = new Set(messages.map(confirmedKey));
  const optimisticPending: ThreadEntry[] = pendingMessages
    .filter((m) => !confirmedSet.has(confirmedKey(m)))
    .map((m) => ({
      id: m.id,
      senderName: m.senderName,
      content: m.content,
      timestamp: m.timestamp,
      isFromMe: true,
      isBotMessage: false,
      sourceKind: m.sourceKind,
    }));
  const outputEntries: ThreadEntry[] = outputs
    .filter((o) => !isInternalProtocolPayload(o.outputText))
    .map((o) => ({
      id: `out:${o.id}`,
      senderName: o.role,
      content: o.outputText,
      timestamp: o.createdAt,
      isFromMe: false,
      isBotMessage: true,
      sourceKind: 'agent_output',
      verdict: o.verdict,
      turnNumber: o.turnNumber,
    }));
  const agentMessages: ThreadEntry[] = [
    ...humanMessages,
    ...optimisticPending,
    ...cronMessages,
    ...outputEntries,
  ].sort((a, b) => a.timestamp.localeCompare(b.timestamp));

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

      {turn && !isProcessing ? (
        <div className="room-current-turn">
          <span>
            <strong className={senderRoleClass(turn.role)}>{turn.role}</strong>
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
      ) : null}

      {queueChips.length > 0 ||
      (entry.elapsedMs && entry.elapsedMs > 0 && isProcessing) ? (
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
      ) : null}

      {!expanded && isProcessing && turn ? (
        <div className="room-live">
          <header>
            <span className="live-dot" aria-hidden />
            <span className="live-label">LIVE</span>
            <strong className={senderRoleClass(turn.role)}>{turn.role}</strong>
            <em>{turn.intentKind}</em>
            <span className="live-state pill pill-processing">
              {turn.state}
            </span>
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
          {turn.progressText && turn.progressText.trim() ? (
            <pre className="live-progress">{turn.progressText}</pre>
          ) : turn.activeRunId ? (
            <code className="live-run">{turn.activeRunId}</code>
          ) : null}
        </div>
      ) : null}

      {!expanded && latestOutput && !isProcessing ? (
        <div className="room-preview">
          <ParsedBody text={latestOutput.outputText} truncate={140} />
        </div>
      ) : null}

      {!expanded && watcherCount > 0 && lastWatcher ? (
        <div className="room-watcher-strip">
          <span className="watcher-tag">워쳐 {watcherCount}</span>
          <span className="watcher-line">
            <strong className={senderRoleClass(lastWatcher.senderName)}>
              {lastWatcher.senderName}
            </strong>
            <span>{lastWatcher.content.slice(0, 90)}</span>
          </span>
          <time>{formatDate(lastWatcher.timestamp, locale)}</time>
        </div>
      ) : null}

      {!expanded && !latestOutput && !isProcessing && !activityLoading ? (
        <p className="room-empty">{t.rooms.noActivity}</p>
      ) : null}

      {!expanded && activityLoading && !activity ? (
        <p className="room-empty">{t.rooms.loadingActivity}</p>
      ) : null}

      {expanded ? (
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

          <section className="room-section room-thread-section">
            <header>
              <h4>{t.rooms.activity}</h4>
              <small>{agentMessages.length}</small>
            </header>
            {agentMessages.length === 0 && !(isProcessing && turn) ? (
              <p className="room-empty">{t.rooms.noActivity}</p>
            ) : (
              <ol className="room-timeline">
                {agentMessages.map((entry) => {
                  const verdict = entry.verdict;
                  const verdictTone = verdict
                    ? /fail|error/i.test(verdict)
                      ? 'fail'
                      : /done|ok|pass/i.test(verdict)
                        ? 'done'
                        : 'info'
                    : null;
                  const sectionClass = senderRoleClass(
                    entry.senderName,
                  ).replace('role-', 'role-section-');
                  return (
                    <li
                      className={`room-timeline-item ${sectionClass}`}
                      key={entry.id}
                    >
                      <header className="room-timeline-header">
                        <span
                          className={`role-chip ${senderRoleClass(entry.senderName)}`}
                        >
                          {entry.senderName}
                        </span>
                        <time>{formatDate(entry.timestamp, locale)}</time>
                        {entry.turnNumber !== undefined ? (
                          <span className="parsed-marker parsed-marker-info">
                            #{entry.turnNumber}
                          </span>
                        ) : null}
                        {verdict ? (
                          <span
                            className={`parsed-marker parsed-marker-${verdictTone}`}
                          >
                            {verdict}
                          </span>
                        ) : null}
                      </header>
                      <div className="room-timeline-body">
                        <ParsedBody text={entry.content} />
                      </div>
                    </li>
                  );
                })}
                {turn &&
                turn.completedAt === null &&
                (isProcessing || liveProgressDisplay) ? (
                  <li
                    className={`room-timeline-item ${senderRoleClass(turn.role).replace('role-', 'role-section-')} ${isProcessing ? 'room-timeline-live' : 'room-timeline-paused'}`}
                  >
                    <header className="room-timeline-header">
                      {isProcessing ? (
                        <span
                          className="live-dot live-dot-inline"
                          aria-hidden
                        />
                      ) : (
                        <span className="paused-dot" aria-hidden />
                      )}
                      <span
                        className={`role-chip ${senderRoleClass(turn.role)}`}
                      >
                        {turn.role}
                      </span>
                      <time>
                        {formatDate(
                          turn.progressUpdatedAt ?? turn.updatedAt,
                          locale,
                        )}
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
                        <pre className="live-progress">
                          {liveProgressDisplay}
                        </pre>
                      ) : (
                        <p className="room-empty">{t.rooms.loadingActivity}</p>
                      )}
                    </div>
                  </li>
                ) : null}
              </ol>
            )}
          </section>

          {watcherMessages.length > 0 ? (
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
                        {message.senderName}
                      </strong>
                      <time>{formatDate(message.timestamp, locale)}</time>
                    </header>
                    <ParsedBody text={message.content} truncate={200} />
                  </li>
                ))}
              </ul>
            </details>
          ) : null}

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
      ) : null}
    </article>
  );
}

function UsageQuotaMeter({
  row,
  rowName,
  window,
  t,
}: {
  row: UsageRow;
  rowName: string;
  window: UsageLimitWindow;
  t: Messages;
}) {
  const remaining = usageWindowRemaining(row, window);
  const reset = usageWindowReset(row, window);
  const tightest = usageLimitWindow(row) === window;
  const label = t.usage.quota[window];

  return (
    <div className={`usage-quota ${tightest ? 'usage-quota-tight' : ''}`}>
      <div>
        <span>{label}</span>
        <strong>{remaining === null ? '-' : formatPct(remaining)}</strong>
      </div>
      <progress
        aria-label={`${rowName} ${label} ${
          remaining === null ? '-' : formatPct(remaining)
        }`}
        max={100}
        value={remaining ?? 0}
      />
      <small>{reset ? `${t.usage.reset} ${reset}` : t.usage.noReset}</small>
    </div>
  );
}

function UsageSpeed({ row, t }: { row: UsageRow; t: Messages }) {
  const rate = usageBurnRate(row);
  const level = usageSpeedLevel(rate);

  return (
    <div className={`usage-speed usage-speed-${level}`}>
      <span>{t.usage.speed}</span>
      <strong>{formatUsageRate(rate)}</strong>
      <small>{t.usage.speedLabel[level]}</small>
    </div>
  );
}

function UsagePanel({
  overview,
  t,
}: {
  overview: DashboardOverview;
  t: Messages;
}) {
  const rows = useMemo(
    () =>
      [...overview.usage.rows].sort((a, b) => {
        if (usageActive(a) !== usageActive(b)) return usageActive(a) ? -1 : 1;
        return usagePeak(b) - usagePeak(a);
      }),
    [overview.usage.rows],
  );
  const watched = rows.filter((row) => usagePeak(row) >= 65).length;

  if (rows.length === 0) {
    return <EmptyState>{t.usage.empty}</EmptyState>;
  }

  const activeRows = rows.filter(usageActive);
  const focusRows = activeRows.length > 0 ? activeRows : rows.slice(0, 1);
  const focusLabel = activeRows.length > 0 ? t.usage.current : t.usage.tightest;
  const focusValue = focusRows
    .map((row) => {
      const { account } = usageNameParts(row);
      const h5Remaining = usageWindowRemaining(row, 'h5');
      const d7Remaining = usageWindowRemaining(row, 'd7');
      return `${account} ${t.usage.quota.h5} ${
        h5Remaining === null ? '-' : formatPct(h5Remaining)
      } · ${t.usage.quota.d7} ${
        d7Remaining === null ? '-' : formatPct(d7Remaining)
      }`;
    })
    .join(' · ');
  const groups = [
    {
      key: 'primary' as const,
      label: t.usage.groupPrimary,
      rows: rows.filter((row) => usageGroup(row) === 'primary'),
    },
    {
      key: 'codex' as const,
      label: t.usage.groupCodex,
      rows: rows.filter((row) => usageGroup(row) === 'codex'),
    },
  ].filter((group) => group.rows.length > 0);

  return (
    <div className="usage-dashboard">
      <div className="usage-summary">
        <div>
          <span>{focusLabel}</span>
          <strong>{focusValue}</strong>
        </div>
        <div>
          <span>{t.usage.watch}</span>
          <strong>{watched}</strong>
        </div>
      </div>

      <div className="usage-matrix" role="table" aria-label={t.panels.usage}>
        <div className="usage-matrix-head" role="row">
          <span>{t.usage.usage}</span>
          <span>{t.usage.quota.h5}</span>
          <span>{t.usage.quota.d7}</span>
          <span>{t.usage.speed}</span>
        </div>
        {groups.map((group) => (
          <div className="usage-group" key={group.key} role="rowgroup">
            <div className="usage-group-label" role="row">
              <span>{group.label}</span>
            </div>
            {group.rows.map((row) => {
              const risk = usageRiskLevel(row);
              const { account, plan } = usageNameParts(row);
              return (
                <section className={`usage-row usage-${risk}`} key={row.name}>
                  <div className="usage-account">
                    <strong>{account}</strong>
                    <div>
                      {usageActive(row) ? (
                        <span className="pill pill-info">{t.usage.inUse}</span>
                      ) : null}
                      {plan ? <span className="mono-chip">{plan}</span> : null}
                      {usageLimited(row) || risk !== 'ok' ? (
                        <span className={`pill pill-${risk}`}>
                          {t.usage.risk[risk]}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <UsageQuotaMeter
                    row={row}
                    rowName={account}
                    window="h5"
                    t={t}
                  />
                  <UsageQuotaMeter
                    row={row}
                    rowName={account}
                    window="d7"
                    t={t}
                  />
                  <UsageSpeed row={row} t={t} />
                </section>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function TaskPanel({
  tasks,
  rooms,
  locale,
  onTaskAction,
  onTaskCreate,
  onTaskUpdate,
  taskActionKey,
  t,
}: {
  tasks: DashboardTask[];
  rooms: RoomOption[];
  locale: Locale;
  onTaskAction: (task: DashboardTask, action: DashboardTaskAction) => void;
  onTaskCreate: (input: CreateScheduledTaskInput) => void;
  onTaskUpdate: (task: DashboardTask, input: UpdateScheduledTaskInput) => void;
  taskActionKey: TaskActionKey | null;
  t: Messages;
}) {
  const taskGroups = useMemo(() => {
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
      { key: 'watchers' as const, tasks: groups.watchers },
      { key: 'scheduled' as const, tasks: groups.scheduled },
      { key: 'paused' as const, tasks: groups.paused },
      { key: 'completed' as const, tasks: groups.completed },
    ];
  }, [tasks]);

  return (
    <div className="task-board" aria-label={t.tasks.cardsAria}>
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
        </div>
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
        <label className="task-form-wide">
          <span>{t.tasks.prompt}</span>
          <textarea
            name="prompt"
            placeholder={t.tasks.promptPlaceholder}
            required
          />
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
        <button disabled={taskActionKey === 'create'} type="submit">
          {taskActionKey === 'create'
            ? t.tasks.actions.busy
            : t.tasks.actions.create}
        </button>
      </form>

      {tasks.length === 0 ? <EmptyState>{t.tasks.empty}</EmptyState> : null}
      {taskGroups.map((group) => {
        const label = t.tasks.groups[group.key];
        const groupHead = (
          <div className="task-group-head">
            <div>
              <span className="eyebrow">{label}</span>
              <strong>
                {group.tasks.length} {t.tasks.count}
              </strong>
            </div>
            <span className={`pill pill-${group.key}`}>
              {group.tasks.length}
            </span>
          </div>
        );
        const groupBody =
          group.tasks.length === 0 ? (
            <div className="task-group-empty">{t.tasks.groupEmpty}</div>
          ) : (
            <div className="task-list">
              {group.tasks.map((task) => {
                const resultTone = taskResultTone(task);
                const lastResult = safePreview(
                  task.lastResult,
                  t.tasks.noResult,
                );
                const taskActions = taskActionsFor(task);
                return (
                  <article
                    className={`task-card task-card-${group.key}`}
                    key={task.id}
                  >
                    <div className="task-card-main">
                      <div className="task-title">
                        <strong>{taskDisplayName(task, t)}</strong>
                        <span className="mono-chip">{task.groupFolder}</span>
                      </div>
                      <div className="task-status-line">
                        <span className={`pill pill-${task.status}`}>
                          {statusLabel(task.status, t)}
                        </span>
                        {task.ciProvider ? (
                          <span className="task-provider">
                            {task.ciProvider}
                          </span>
                        ) : null}
                      </div>
                    </div>

                    {taskActions.length > 0 ? (
                      <div className="task-actions">
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
                              {busy
                                ? t.tasks.actions.busy
                                : t.tasks.actions[action]}
                            </button>
                          );
                        })}
                      </div>
                    ) : null}

                    <div className="task-time-grid">
                      <span>
                        <small>{t.tasks.next}</small>
                        <strong>{formatTaskDate(task.nextRun, locale)}</strong>
                        <em>{formatRelativeDate(task.nextRun, locale, t)}</em>
                      </span>
                      <span>
                        <small>{t.tasks.last}</small>
                        <strong>{formatTaskDate(task.lastRun, locale)}</strong>
                        <em>{formatRelativeDate(task.lastRun, locale, t)}</em>
                      </span>
                      <span>
                        <small>{t.tasks.schedule}</small>
                        <strong>{task.scheduleType}</strong>
                        <em>{task.scheduleValue}</em>
                      </span>
                    </div>

                    {task.suspendedUntil ? (
                      <div className="task-suspended">
                        <span>{t.tasks.suspendedUntil}</span>
                        <strong>
                          {formatTaskDate(task.suspendedUntil, locale)}
                        </strong>
                        <em>
                          {formatRelativeDate(task.suspendedUntil, locale, t)}
                        </em>
                      </div>
                    ) : null}

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

                    <details className="task-prompt">
                      <summary>{t.tasks.prompt}</summary>
                      <p>
                        {safePreview(task.promptPreview, t.tasks.emptyPrompt)}
                      </p>
                      <small>
                        {task.id} · {task.contextMode} · {task.promptLength}{' '}
                        {t.units.chars}
                      </small>
                    </details>

                    {!task.isWatcher && task.status !== 'completed' ? (
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
                            <textarea
                              name="prompt"
                              placeholder={t.tasks.editPromptPlaceholder}
                            />
                          </label>
                          <label>
                            <span>{t.tasks.scheduleType}</span>
                            <select
                              name="scheduleType"
                              defaultValue={task.scheduleType}
                              required
                            >
                              <option value="once">
                                {t.tasks.scheduleTypes.once}
                              </option>
                              <option value="interval">
                                {t.tasks.scheduleTypes.interval}
                              </option>
                              <option value="cron">
                                {t.tasks.scheduleTypes.cron}
                              </option>
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
                          <button
                            disabled={taskActionKey === `${task.id}:edit`}
                            type="submit"
                          >
                            {taskActionKey === `${task.id}:edit`
                              ? t.tasks.actions.busy
                              : t.tasks.actions.save}
                          </button>
                        </form>
                      </details>
                    ) : null}
                  </article>
                );
              })}
            </div>
          );

        if (group.key === 'completed') {
          return (
            <details
              className="task-group task-group-completed"
              key={group.key}
            >
              <summary className="task-group-head">
                <div>
                  <span className="eyebrow">{label}</span>
                  <strong>
                    {group.tasks.length} {t.tasks.count}
                  </strong>
                </div>
                <span className={`pill pill-${group.key}`}>
                  {group.tasks.length}
                </span>
              </summary>
              {groupBody}
            </details>
          );
        }

        return (
          <section
            className={`task-group task-group-${group.key}`}
            key={group.key}
          >
            {groupHead}
            {groupBody}
          </section>
        );
      })}
    </div>
  );
}

function App() {
  const [data, setData] = useState<DashboardState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [activeView, setActiveView] = useState<DashboardView>(readViewFromHash);
  const [locale, setLocale] = useState<Locale>(readInitialLocale);
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );
  const [offlineReady, setOfflineReady] = useState(false);
  const [installPrompt, setInstallPrompt] =
    useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(isStandaloneDisplay);
  const [taskActionKey, setTaskActionKey] = useState<TaskActionKey | null>(
    null,
  );
  const [inboxActionKey, setInboxActionKey] = useState<InboxActionKey | null>(
    null,
  );
  const [serviceActionKey, setServiceActionKey] =
    useState<ServiceActionKey | null>(null);
  const [roomMessageKey, setRoomMessageKey] = useState<string | null>(null);
  const [selectedRoomJid, setSelectedRoomJid] = useState<string | null>(null);
  const {
    refreshRoom: refreshRoomActivity,
    roomActivity,
    roomActivityLoading,
  } = useSelectedRoomActivity({
    active: activeView === 'rooms',
    selectedRoomJid: selectedRoomJid,
  });
  const [pendingMessages, setPendingMessages] = useState<
    Record<string, Array<DashboardRoomActivity['messages'][number]>>
  >({});
  const [nickname, setNicknameState] = useState<string>(() => {
    if (typeof window === 'undefined') return '';
    return window.localStorage.getItem('ejclaw-nickname') ?? '';
  });
  function setNickname(next: string) {
    const trimmed = next.trim().slice(0, 32);
    setNicknameState(trimmed);
    if (typeof window !== 'undefined') {
      if (trimmed) window.localStorage.setItem('ejclaw-nickname', trimmed);
      else window.localStorage.removeItem('ejclaw-nickname');
    }
  }
  const t = messages[locale];
  const secureContext =
    typeof window === 'undefined' ? true : window.isSecureContext;

  function setDashboardLocale(nextLocale: Locale) {
    setLocale(nextLocale);
    window.localStorage.setItem(LOCALE_STORAGE_KEY, nextLocale);
  }

  function navigateToView(view: DashboardView) {
    setActiveView(view);
    if (window.location.hash !== `#/${view}`) {
      window.location.hash = `/${view}`;
    }
  }

  async function refresh(showSpinner = false) {
    if (showSpinner) setRefreshing(true);
    try {
      const nextData = await fetchDashboardData();
      setData(nextData);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

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

  async function handleInboxAction(
    item: InboxItem,
    action: DashboardInboxAction,
  ) {
    if (
      action === 'decline' &&
      typeof window !== 'undefined' &&
      !window.confirm(t.inbox.actions.confirmDecline)
    ) {
      return;
    }

    const actionKey: InboxActionKey = `${item.id}:${action}`;
    setInboxActionKey(actionKey);
    try {
      await runInboxAction(item.id, action, {
        lastOccurredAt: item.lastOccurredAt,
        requestId: makeClientRequestId(),
      });
      await refresh(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setInboxActionKey(null);
    }
  }

  async function handleServiceRestart() {
    if (
      typeof window !== 'undefined' &&
      !window.confirm(t.health.confirmRestart)
    ) {
      return;
    }

    setServiceActionKey('stack:restart');
    try {
      await runServiceAction('stack', 'restart', {
        requestId: makeClientRequestId(),
      });
      await refresh(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setServiceActionKey(null);
    }
  }

  async function handleRoomMessage(
    roomJid: string,
    text: string,
    requestId: string,
  ) {
    setRoomMessageKey(roomJid);
    const optimisticId = `opt:${requestId}`;
    const displayName = nickname || 'Web Dashboard';
    const optimisticMsg = {
      id: optimisticId,
      sender: 'me',
      senderName: displayName,
      content: text,
      timestamp: new Date().toISOString(),
      isFromMe: true,
      isBotMessage: false,
      sourceKind: 'human' as const,
    };
    setPendingMessages((prev) => ({
      ...prev,
      [roomJid]: [...(prev[roomJid] ?? []), optimisticMsg],
    }));
    try {
      await sendRoomMessage(roomJid, text, requestId, nickname || null);
      try {
        await refreshRoomActivity(roomJid);
      } catch {
        /* refresh will retry on next poll */
      }
      void refresh(false);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPendingMessages((prev) => {
        const list = prev[roomJid];
        if (!list) return prev;
        const next = list.filter((m) => m.id !== optimisticId);
        if (next.length === 0) {
          const { [roomJid]: _drop, ...rest } = prev;
          void _drop;
          return rest;
        }
        return { ...prev, [roomJid]: next };
      });
      return false;
    } finally {
      setRoomMessageKey(null);
    }
  }

  async function handleInstallApp() {
    if (!installPrompt) return;
    await installPrompt.prompt();
    await installPrompt.userChoice;
    setInstallPrompt(null);
    setInstalled(isStandaloneDisplay());
  }

  useEffect(() => {
    document.documentElement.lang = localeTags[locale];
  }, [locale]);

  useEffect(() => {
    const debug =
      typeof window !== 'undefined' &&
      /[?&]debug=1/.test(window.location.search);
    document.body.classList.toggle('debug-outlines', debug);
    if (
      typeof window !== 'undefined' &&
      /[?&]measure=1/.test(window.location.search)
    ) {
      const tick = () => {
        const sels = [
          '.rooms-detail .room-card-v2',
          '.room-card-head',
          '.room-thread-section',
          '.room-section.room-compose-section',
        ];
        const out = sels
          .map((s) => {
            const el = document.querySelector(s);
            if (!el) return `${s}: NOT FOUND`;
            const r = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            return `${s}:\n  x=${Math.round(r.x)} w=${Math.round(r.width)}\n  display=${cs.display} pl=${cs.paddingLeft} ml=${cs.marginLeft}`;
          })
          .join('\n');
        let pre = document.getElementById('__measure');
        if (!pre) {
          pre = document.createElement('pre');
          pre.id = '__measure';
          pre.style.cssText =
            'position:fixed;top:0;left:0;background:#fff;color:#000;font:11px monospace;padding:8px;z-index:99999;max-width:520px;white-space:pre;line-height:1.4;';
          document.body.appendChild(pre);
        }
        pre.textContent = out;
      };
      const id = window.setTimeout(tick, 1500);
      return () => window.clearTimeout(id);
    }
    return undefined;
  });

  useEffect(() => {
    function handleOnline() {
      setOnline(true);
    }

    function handleOffline() {
      setOnline(false);
    }

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  useEffect(() => {
    if (!import.meta.env.PROD || !canUsePwaCore()) {
      setOfflineReady(false);
      return;
    }

    let cancelled = false;
    void navigator.serviceWorker
      .register('/sw.js')
      .then((registration) => {
        if (!cancelled) {
          setOfflineReady(
            Boolean(
              registration.active ||
              registration.waiting ||
              registration.installing,
            ),
          );
        }
        return navigator.serviceWorker.ready;
      })
      .then(() => {
        if (!cancelled) setOfflineReady(true);
      })
      .catch(() => {
        if (!cancelled) setOfflineReady(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    function handleBeforeInstallPrompt(event: Event) {
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPromptEvent);
    }

    function handleInstalled() {
      setInstalled(true);
      setInstallPrompt(null);
    }

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleInstalled);
    return () => {
      window.removeEventListener(
        'beforeinstallprompt',
        handleBeforeInstallPrompt,
      );
      window.removeEventListener('appinstalled', handleInstalled);
    };
  }, []);

  useEffect(() => {
    function handleHashChange() {
      setActiveView(readViewFromHash());
    }

    handleHashChange();
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => {
      void refresh();
    }, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    setPendingMessages((prev) => {
      const next: typeof prev = {};
      let changed = false;
      for (const [jid, list] of Object.entries(prev)) {
        const fetched = roomActivity[jid]?.messages ?? [];
        const confirmedKeys = new Set(
          fetched.map((m) => `${m.senderName}${m.content}`),
        );
        const remaining = list.filter(
          (m) => !confirmedKeys.has(`${m.senderName}${m.content}`),
        );
        if (remaining.length !== list.length) changed = true;
        if (remaining.length > 0) next[jid] = remaining;
      }
      return changed ? next : prev;
    });
  }, [roomActivity]);

  useEffect(() => {
    if (!drawerOpen) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setDrawerOpen(false);
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [drawerOpen]);

  if (loading && !data) {
    return <LoadingSkeleton t={t} />;
  }

  const roomOptions = data ? buildRoomOptions(data.snapshots) : [];
  const freshness = dashboardFreshness(online, data?.overview.generatedAt);
  const canInstall = Boolean(secureContext && installPrompt && !installed);

  return (
    <div className="shell">
      <SideRail
        activeView={activeView}
        canInstall={canInstall}
        data={data}
        installed={installed}
        offlineReady={offlineReady}
        online={online}
        onInstall={() => void handleInstallApp()}
        onNavigate={navigateToView}
        onRefresh={() => void refresh(true)}
        refreshing={refreshing}
        secureContext={secureContext}
        t={t}
      />
      <main className="dashboard-content">
        <SectionNav
          activeView={activeView}
          canInstall={canInstall}
          drawerOpen={drawerOpen}
          freshness={freshness}
          installed={installed}
          locale={locale}
          onCloseDrawer={() => setDrawerOpen(false)}
          onInstall={() => void handleInstallApp()}
          onLocaleChange={setDashboardLocale}
          onNavigate={navigateToView}
          onOpenDrawer={() => setDrawerOpen(true)}
          offlineReady={offlineReady}
          onRefresh={() => void refresh(true)}
          refreshing={refreshing}
          secureContext={secureContext}
          t={t}
        />

        {error ? (
          <section className="error-card" role="alert" aria-live="polite">
            <span>
              <strong>{t.error.api}</strong>
              <small>{humanizeError(error, t)}</small>
            </span>
            <button disabled={refreshing} onClick={() => void refresh(true)}>
              {t.actions.retry}
            </button>
          </section>
        ) : null}

        {data ? (
          <div className={`view-stack view-${activeView}`}>
            {activeView === 'usage' ? (
              <>
                <section className="panel usage-first" id="usage">
                  <div className="panel-title">
                    <h2>{t.panels.usage}</h2>
                    <span>{t.panels.usageWindow}</span>
                  </div>
                  <UsagePanel overview={data.overview} t={t} />
                </section>
                <ControlRail
                  canInstall={canInstall}
                  data={data}
                  installed={installed}
                  locale={locale}
                  offlineReady={offlineReady}
                  online={online}
                  onInstall={() => void handleInstallApp()}
                  secureContext={secureContext}
                  t={t}
                />
              </>
            ) : null}

            {activeView === 'inbox' ? (
              <section className="panel view-panel" id="inbox">
                <div className="panel-title">
                  <h2>{t.panels.inbox}</h2>
                  <span>{t.panels.inboxQueue}</span>
                </div>
                <InboxPanel
                  inboxActionKey={inboxActionKey}
                  locale={locale}
                  onInboxAction={(item, action) =>
                    void handleInboxAction(item, action)
                  }
                  onTaskAction={(task, action) =>
                    void handleTaskAction(task, action)
                  }
                  overview={data.overview}
                  taskActionKey={taskActionKey}
                  tasks={data.tasks}
                  t={t}
                />
              </section>
            ) : null}

            {activeView === 'health' ? (
              <section className="panel view-panel" id="health">
                <div className="panel-title">
                  <h2>{t.panels.health}</h2>
                  <span>{t.panels.healthSignals}</span>
                </div>
                <HealthPanel
                  data={data}
                  locale={locale}
                  onRestartStack={() => void handleServiceRestart()}
                  serviceActionKey={serviceActionKey}
                  t={t}
                />
              </section>
            ) : null}

            {activeView === 'rooms' ? (
              <section className="panel view-panel" id="rooms">
                <div className="panel-title">
                  <h2>{t.panels.rooms}</h2>
                  <span>{t.panels.queue}</span>
                </div>
                <RoomBoardV2
                  inbox={data.overview.inbox}
                  onSendRoomMessage={handleRoomMessage}
                  pendingMessages={pendingMessages}
                  roomActivity={roomActivity}
                  roomActivityLoading={roomActivityLoading}
                  roomMessageKey={roomMessageKey}
                  locale={locale}
                  onSelectedJidChange={setSelectedRoomJid}
                  selectedJid={selectedRoomJid}
                  snapshots={data.snapshots}
                  t={t}
                />
              </section>
            ) : null}

            {activeView === 'scheduled' ? (
              <section className="panel view-panel" id="scheduled">
                <div className="panel-title">
                  <h2>{t.panels.scheduled}</h2>
                  <span>{t.panels.promptPreviews}</span>
                </div>
                <TaskPanel
                  locale={locale}
                  onTaskAction={(task, action) =>
                    void handleTaskAction(task, action)
                  }
                  onTaskCreate={(input) => void handleTaskCreate(input)}
                  onTaskUpdate={(task, input) =>
                    void handleTaskUpdate(task, input)
                  }
                  rooms={roomOptions}
                  taskActionKey={taskActionKey}
                  tasks={data.tasks}
                  t={t}
                />
              </section>
            ) : null}

            {activeView === 'settings' ? (
              <section className="panel view-panel" id="settings">
                <div className="panel-title">
                  <h2>{t.settings.title}</h2>
                </div>
                <SettingsPanel
                  locale={locale}
                  nickname={nickname}
                  onLocaleChange={setDashboardLocale}
                  onNicknameChange={setNickname}
                  onRestartStack={() => void handleServiceRestart()}
                  t={t}
                />
              </section>
            ) : null}
          </div>
        ) : null}
      </main>
    </div>
  );
}

export default App;
