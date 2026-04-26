import { useEffect, useMemo, useState, type ReactNode } from 'react';

import {
  type DashboardOverview,
  type DashboardTask,
  type StatusSnapshot,
  fetchDashboardData,
} from './api';
import './styles.css';

interface DashboardState {
  overview: DashboardOverview;
  snapshots: StatusSnapshot[];
  tasks: DashboardTask[];
}

const REFRESH_INTERVAL_MS = 15_000;

function formatDate(value: string | null | undefined): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('ko-KR', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
}

function formatPct(value: number): string {
  return `${Math.round(value)}%`;
}

function usagePeak(row: DashboardOverview['usage']['rows'][number]): number {
  return Math.max(row.h5pct, row.d7pct);
}

function usageRisk(row: DashboardOverview['usage']['rows'][number]): {
  level: 'ok' | 'warn' | 'critical';
  label: string;
} {
  const peak = usagePeak(row);
  if (peak >= 85) return { level: 'critical', label: 'Limit risk' };
  if (peak >= 65) return { level: 'warn', label: 'Watch' };
  return { level: 'ok', label: 'Clear' };
}

function statusLabel(status: string): string {
  switch (status) {
    case 'processing':
      return '처리중';
    case 'waiting':
      return '대기';
    case 'inactive':
      return '휴면';
    case 'active':
      return '활성';
    case 'paused':
      return '일시정지';
    case 'completed':
      return '완료';
    default:
      return status;
  }
}

function formatDuration(value: number | null): string {
  if (value === null) return '-';
  const seconds = Math.floor(value / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
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

function LoadingSkeleton() {
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
      <section className="metrics-grid">
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

function SectionNav({
  drawerOpen,
  lastRefreshed,
  onCloseDrawer,
  onOpenDrawer,
  refreshing,
  onRefresh,
}: {
  drawerOpen: boolean;
  lastRefreshed: string | null;
  onCloseDrawer: () => void;
  onOpenDrawer: () => void;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const navItems = [
    { href: '#overview', label: 'Health' },
    { href: '#agents', label: 'Agents' },
    { href: '#usage', label: 'Usage' },
    { href: '#rooms', label: 'Rooms' },
    { href: '#work', label: 'Scheduled' },
  ];

  return (
    <>
      <nav className="section-nav" aria-label="Dashboard sections">
        <button
          aria-controls="dashboard-menu"
          aria-expanded={drawerOpen}
          aria-label={drawerOpen ? '메뉴 닫기' : '메뉴 열기'}
          className="menu-button"
          onClick={drawerOpen ? onCloseDrawer : onOpenDrawer}
          type="button"
        >
          <span />
          <span />
          <span />
        </button>
        <a href="#overview">Health</a>
        <a href="#usage">Usage</a>
        <a href="#work">Work</a>
        <button
          aria-busy={refreshing}
          aria-label={refreshing ? '새로고침 중' : '새로고침'}
          className="refresh-button"
          disabled={refreshing}
          onClick={onRefresh}
          type="button"
        >
          {refreshing ? '...' : 'Refresh'}
        </button>
        <span>Updated {formatDate(lastRefreshed)}</span>
      </nav>

      {drawerOpen ? (
        <>
          <button
            aria-label="메뉴 닫기"
            className="drawer-backdrop"
            onClick={onCloseDrawer}
            type="button"
          />
          <aside
            aria-label="Dashboard menu"
            aria-modal="true"
            className="nav-drawer"
            id="dashboard-menu"
            role="dialog"
          >
            <div className="drawer-head">
              <div>
                <span className="eyebrow">EJClaw</span>
                <strong>Operations</strong>
              </div>
              <button
                aria-label="메뉴 닫기"
                onClick={onCloseDrawer}
                type="button"
              >
                Close
              </button>
            </div>
            <nav aria-label="Dashboard drawer sections">
              {navItems.map((item) => (
                <a href={item.href} key={item.href} onClick={onCloseDrawer}>
                  {item.label}
                </a>
              ))}
            </nav>
            <div className="drawer-meta">
              <span>Updated</span>
              <strong>{formatDate(lastRefreshed)}</strong>
            </div>
          </aside>
        </>
      ) : null}
    </>
  );
}

function ControlRail({ data }: { data: DashboardState }) {
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
    <section
      className="control-rail"
      id="overview"
      aria-label="control plane summary"
    >
      <div>
        <span className="eyebrow">agent heartbeat</span>
        <strong>
          {data.overview.rooms.active + data.overview.rooms.waiting}/
          {data.overview.rooms.total}
        </strong>
        <small>processing + waiting rooms</small>
      </div>
      <div>
        <span className="eyebrow">work queue</span>
        <strong>{queue.pendingTasks}</strong>
        <small>{queue.pendingMessageRooms} rooms with pending messages</small>
      </div>
      <div>
        <span className="eyebrow">governance</span>
        <strong>read only</strong>
        <small>no approvals, merges, or worker kills in MVP</small>
      </div>
      <div>
        <span className="eyebrow">audit safety</span>
        <strong>redacted</strong>
        <small>task prompts are preview-only</small>
      </div>
    </section>
  );
}

function ServicePanel({ overview }: { overview: DashboardOverview }) {
  if (overview.services.length === 0) {
    return <EmptyState>No heartbeat yet. Check service logs.</EmptyState>;
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
            <small>heartbeat {formatDate(service.updatedAt)}</small>
          </div>
          <dl>
            <div>
              <dt>service</dt>
              <dd>{service.serviceId}</dd>
            </div>
            <div>
              <dt>rooms</dt>
              <dd>
                {service.activeRooms}/{service.totalRooms} active
              </dd>
            </div>
            <div>
              <dt>updated</dt>
              <dd>{formatDate(service.updatedAt)}</dd>
            </div>
          </dl>
        </section>
      ))}
    </div>
  );
}

