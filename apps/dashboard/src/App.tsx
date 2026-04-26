import { useEffect, useMemo, useState, type ReactNode } from 'react';

import {
  type DashboardOverview,
  type DashboardTask,
  type StatusSnapshot,
  fetchDashboardData,
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
type DashboardView = 'usage' | 'inbox' | 'health' | 'rooms' | 'scheduled';
type TaskGroupKey = 'watchers' | 'scheduled' | 'paused' | 'completed';
type TaskResultTone = 'ok' | 'fail' | 'none';
type InboxFilter = 'all' | InboxItem['kind'];
type HealthLevel = 'ok' | 'stale' | 'down';

const REFRESH_INTERVAL_MS = 15_000;
const LOCALE_STORAGE_KEY = 'ejclaw.dashboard.locale';
const DEFAULT_VIEW: DashboardView = 'inbox';
const HEALTH_STALE_MS = 5 * 60_000;
const HEALTH_DOWN_MS = 15 * 60_000;

function isDashboardView(
  value: string | null | undefined,
): value is DashboardView {
  return (
    value === 'usage' ||
    value === 'inbox' ||
    value === 'health' ||
    value === 'rooms' ||
    value === 'scheduled'
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

  return 'ko';
}

function formatDate(value: string | null | undefined, locale: Locale): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(localeTags[locale], {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
}

function formatTaskDate(
  value: string | null | undefined,
  locale: Locale,
): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(localeTags[locale], {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
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

function usageRemaining(row: UsageRow): number | null {
  const peak = usagePeak(row);
  if (peak < 0) return null;
  return Math.max(0, 100 - peak);
}

function usageLimitWindow(row: UsageRow): UsageLimitWindow {
  return row.d7pct >= row.h5pct ? 'd7' : 'h5';
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

function usageLimitReset(row: UsageRow): string {
  return (usageLimitWindow(row) === 'd7' ? row.d7reset : row.h5reset).trim();
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

function navItems(t: Messages) {
  return [
    { href: '#/usage', label: t.nav.usage, view: 'usage' as const },
    { href: '#/inbox', label: t.nav.inbox, view: 'inbox' as const },
    { href: '#/health', label: t.nav.health, view: 'health' as const },
    { href: '#/rooms', label: t.nav.rooms, view: 'rooms' as const },
    { href: '#/scheduled', label: t.nav.scheduled, view: 'scheduled' as const },
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
  locale,
  onNavigate,
  onLocaleChange,
  onRefresh,
  refreshing,
  t,
}: {
  activeView: DashboardView;
  locale: Locale;
  onNavigate: (view: DashboardView) => void;
  onLocaleChange: (locale: Locale) => void;
  onRefresh: () => void;
  refreshing: boolean;
  t: Messages;
}) {
  return (
    <aside className="side-rail" aria-label={t.nav.drawerAria}>
      <div className="side-rail-brand">
        <span className="eyebrow">EJClaw</span>
        <strong>{t.nav.operations}</strong>
      </div>
      <nav aria-label={t.nav.drawerNavAria}>
        {navItems(t).map((item) => (
          <a
            aria-current={activeView === item.view ? 'page' : undefined}
            className={activeView === item.view ? 'is-active' : undefined}
            href={item.href}
            key={item.href}
            onClick={() => onNavigate(item.view)}
          >
            {item.label}
          </a>
        ))}
      </nav>
      <LanguageSelector locale={locale} onLocaleChange={onLocaleChange} t={t} />
      <button
        aria-busy={refreshing}
        className="side-refresh"
        disabled={refreshing}
        onClick={onRefresh}
        type="button"
      >
        {refreshing ? t.actions.refreshing : t.actions.refresh}
      </button>
    </aside>
  );
}

function SectionNav({
  activeView,
  drawerOpen,
  locale,
  onCloseDrawer,
  onLocaleChange,
  onNavigate,
  onOpenDrawer,
  refreshing,
  onRefresh,
  t,
}: {
  activeView: DashboardView;
  drawerOpen: boolean;
  locale: Locale;
  onCloseDrawer: () => void;
  onLocaleChange: (locale: Locale) => void;
  onNavigate: (view: DashboardView) => void;
  onOpenDrawer: () => void;
  refreshing: boolean;
  onRefresh: () => void;
  t: Messages;
}) {
  const activeLabel =
    navItems(t).find((item) => item.view === activeView)?.label ?? t.nav.usage;

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
            <LanguageSelector
              locale={locale}
              onLocaleChange={onLocaleChange}
              t={t}
            />
          </aside>
        </>
      ) : null}
    </>
  );
}

function ControlRail({ data, t }: { data: DashboardState; t: Messages }) {
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

  return (
    <section className="ops-strip" id="overview" aria-label={t.control.aria}>
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
  locale,
  t,
}: {
  overview: DashboardOverview;
  locale: Locale;
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
          return (
            <article
              className={`inbox-card inbox-${item.severity}`}
              key={item.id}
            >
              <div className="inbox-card-head">
                <div>
                  <span className="eyebrow">{t.inbox.kinds[item.kind]}</span>
                  <strong>{item.title}</strong>
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
              <p>{item.summary || t.inbox.noSummary}</p>
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
  t,
}: {
  data: DashboardState;
  locale: Locale;
  t: Messages;
}) {
  const services = data.overview.services;
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

function RoomPanel({
  snapshots,
  t,
}: {
  snapshots: StatusSnapshot[];
  t: Messages;
}) {
  const entries = snapshots.flatMap((snapshot) =>
    snapshot.entries.map((entry) => ({
      ...entry,
      serviceId: snapshot.serviceId,
    })),
  );

  if (entries.length === 0) {
    return <EmptyState>{t.rooms.empty}</EmptyState>;
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

function UsageRemainingMeter({
  row,
  rowName,
  t,
}: {
  row: UsageRow;
  rowName: string;
  t: Messages;
}) {
  const remaining = usageRemaining(row);
  const window = usageLimitWindow(row);
  const reset = usageLimitReset(row);

  return (
    <div className="usage-remaining">
      <div>
        <span>{t.usage.remaining}</span>
        <strong>{remaining === null ? '-' : formatPct(remaining)}</strong>
      </div>
      <progress
        aria-label={`${rowName} ${t.usage.remaining} ${
          remaining === null ? '-' : formatPct(remaining)
        }`}
        max={100}
        value={remaining ?? 0}
      />
      <small>
        {remaining === null ? '-' : t.usage.limitBasis[window]}
        {reset ? ` · ${t.usage.reset} ${reset}` : ` · ${t.usage.noReset}`}
      </small>
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
      const remaining = usageRemaining(row);
      return `${account} ${remaining === null ? '-' : formatPct(remaining)}`;
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
          <span>{t.usage.remaining}</span>
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
                  <UsageRemainingMeter row={row} rowName={account} t={t} />
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
  locale,
  t,
}: {
  tasks: DashboardTask[];
  locale: Locale;
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

  if (tasks.length === 0) {
    return <EmptyState>{t.tasks.empty}</EmptyState>;
  }

  return (
    <div className="task-board" aria-label={t.tasks.cardsAria}>
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
  const t = messages[locale];

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

  useEffect(() => {
    document.documentElement.lang = localeTags[locale];
  }, [locale]);

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

  return (
    <div className="shell">
      <SideRail
        activeView={activeView}
        locale={locale}
        onNavigate={navigateToView}
        onLocaleChange={setDashboardLocale}
        onRefresh={() => void refresh(true)}
        refreshing={refreshing}
        t={t}
      />
      <main className="dashboard-content">
        <SectionNav
          activeView={activeView}
          drawerOpen={drawerOpen}
          locale={locale}
          onCloseDrawer={() => setDrawerOpen(false)}
          onLocaleChange={setDashboardLocale}
          onNavigate={navigateToView}
          onOpenDrawer={() => setDrawerOpen(true)}
          onRefresh={() => void refresh(true)}
          refreshing={refreshing}
          t={t}
        />

        {error ? (
          <section className="error-card">
            <span>
              {t.error.api}: {error}
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
                <ControlRail data={data} t={t} />
              </>
            ) : null}

            {activeView === 'inbox' ? (
              <section className="panel view-panel" id="inbox">
                <div className="panel-title">
                  <h2>{t.panels.inbox}</h2>
                  <span>{t.panels.inboxQueue}</span>
                </div>
                <InboxPanel locale={locale} overview={data.overview} t={t} />
              </section>
            ) : null}

            {activeView === 'health' ? (
              <section className="panel view-panel" id="health">
                <div className="panel-title">
                  <h2>{t.panels.health}</h2>
                  <span>{t.panels.healthSignals}</span>
                </div>
                <HealthPanel data={data} locale={locale} t={t} />
              </section>
            ) : null}

            {activeView === 'rooms' ? (
              <section className="panel view-panel" id="rooms">
                <div className="panel-title">
                  <h2>{t.panels.rooms}</h2>
                  <span>{t.panels.queue}</span>
                </div>
                <RoomPanel snapshots={data.snapshots} t={t} />
              </section>
            ) : null}

            {activeView === 'scheduled' ? (
              <section className="panel view-panel" id="scheduled">
                <div className="panel-title">
                  <h2>{t.panels.scheduled}</h2>
                  <span>{t.panels.promptPreviews}</span>
                </div>
                <TaskPanel locale={locale} tasks={data.tasks} t={t} />
              </section>
            ) : null}
          </div>
        ) : null}
      </main>
    </div>
  );
}

export default App;
