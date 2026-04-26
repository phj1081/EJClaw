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
type RiskLevel = 'ok' | 'warn' | 'critical';

const REFRESH_INTERVAL_MS = 15_000;
const LOCALE_STORAGE_KEY = 'ejclaw.dashboard.locale';

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

function formatPct(value: number): string {
  if (value < 0) return '-';
  return `${Math.round(value)}%`;
}

function usagePeak(row: UsageRow): number {
  return Math.max(row.h5pct, row.d7pct);
}

function usageRiskLevel(row: UsageRow): RiskLevel {
  const peak = usagePeak(row);
  if (peak >= 85) return 'critical';
  if (peak >= 65) return 'warn';
  return 'ok';
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

function navItems(t: Messages) {
  return [
    { href: '#overview', label: t.nav.health },
    { href: '#usage', label: t.nav.usage },
    { href: '#rooms', label: t.nav.rooms },
    { href: '#work', label: t.nav.scheduled },
  ];
}

function Card({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | number;
  hint?: string;
}) {
  return (
    <section className="card metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
      {hint ? <small>{hint}</small> : null}
    </section>
  );
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
      <section className="hero skeleton-hero">
        <div>
          <span className="skeleton-line skeleton-short" />
          <span className="skeleton-line skeleton-title" />
          <span className="skeleton-line skeleton-copy" />
        </div>
        <span className="skeleton-button" />
      </section>
      <section className="metrics-grid" aria-label={t.app.loading}>
        {Array.from({ length: 4 }, (_, index) => (
          <div className="card metric-card skeleton-card" key={index}>
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
  lastRefreshed,
  locale,
  onLocaleChange,
  t,
}: {
  lastRefreshed: string | null;
  locale: Locale;
  onLocaleChange: (locale: Locale) => void;
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
          <a href={item.href} key={item.href}>
            {item.label}
          </a>
        ))}
      </nav>
      <LanguageSelector locale={locale} onLocaleChange={onLocaleChange} t={t} />
      <div className="drawer-meta">
        <span>{t.nav.updated}</span>
        <strong>{formatDate(lastRefreshed, locale)}</strong>
      </div>
    </aside>
  );
}

function SectionNav({
  drawerOpen,
  lastRefreshed,
  locale,
  onCloseDrawer,
  onLocaleChange,
  onOpenDrawer,
  refreshing,
  onRefresh,
  t,
}: {
  drawerOpen: boolean;
  lastRefreshed: string | null;
  locale: Locale;
  onCloseDrawer: () => void;
  onLocaleChange: (locale: Locale) => void;
  onOpenDrawer: () => void;
  refreshing: boolean;
  onRefresh: () => void;
  t: Messages;
}) {
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
        {navItems(t)
          .slice(0, 3)
          .map((item) => (
            <a href={item.href} key={item.href}>
              {item.label}
            </a>
          ))}
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
        <span>
          {t.nav.updated} {formatDate(lastRefreshed, locale)}
        </span>
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
                <a href={item.href} key={item.href} onClick={onCloseDrawer}>
                  {item.label}
                </a>
              ))}
            </nav>
            <LanguageSelector
              locale={locale}
              onLocaleChange={onLocaleChange}
              t={t}
            />
            <div className="drawer-meta">
              <span>{t.nav.updated}</span>
              <strong>{formatDate(lastRefreshed, locale)}</strong>
            </div>
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
    <section className="control-rail" id="overview" aria-label={t.control.aria}>
      <div>
        <span className="eyebrow">{t.control.heartbeat}</span>
        <strong>
          {data.overview.rooms.active + data.overview.rooms.waiting}/
          {data.overview.rooms.total}
        </strong>
        <small>{t.control.activeRooms}</small>
      </div>
      <div>
        <span className="eyebrow">{t.control.queue}</span>
        <strong>{queue.pendingTasks}</strong>
        <small>
          {queue.pendingMessageRooms} {t.control.pendingRooms}
        </small>
      </div>
      <div>
        <span className="eyebrow">{t.control.governance}</span>
        <strong>{t.control.readOnly}</strong>
        <small>{t.control.writesDisabled}</small>
      </div>
      <div>
        <span className="eyebrow">{t.control.audit}</span>
        <strong>{t.control.redacted}</strong>
        <small>{t.control.previewOnly}</small>
      </div>
    </section>
  );
}