function RoomPanel({ snapshots }: { snapshots: StatusSnapshot[] }) {
  const entries = snapshots.flatMap((snapshot) =>
    snapshot.entries.map((entry) => ({
      ...entry,
      serviceId: snapshot.serviceId,
    })),
  );

  if (entries.length === 0) {
    return <EmptyState>No rooms yet.</EmptyState>;
  }

  return (
    <>
      <div className="table-wrap desktop-table">
        <table>
          <thead>
            <tr>
              <th>room</th>
              <th>service</th>
              <th>agent</th>
              <th>status</th>
              <th>queue</th>
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
                    {statusLabel(entry.status)}
                  </span>
                  <small>{formatDuration(entry.elapsedMs)}</small>
                </td>
                <td>
                  {entry.pendingTasks} task
                  {entry.pendingMessages ? ' · msg' : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mobile-record-list" aria-label="Room status cards">
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
                {statusLabel(entry.status)}
              </span>
            </div>
            <div className="record-card-grid">
              <span>
                <small>queue</small>
                <strong>
                  {entry.pendingTasks} task
                  {entry.pendingMessages ? ' + msg' : ''}
                </strong>
              </span>
              <span>
                <small>agent</small>
                <strong>{entry.agentType}</strong>
              </span>
              <span>
                <small>service</small>
                <strong>{entry.serviceId}</strong>
              </span>
              <span>
                <small>elapsed</small>
                <strong>{formatDuration(entry.elapsedMs)}</strong>
              </span>
            </div>
            <p className="record-id">{entry.jid}</p>
          </article>
        ))}
      </div>
    </>
  );
}

