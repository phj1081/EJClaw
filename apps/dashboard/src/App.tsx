import { type StatusSnapshot } from './api';
import { messages, type Messages } from './i18n';
import { SectionNav, SideRail, type DashboardFreshness } from './DashboardNav';
import { formatDate, statusLabel } from './dashboardHelpers';
import { RoomBoardV2 } from './RoomBoardV2';
import { SettingsPanel } from './SettingsPanel';
import { SystemStatusStrip } from './SystemStatusStrip';
import { TaskPanel, type RoomOption } from './TaskPanel';
import { UsagePanel } from './UsagePanel';
import {
  makeClientRequestId,
  useDashboardActions,
} from './useDashboardActions';
import { useDashboardChrome } from './useDashboardChrome';
import { useDashboardData } from './useDashboardData';
import { useRoomMessaging } from './useRoomMessaging';
import './styles.css';

type FreshnessLevel = DashboardFreshness;

const DASHBOARD_STALE_MS = 75_000;

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

function senderRoleClass(value: string | null | undefined): string {
  const v = (value ?? '').toLowerCase();
  if (v.includes('오너') || v.includes('owner')) return 'role-owner';
  if (v.includes('리뷰어') || v.includes('reviewer')) return 'role-reviewer';
  if (v.includes('중재자') || v.includes('arbiter')) return 'role-arbiter';
  if (v.includes('cron') || v.includes('sentry') || v.includes('webhook'))
    return 'role-cron';
  return 'role-human';
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

const ROOM_BOARD_FORMATTERS = {
  formatDate,
  formatDuration,
  formatLiveElapsed,
  senderRoleClass,
  statusLabel,
};

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
  return Array.from(rooms.values()).sort((a, b) =>
    `${a.name} ${a.folder}`.localeCompare(`${b.name} ${b.folder}`),
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

function DashboardErrorCard({
  error,
  onRetry,
  refreshing,
  t,
}: {
  error: string;
  onRetry: () => void;
  refreshing: boolean;
  t: Messages;
}) {
  return (
    <section className="error-card" role="alert" aria-live="polite">
      <span>
        <strong>{t.error.api}</strong>
        <small>{humanizeError(error, t)}</small>
      </span>
      <button disabled={refreshing} onClick={onRetry} type="button">
        {t.actions.retry}
      </button>
    </section>
  );
}

function App() {
  const { data, error, loading, refresh, refreshing, setError } =
    useDashboardData();
  const {
    activeView,
    drawerOpen,
    locale,
    navigateToView,
    nickname,
    online,
    setDashboardLocale,
    setDrawerOpen,
    setNickname,
  } = useDashboardChrome();
  const t = messages[locale];
  const {
    handleServiceRestart,
    handleTaskAction,
    handleTaskCreate,
    handleTaskUpdate,
    serviceRestarting,
    taskActionKey,
  } = useDashboardActions({ refresh, setError, t });
  const {
    handleRoomMessage,
    pendingMessages,
    roomActivity,
    roomActivityLoading,
    roomMessageKey,
    selectedRoomJid,
    setSelectedRoomJid,
  } = useRoomMessaging({
    active: activeView === 'rooms',
    nickname,
    refresh,
    setError,
  });

  if (loading && !data) {
    return <LoadingSkeleton t={t} />;
  }

  const roomOptions = data ? buildRoomOptions(data.snapshots) : [];
  const freshness = dashboardFreshness(online, data?.overview.generatedAt);

  return (
    <div className="shell">
      <SideRail
        activeView={activeView}
        data={data}
        onNavigate={navigateToView}
        t={t}
      />
      <main className="dashboard-content">
        <SectionNav
          activeView={activeView}
          data={data}
          drawerOpen={drawerOpen}
          freshness={freshness}
          freshnessText={freshnessLabel(freshness, t)}
          onCloseDrawer={() => setDrawerOpen(false)}
          onNavigate={navigateToView}
          onOpenDrawer={() => setDrawerOpen(true)}
          onRefresh={() => void refresh(true)}
          refreshing={refreshing}
          t={t}
        />

        {error ? (
          <DashboardErrorCard
            error={error}
            onRetry={() => void refresh(true)}
            refreshing={refreshing}
            t={t}
          />
        ) : null}

        {data ? (
          <div className={`view-stack view-${activeView}`}>
            {activeView === 'usage' ? (
              <section className="panel usage-first" id="usage">
                <div className="panel-title">
                  <h2>{t.panels.usage}</h2>
                  <span>{t.panels.usageWindow}</span>
                </div>
                <UsagePanel overview={data.overview} t={t} />
              </section>
            ) : null}

            {activeView === 'rooms' ? (
              <section className="panel view-panel" id="rooms">
                <div className="panel-title">
                  <h2>{t.panels.rooms}</h2>
                  <span>{t.panels.queue}</span>
                </div>
                <SystemStatusStrip overview={data.overview} t={t} />
                <RoomBoardV2
                  {...ROOM_BOARD_FORMATTERS}
                  createRequestId={makeClientRequestId}
                  inbox={data.overview.inbox}
                  locale={locale}
                  onSelectedJidChange={setSelectedRoomJid}
                  onSendRoomMessage={handleRoomMessage}
                  pendingMessages={pendingMessages}
                  roomActivity={roomActivity}
                  roomActivityLoading={roomActivityLoading}
                  roomMessageKey={roomMessageKey}
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
                  onRestartStack={() => {
                    if (!serviceRestarting) void handleServiceRestart();
                  }}
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