function ServicePanel({
  overview,
  locale,
  t,
}: {
  overview: DashboardOverview;
  locale: Locale;
  t: Messages;
}) {
  if (overview.services.length === 0) {
    return <EmptyState>{t.service.empty}</EmptyState>;
  }

  return (
    <div className="service-grid">
      {overview.services.map((service) => (
        <section className="card service-card" key={service.serviceId}>
          <div>
            <span className="eyebrow">{service.agentType}</span>
            <h3>{service.assistantName}</h3>
          </div>
          <div className="heartbeat-line">
            <span />
            <small>
              {t.service.heartbeat} {formatDate(service.updatedAt, locale)}
            </small>
          </div>
          <dl>
            <div>
              <dt>{t.service.service}</dt>
              <dd>{service.serviceId}</dd>
            </div>
            <div>
              <dt>{t.service.rooms}</dt>
              <dd>
                {service.activeRooms}/{service.totalRooms} {t.status.active}
              </dd>
            </div>
            <div>
              <dt>{t.service.updated}</dt>
              <dd>{formatDate(service.updatedAt, locale)}</dd>
            </div>
          </dl>
        </section>
      ))}
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
              <th>{t.rooms.service}</th>
              <th>{t.rooms.agent}</th>
              <th>{t.rooms.status}</th>
              <th>{t.rooms.queue}</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={`${entry.serviceId}:${entry.jid}`}>
                <td>
                  <strong>{entry.name}</strong>
                  <span>
                    {entry.folder} · {entry.jid}
                  </span>
                </td>
                <td>{entry.serviceId}</td>
                <td>{entry.agentType}</td>
                <td>
                  <span className={`pill pill-${entry.status}`}>
                    {statusLabel(entry.status, t)}
                  </span>
                  <small>{formatDuration(entry.elapsedMs, t)}</small>
                </td>
                <td>
                  {queueLabel(entry.pendingTasks, entry.pendingMessages, t)}
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
                <small>{t.rooms.agent}</small>
                <strong>{entry.agentType}</strong>
              </span>
              <span>
                <small>{t.rooms.service}</small>
                <strong>{entry.serviceId}</strong>
              </span>
              <span>
                <small>{t.rooms.elapsed}</small>
                <strong>{formatDuration(entry.elapsedMs, t)}</strong>
              </span>
            </div>
            <p className="record-id">{entry.jid}</p>
          </article>
        ))}
      </div>
    </>
  );
}

function UsageMeter({
  label,
  pct,
  reset,
  rowName,
  t,
}: {
  label: string;
  pct: number;
  reset: string;
  rowName: string;
  t: Messages;
}) {
  return (
    <div className="usage-window">
      <div>
        <span>{label}</span>
        <strong>{formatPct(pct)}</strong>
      </div>
      <progress
        aria-label={`${rowName} ${label} ${t.usage.usage} ${formatPct(pct)}`}
        max={100}
        value={Math.max(0, pct)}
      />
      <small>
        {t.usage.reset} {reset || '-'}
      </small>
    </div>
  );
}