function UsagePanel({ overview }: { overview: DashboardOverview }) {
  const rows = useMemo(
    () => [...overview.usage.rows].sort((a, b) => usagePeak(b) - usagePeak(a)),
    [overview.usage.rows],
  );
  const watched = rows.filter((row) => usagePeak(row) >= 65).length;

  if (rows.length === 0) {
    return <EmptyState>No usage snapshot. Check collector.</EmptyState>;
  }

  const highest = rows[0];

  return (
    <div className="usage-dashboard">
      <div className="usage-summary">
        <div>
          <span>Highest</span>
          <strong>
            {highest.name} · {formatPct(usagePeak(highest))}
          </strong>
        </div>
        <div>
          <span>Watch</span>
          <strong>{watched}</strong>
        </div>
        <div>
          <span>Updated</span>
          <strong>{formatDate(overview.usage.fetchedAt)}</strong>
        </div>
      </div>

      <div className="usage-grid">
        {rows.map((row) => {
          const risk = usageRisk(row);
          return (
            <section
              className={`usage-card usage-${risk.level}`}
              key={row.name}
            >
              <div className="usage-card-head">
                <strong>{row.name}</strong>
                <span className={`pill pill-${risk.level}`}>{risk.label}</span>
              </div>
              <div className="usage-score">
                <span>Peak</span>
                <strong>{formatPct(usagePeak(row))}</strong>
              </div>
              <div className="usage-meter">
                <div>
                  <span>5h</span>
                  <strong>{formatPct(row.h5pct)}</strong>
                </div>
                <progress max={100} value={row.h5pct} />
                <small>reset {row.h5reset}</small>
              </div>
              <div className="usage-meter">
                <div>
                  <span>7d</span>
                  <strong>{formatPct(row.d7pct)}</strong>
                </div>
                <progress max={100} value={row.d7pct} />
                <small>reset {row.d7reset}</small>
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function TaskPanel({ tasks }: { tasks: DashboardTask[] }) {
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
    return <EmptyState>No scheduled work.</EmptyState>;
  }

  return (
    <>
      <div className="table-wrap desktop-table">
        <table>
          <thead>
            <tr>
              <th>task</th>
              <th>status</th>
              <th>schedule</th>
              <th>next</th>
              <th>last</th>
            </tr>
          </thead>
          <tbody>
            {sortedTasks.map((task) => (
              <tr key={task.id}>
                <td>
                  <strong>{task.isWatcher ? 'CI Watch' : task.id}</strong>
                  <span>{task.promptPreview || '(empty prompt preview)'}</span>
                  <small>
                    {task.groupFolder} · {task.promptLength} chars
                  </small>
                </td>
                <td>
                  <span className={`pill pill-${task.status}`}>
                    {statusLabel(task.status)}
                  </span>
                  {task.suspendedUntil ? (
                    <small>until {formatDate(task.suspendedUntil)}</small>
                  ) : null}
                </td>
                <td>
                  {task.scheduleType} · {task.scheduleValue}
                  <small>{task.contextMode}</small>
                </td>
                <td>{formatDate(task.nextRun)}</td>
                <td>
                  {formatDate(task.lastRun)}
                  {task.lastResult ? <small>{task.lastResult}</small> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mobile-record-list" aria-label="Scheduled task cards">
        {sortedTasks.map((task) => (
          <article className="record-card task-card" key={task.id}>
            <div className="record-card-head">
              <div>
                <strong>{task.isWatcher ? 'CI Watch' : task.id}</strong>
                <span className="mono-chip">{task.groupFolder}</span>
              </div>
              <span className={`pill pill-${task.status}`}>
                {statusLabel(task.status)}
              </span>
            </div>
            <p>{task.promptPreview || '(empty prompt preview)'}</p>
            <div className="record-card-grid">
              <span>
                <small>schedule</small>
                <strong>{task.scheduleType}</strong>
              </span>
              <span>
                <small>next</small>
                <strong>{formatDate(task.nextRun)}</strong>
              </span>
              <span>
                <small>last</small>
                <strong>{formatDate(task.lastRun)}</strong>
              </span>
              <span>
                <small>context</small>
                <strong>{task.contextMode}</strong>
              </span>
            </div>
            {task.lastResult ? (
              <p className="record-id">last result: {task.lastResult}</p>
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
    return <LoadingSkeleton />;
  }

  return (
    <main className="shell">
      <header className="hero">
        <div>
          <span className="eyebrow">EJClaw · read-only</span>
          <h1>Operations</h1>
          <p>Health · Queue · Usage · Rooms · Scheduled</p>
        </div>
        <button disabled={refreshing} onClick={() => void refresh(true)}>
          {refreshing ? '새로고침 중' : '새로고침'}
        </button>
      </header>

      <SectionNav
        drawerOpen={drawerOpen}
        lastRefreshed={lastRefreshed}
        onCloseDrawer={() => setDrawerOpen(false)}
        onOpenDrawer={() => setDrawerOpen(true)}
        onRefresh={() => void refresh(true)}
        refreshing={refreshing}
      />

      {error ? (
        <section className="error-card">
          <span>API 오류: {error}</span>
          <button disabled={refreshing} onClick={() => void refresh(true)}>
            다시 시도
          </button>
        </section>
      ) : null}

      {data ? (
        <>
          <ControlRail data={data} />

          <section className="metrics-grid">
            <Card
              label="agents"
              value={data.overview.services.length}
              hint={formatDate(data.overview.generatedAt)}
            />
            <Card
              label="rooms"
              value={data.overview.rooms.total}
              hint={`${data.overview.rooms.active} processing · ${data.overview.rooms.waiting} waiting`}
            />
            <Card
              label="tasks"
              value={data.overview.tasks.total}
              hint={`${data.overview.tasks.active} active · ${data.overview.tasks.paused} paused`}
            />
            <Card
              label="CI watchers"
              value={data.overview.tasks.watchers.active}
              hint={`${data.overview.tasks.watchers.paused} paused · ${data.overview.tasks.watchers.completed} done`}
            />
          </section>

          <section className="panel" id="agents">
            <div className="panel-title">
              <h2>Health</h2>
              <span>Heartbeat</span>
            </div>
            <ServicePanel overview={data.overview} />
          </section>

          <section className="panel split-panel">
            <div id="usage">
              <div className="panel-title">
                <h2>Usage</h2>
                <span>5h / 7d</span>
              </div>
              <UsagePanel overview={data.overview} />
            </div>
            <div id="rooms">
              <div className="panel-title">
                <h2>Rooms</h2>
                <span>Queue</span>
              </div>
              <RoomPanel snapshots={data.snapshots} />
            </div>
          </section>

          <section className="panel" id="work">
            <div className="panel-title">
              <h2>Scheduled</h2>
              <span>Redacted previews</span>
            </div>
            <TaskPanel tasks={data.tasks} />
          </section>
        </>
      ) : null}
    </main>
  );
}

export default App;
