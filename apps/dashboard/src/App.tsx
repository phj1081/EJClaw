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
  lastRefreshed,
  refreshing,
  onRefresh,
}: {
  lastRefreshed: string | null;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  return (
    <nav className="section-nav" aria-label="Dashboard sections">
      <a href="#overview">Summary</a>
      <a href="#usage">Quota</a>
      <a href="#rooms">Rooms</a>
      <a href="#work">Work</a>
      <button
        aria-busy={refreshing}
        aria-label={refreshing ? '새로고침 중' : '새로고침'}
        disabled={refreshing}
        onClick={onRefresh}
        type="button"
      >
        {refreshing ? '...' : 'Refresh'}
      </button>
      <span>Updated {formatDate(lastRefreshed)}</span>
    </nav>
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
    return (
      <EmptyState>
        최근 status snapshot이 없어. 서비스가 아직 heartbeat를 안 쓴 상태일 수
        있어.
      </EmptyState>
    );
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
    return <EmptyState>표시할 룸 상태가 없어.</EmptyState>;
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
  if (overview.usage.rows.length === 0) {
    return (
      <EmptyState>
        사용량 snapshot이 없어. usage dashboard가 꺼져 있거나 아직 수집 전일 수
        있어.
      </EmptyState>
    );
  }

  return (
    <div className="usage-list">
      {overview.usage.rows.map((row) => (
        <section className="usage-row" key={row.name}>
          <div className="usage-title">
            <strong>{row.name}</strong>
            <span>fetched {formatDate(overview.usage.fetchedAt)}</span>
          </div>
          <div className="bar-line">
            <span>5h</span>
            <progress max={100} value={row.h5pct} />
            <strong>{formatPct(row.h5pct)}</strong>
            <small>{row.h5reset}</small>
          </div>
          <div className="bar-line">
            <span>7d</span>
            <progress max={100} value={row.d7pct} />
            <strong>{formatPct(row.d7pct)}</strong>
            <small>{row.d7reset}</small>
          </div>
        </section>
      ))}
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
    return <EmptyState>등록된 scheduled task가 없어.</EmptyState>;
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

  if (loading && !data) {
    return <LoadingSkeleton />;
  }

  return (
    <main className="shell">
      <header className="hero">
        <div>
          <span className="eyebrow">EJClaw Control Plane · read-only MVP</span>
          <h1>Agent factory control room</h1>
          <p>
            Discord는 pager와 승인 호출로 남기고, 여기서는 agent heartbeat, room
            queue, scheduled work, quota, audit preview를 한 화면에서 본다.
          </p>
        </div>
        <button disabled={refreshing} onClick={() => void refresh(true)}>
          {refreshing ? '새로고침 중' : '새로고침'}
        </button>
      </header>

      <SectionNav
        lastRefreshed={lastRefreshed}
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
              <h2>Agent Heartbeats</h2>
              <span>최근 heartbeat 기준</span>
            </div>
            <ServicePanel overview={data.overview} />
          </section>

          <section className="panel split-panel">
            <div id="usage">
              <div className="panel-title">
                <h2>Cost & Quota</h2>
                <span>5h / 7d usage snapshot</span>
              </div>
              <UsagePanel overview={data.overview} />
            </div>
            <div id="rooms">
              <div className="panel-title">
                <h2>Rooms & Queues</h2>
                <span>processing / waiting / inactive</span>
              </div>
              <RoomPanel snapshots={data.snapshots} />
            </div>
          </section>

          <section className="panel" id="work">
            <div className="panel-title">
              <h2>Scheduled Work</h2>
              <span>watchers, heartbeats, redacted prompt previews</span>
            </div>
            <TaskPanel tasks={data.tasks} />
          </section>
        </>
      ) : null}
    </main>
  );
}

export default App;
