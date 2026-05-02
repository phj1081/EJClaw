import { useEffect, useState } from 'react';

import {
  type CreateScheduledTaskInput,
  type DashboardRoomActivity,
  type DashboardTaskAction,
  type DashboardOverview,
  type DashboardTask,
  type UpdateScheduledTaskInput,
  type StatusSnapshot,
  createScheduledTask,
  fetchDashboardData,
  runServiceAction,
  runScheduledTaskAction,
  sendRoomMessage,
  updateScheduledTask,
} from './api';
import {
  isLocale,
  localeTags,
  matchLocale,
  messages,
  type Locale,
  type Messages,
} from './i18n';
import { useSelectedRoomActivity } from './useRoomActivity';
import {
  SectionNav,
  SideRail,
  type DashboardFreshness,
  type DashboardView,
} from './DashboardNav';
import { formatDate, statusLabel } from './dashboardHelpers';
import { RoomBoardV2 } from './RoomBoardV2';
import { SettingsPanel } from './SettingsPanel';
import { SystemStatusStrip } from './SystemStatusStrip';
import { TaskPanel, type RoomOption, type TaskActionKey } from './TaskPanel';
import { UsagePanel } from './UsagePanel';
import './styles.css';

interface DashboardState {
  overview: DashboardOverview;
  snapshots: StatusSnapshot[];
  tasks: DashboardTask[];
}

type FreshnessLevel = DashboardFreshness;

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
};

const REFRESH_INTERVAL_MS = 15_000;
const LOCALE_STORAGE_KEY = 'ejclaw.dashboard.locale.v2';
const DEFAULT_VIEW: DashboardView = 'rooms';
const DASHBOARD_STALE_MS = 75_000;

function makeClientRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function isDashboardView(
  value: string | null | undefined,
): value is DashboardView {
  return (
    value === 'usage' ||
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

function normalizeDashboardHash(view: DashboardView): void {
  if (typeof window === 'undefined') return;
  const raw = window.location.hash.replace(/^#\/?/, '');
  if (!raw || isDashboardView(raw)) return;
  window.history.replaceState(null, '', `#/${view}`);
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

function persistNickname(trimmed: string): void {
  if (typeof window === 'undefined') return;
  if (trimmed) window.localStorage.setItem('ejclaw-nickname', trimmed);
  else window.localStorage.removeItem('ejclaw-nickname');
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
  return [...rooms.values()].sort((a, b) =>
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
      <button disabled={refreshing} onClick={onRetry}>
        {t.actions.retry}
      </button>
    </section>
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
  const [serviceRestarting, setServiceRestarting] = useState(false);
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
    persistNickname(trimmed);
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

  async function handleServiceRestart() {
    if (
      typeof window !== 'undefined' &&
      !window.confirm(t.health.confirmRestart)
    ) {
      return;
    }

    setServiceRestarting(true);
    try {
      await runServiceAction('stack', 'restart', {
        requestId: makeClientRequestId(),
      });
      await refresh(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setServiceRestarting(false);
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
      const nextView = readViewFromHash();
      setActiveView(nextView);
      normalizeDashboardHash(nextView);
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
          data={data}
          drawerOpen={drawerOpen}
          freshness={freshness}
          freshnessText={freshnessLabel(freshness, t)}
          installed={installed}
          onCloseDrawer={() => setDrawerOpen(false)}
          onInstall={() => void handleInstallApp()}
          onNavigate={navigateToView}
          onOpenDrawer={() => setDrawerOpen(true)}
          offlineReady={offlineReady}
          onRefresh={() => void refresh(true)}
          online={online}
          refreshing={refreshing}
          secureContext={secureContext}
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