function UsagePanel({
  overview,
  locale,
  t,
}: {
  overview: DashboardOverview;
  locale: Locale;
  t: Messages;
}) {
  const rows = useMemo(
    () => [...overview.usage.rows].sort((a, b) => usagePeak(b) - usagePeak(a)),
    [overview.usage.rows],
  );
  const watched = rows.filter((row) => usagePeak(row) >= 65).length;

  if (rows.length === 0) {
    return <EmptyState>{t.usage.empty}</EmptyState>;
  }

  const highest = rows[0];

  return (
    <div className="usage-dashboard">
      <div className="usage-summary">
        <div>
          <span>{t.usage.highest}</span>
          <strong>
            {highest.name} · {formatPct(usagePeak(highest))}
          </strong>
        </div>
        <div>
          <span>{t.usage.watch}</span>
          <strong>{watched}</strong>
        </div>
        <div>
          <span>{t.usage.updated}</span>
          <strong>{formatDate(overview.usage.fetchedAt, locale)}</strong>
        </div>
      </div>

      <div className="usage-matrix" role="table" aria-label={t.panels.usage}>
        <div className="usage-matrix-head" role="row">
          <span>{t.usage.usage}</span>
          <span>{t.usage.window5h}</span>
          <span>{t.usage.window7d}</span>
        </div>
        {rows.map((row) => {
          const risk = usageRiskLevel(row);
          return (
            <section className={`usage-row usage-${risk}`} key={row.name}>
              <div className="usage-account">
                <strong>{row.name}</strong>
                <span className={`pill pill-${risk}`}>
                  {t.usage.risk[risk]}
                </span>
              </div>
              <UsageMeter
                label={t.usage.window5h}
                pct={row.h5pct}
                reset={row.h5reset}
                rowName={row.name}
                t={t}
              />
              <UsageMeter
                label={t.usage.window7d}
                pct={row.d7pct}
                reset={row.d7reset}
                rowName={row.name}
                t={t}
              />
            </section>
          );
        })}
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
  const sortedTasks = useMemo(
    () =>
      [...tasks].sort((a, b) => {
        const statusRank = { active: 0, paused: 1, completed: 2 } as const;
        const rankDelta = statusRank[a.status] - statusRank[b.status];
        if (rankDelta !== 0) return rankDelta;
        return (a.nextRun ?? a.createdAt).localeCompare(
          b.nextRun ?? b.createdAt,
        );
      }),
    [tasks],
  );

  if (sortedTasks.length === 0) {
    return <EmptyState>{t.tasks.empty}</EmptyState>;
  }

  return (
    <>
      <div className="table-wrap desktop-table">
        <table>
          <thead>
            <tr>
              <th>{t.tasks.task}</th>
              <th>{t.tasks.status}</th>
              <th>{t.tasks.schedule}</th>
              <th>{t.tasks.next}</th>
              <th>{t.tasks.last}</th>
            </tr>
          </thead>
          <tbody>
            {sortedTasks.map((task) => (
              <tr key={task.id}>
                <td>
                  <strong>{task.isWatcher ? t.tasks.ciWatch : task.id}</strong>
                  <span>{task.promptPreview || t.tasks.emptyPrompt}</span>
                  <small>
                    {task.groupFolder} · {task.promptLength} {t.units.chars}
                  </small>
                </td>
                <td>
                  <span className={`pill pill-${task.status}`}>
                    {statusLabel(task.status, t)}
                  </span>
                  {task.suspendedUntil ? (
                    <small>
                      {t.tasks.until} {formatDate(task.suspendedUntil, locale)}
                    </small>
                  ) : null}
                </td>
                <td>
                  {task.scheduleType} · {task.scheduleValue}
                  <small>{task.contextMode}</small>
                </td>
                <td>{formatDate(task.nextRun, locale)}</td>
                <td>
                  {formatDate(task.lastRun, locale)}
                  {task.lastResult ? <small>{task.lastResult}</small> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mobile-record-list" aria-label={t.tasks.cardsAria}>
        {sortedTasks.map((task) => (
          <article className="record-card task-card" key={task.id}>
            <div className="record-card-head">
              <div>
                <strong>{task.isWatcher ? t.tasks.ciWatch : task.id}</strong>
                <span className="mono-chip">{task.groupFolder}</span>
              </div>
              <span className={`pill pill-${task.status}`}>
                {statusLabel(task.status, t)}
              </span>
            </div>
            <p>{task.promptPreview || t.tasks.emptyPrompt}</p>
            <div className="record-card-grid">
              <span>
                <small>{t.tasks.schedule}</small>
                <strong>{task.scheduleType}</strong>
              </span>
              <span>
                <small>{t.tasks.next}</small>
                <strong>{formatDate(task.nextRun, locale)}</strong>
              </span>
              <span>
                <small>{t.tasks.last}</small>
                <strong>{formatDate(task.lastRun, locale)}</strong>
              </span>
              <span>
                <small>{t.tasks.context}</small>
                <strong>{task.contextMode}</strong>
              </span>
            </div>
            {task.lastResult ? (
              <p className="record-id">
                {t.tasks.lastResult}: {task.lastResult}
              </p>
            ) : null}
          </article>
        ))}
      </div>
    </>
  );
}

function App() {
  const [data, setData] = useState<DashboardState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [locale, setLocale] = useState<Locale>(readInitialLocale);
  const t = messages[locale];

  function setDashboardLocale(nextLocale: Locale) {
    setLocale(nextLocale);
    window.localStorage.setItem(LOCALE_STORAGE_KEY, nextLocale);
  }

  async function refresh(showSpinner = false) {
    if (showSpinner) setRefreshing(true);
    try {
      const nextData = await fetchDashboardData();
      setData(nextData);
      setLastRefreshed(new Date().toISOString());
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
        lastRefreshed={lastRefreshed}
        locale={locale}
        onLocaleChange={setDashboardLocale}
        t={t}
      />
      <main className="dashboard-content">
        <header className="hero">
          <div>
            <span className="eyebrow">EJClaw · {t.app.readOnly}</span>
            <h1>{t.app.title}</h1>
            <p>{t.app.subtitle}</p>
          </div>
          <button disabled={refreshing} onClick={() => void refresh(true)}>
            {refreshing ? t.actions.refreshing : t.actions.refresh}
          </button>
        </header>

        <SectionNav
          drawerOpen={drawerOpen}
          lastRefreshed={lastRefreshed}
          locale={locale}
          onCloseDrawer={() => setDrawerOpen(false)}
          onLocaleChange={setDashboardLocale}
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
          <>
            <ControlRail data={data} t={t} />

            <section className="metrics-grid">
              <Card
                label={t.metrics.agents}
                value={data.overview.services.length}
                hint={formatDate(data.overview.generatedAt, locale)}
              />
              <Card
                label={t.metrics.rooms}
                value={data.overview.rooms.total}
                hint={`${data.overview.rooms.active} ${t.status.processing} · ${data.overview.rooms.waiting} ${t.status.waiting}`}
              />
              <Card
                label={t.metrics.tasks}
                value={data.overview.tasks.total}
                hint={`${data.overview.tasks.active} ${t.status.active} · ${data.overview.tasks.paused} ${t.status.paused}`}
              />
              <Card
                label={t.metrics.ciWatchers}
                value={data.overview.tasks.watchers.active}
                hint={`${data.overview.tasks.watchers.paused} ${t.status.paused} · ${data.overview.tasks.watchers.completed} ${t.metrics.done}`}
              />
            </section>

            <section className="panel" id="agents">
              <div className="panel-title">
                <h2>{t.panels.health}</h2>
                <span>{t.panels.heartbeat}</span>
              </div>
              <ServicePanel locale={locale} overview={data.overview} t={t} />
            </section>

            <section className="panel split-panel">
              <div id="usage">
                <div className="panel-title">
                  <h2>{t.panels.usage}</h2>
                  <span>{t.panels.usageWindow}</span>
                </div>
                <UsagePanel locale={locale} overview={data.overview} t={t} />
              </div>
              <div id="rooms">
                <div className="panel-title">
                  <h2>{t.panels.rooms}</h2>
                  <span>{t.panels.queue}</span>
                </div>
                <RoomPanel snapshots={data.snapshots} t={t} />
              </div>
            </section>

            <section className="panel" id="work">
              <div className="panel-title">
                <h2>{t.panels.scheduled}</h2>
                <span>{t.panels.redactedPreviews}</span>
              </div>
              <TaskPanel locale={locale} tasks={data.tasks} t={t} />
            </section>
          </>
        ) : null}
      </main>
    </div>
  );
}

export default App;
