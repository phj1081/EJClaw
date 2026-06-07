import { useEffect, useState } from 'react';

import {
  type DashboardInboxAction,
  type DashboardOverview,
  type StatusSnapshot,
  fetchDashboardData,
  runInboxAction,
  sendRoomMessage,
} from './api';
import { isLocale, matchLocale, type Locale } from './i18n';
import { GlassesPanel } from './GlassesPanel';
import './styles.css';
import './glasses.css';

interface GlassesState {
  overview: DashboardOverview;
  snapshots: StatusSnapshot[];
}

type InboxItem = DashboardOverview['inbox'][number];
type InboxActionKey = `${string}:${DashboardInboxAction}`;

const REFRESH_INTERVAL_MS = 15_000;
const DASHBOARD_STALE_MS = 75_000;
const LOCALE_STORAGE_KEY = 'ejclaw.dashboard.locale.v2';

function makeClientRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
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

function dashboardAgeMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return Math.max(0, Date.now() - date.getTime());
}

function freshnessLabel(
  online: boolean,
  generatedAt: string | null | undefined,
): string {
  if (!online) return 'offline';
  const age = dashboardAgeMs(generatedAt);
  if (age !== null && age > DASHBOARD_STALE_MS) return 'stale';
  return 'fresh';
}

function readNickname(): string {
  if (typeof window === 'undefined') return '';
  return window.localStorage.getItem('ejclaw-nickname') ?? '';
}

export function GlassesApp() {
  const [data, setData] = useState<GlassesState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );
  const [locale] = useState<Locale>(readInitialLocale);
  const [inboxActionKey, setInboxActionKey] = useState<InboxActionKey | null>(
    null,
  );
  const [roomMessageKey, setRoomMessageKey] = useState<string | null>(null);

  async function refresh(showSpinner = false) {
    if (showSpinner) setRefreshing(true);
    try {
      const nextData = await fetchDashboardData();
      setData({
        overview: nextData.overview,
        snapshots: nextData.snapshots,
      });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  async function handleInboxAction(
    item: InboxItem,
    action: DashboardInboxAction,
  ) {
    const actionKey: InboxActionKey = `${item.id}:${action}`;
    setInboxActionKey(actionKey);
    try {
      await runInboxAction(item.id, action, {
        lastOccurredAt: item.lastOccurredAt,
        requestId: makeClientRequestId(),
      });
      await refresh(false);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setInboxActionKey(null);
    }
  }

  async function handleRoomMessage(
    roomJid: string,
    text: string,
    requestId: string,
  ) {
    setRoomMessageKey(roomJid);
    try {
      await sendRoomMessage(roomJid, text, requestId, readNickname() || null);
      void refresh(false);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setRoomMessageKey(null);
    }
  }

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

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
    void refresh();
    const id = window.setInterval(() => {
      void refresh();
    }, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, []);

  if (loading && !data) {
    return (
      <main className="glasses-shell" aria-busy="true">
        <div className="glasses-empty">
          <strong>EJClaw</strong>
          <span>Loading</span>
        </div>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="glasses-shell">
        <p className="glasses-error">{error ?? 'Dashboard unavailable'}</p>
      </main>
    );
  }

  return (
    <GlassesPanel
      createRequestId={makeClientRequestId}
      error={error}
      freshnessText={freshnessLabel(online, data.overview.generatedAt)}
      inboxActionKey={inboxActionKey}
      locale={locale}
      onInboxAction={handleInboxAction}
      onRefresh={() => void refresh(true)}
      onSendRoomMessage={handleRoomMessage}
      overview={data.overview}
      refreshing={refreshing}
      roomMessageKey={roomMessageKey}
      snapshots={data.snapshots}
    />
  );
}
