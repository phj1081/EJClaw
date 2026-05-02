import { type ReactNode } from 'react';
import {
  Clock,
  Download,
  Gauge,
  MessageSquare,
  RefreshCw,
  Settings,
} from 'lucide-react';

import { type DashboardOverview, type StatusSnapshot } from './api';
import { type Messages } from './i18n';

export type DashboardView = 'usage' | 'rooms' | 'scheduled' | 'settings';
export type DashboardFreshness = 'fresh' | 'stale' | 'offline';

interface DashboardNavData {
  overview: DashboardOverview;
  snapshots: StatusSnapshot[];
}

const NAV_ICONS: Record<DashboardView, ReactNode> = {
  usage: <Gauge size={20} strokeWidth={2} aria-hidden />,
  rooms: <MessageSquare size={20} strokeWidth={2} aria-hidden />,
  scheduled: <Clock size={20} strokeWidth={2} aria-hidden />,
  settings: <Settings size={20} strokeWidth={2} aria-hidden />,
};

function navItems(t: Messages) {
  return [
    { href: '#/rooms', label: t.nav.rooms, view: 'rooms' as const },
    { href: '#/scheduled', label: t.nav.scheduled, view: 'scheduled' as const },
    { href: '#/usage', label: t.nav.usage, view: 'usage' as const },
    { href: '#/settings', label: t.nav.settings, view: 'settings' as const },
  ];
}

function navStats(data: DashboardNavData | null) {
  if (!data) return null;
  const queue = data.snapshots.reduce(
    (acc, snapshot) => {
      for (const entry of snapshot.entries) {
        if (entry.status === 'processing') acc.processing += 1;
      }
      return acc;
    },
    { processing: 0 },
  );
  return {
    processing: queue.processing,
  };
}

function navBadge(
  view: DashboardView,
  stats: ReturnType<typeof navStats>,
): number | null {
  if (view === 'rooms' && stats && stats.processing > 0) {
    return stats.processing;
  }
  return null;
}

function pwaStateLabel({
  installed,
  offlineReady,
  secureContext,
  t,
}: {
  installed: boolean;
  offlineReady: boolean;
  secureContext: boolean;
  t: Messages;
}) {
  if (!secureContext) return t.pwa.secureRequired;
  if (installed) return t.pwa.installed;
  if (offlineReady) return t.pwa.ready;
  return t.pwa.app;
}

function DashboardBrandLink({
  onNavigate,
}: {
  onNavigate: (view: DashboardView) => void;
}) {
  return (
    <a
      className="rail-brand"
      href="#/rooms"
      onClick={() => onNavigate('rooms')}
      title="EJClaw"
    >
      EJ
    </a>
  );
}

function DashboardNavLinks({
  activeView,
  data,
  onAfterNavigate,
  onNavigate,
  t,
}: {
  activeView: DashboardView;
  data: DashboardNavData | null;
  onAfterNavigate?: () => void;
  onNavigate: (view: DashboardView) => void;
  t: Messages;
}) {
  const stats = navStats(data);
  return (
    <nav className="rail-nav" aria-label={t.nav.drawerNavAria}>
      {navItems(t).map((item) => {
        const badge = navBadge(item.view, stats);
        return (
          <a
            aria-current={activeView === item.view ? 'page' : undefined}
            aria-label={item.label}
            className={`rail-item${activeView === item.view ? ' is-active' : ''}`}
            href={item.href}
            key={item.href}
            onClick={() => {
              onNavigate(item.view);
              onAfterNavigate?.();
            }}
            title={item.label}
          >
            <span className="rail-icon">{NAV_ICONS[item.view]}</span>
            <span className="rail-label">{item.label}</span>
            {badge !== null ? (
              <span className="rail-badge">{badge}</span>
            ) : null}
          </a>
        );
      })}
    </nav>
  );
}

function DashboardNavActions({
  canInstall,
  installed,
  offlineReady,
  onInstall,
  onRefresh,
  online,
  refreshing,
  secureContext,
  t,
}: {
  canInstall: boolean;
  installed: boolean;
  offlineReady: boolean;
  onInstall: () => void;
  onRefresh: () => void;
  online: boolean;
  refreshing: boolean;
  secureContext: boolean;
  t: Messages;
}) {
  const pwaState = pwaStateLabel({ installed, offlineReady, secureContext, t });
  const status = `${online ? t.pwa.online : t.pwa.offline} · ${pwaState}`;
  return (
    <div className="rail-foot">
      <div className="rail-status-line" title={status}>
        <span
          className={`rail-status-dot ${online ? 'is-online' : 'is-offline'}`}
          aria-label={online ? t.pwa.online : t.pwa.offline}
        />
        <span className="rail-foot-label">{status}</span>
      </div>
      <div className="rail-actions">
        {canInstall ? (
          <button
            className="rail-btn"
            onClick={onInstall}
            title={t.pwa.install}
            aria-label={t.pwa.install}
            type="button"
          >
            <Download size={16} strokeWidth={2} aria-hidden />
            <span className="rail-btn-label">{t.pwa.install}</span>
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
          <span className="rail-btn-label">
            {refreshing ? t.actions.refreshing : t.actions.refresh}
          </span>
        </button>
      </div>
    </div>
  );
}

export function SideRail({
  activeView,
  canInstall,
  data,
  installed,
  offlineReady,
  onInstall,
  onNavigate,
  onRefresh,
  online,
  refreshing,
  secureContext,
  t,
}: {
  activeView: DashboardView;
  canInstall: boolean;
  data: DashboardNavData | null;
  installed: boolean;
  offlineReady: boolean;
  onInstall: () => void;
  onNavigate: (view: DashboardView) => void;
  onRefresh: () => void;
  online: boolean;
  refreshing: boolean;
  secureContext: boolean;
  t: Messages;
}) {
  return (
    <aside className="side-rail icon-rail" aria-label={t.nav.drawerAria}>
      <DashboardBrandLink onNavigate={onNavigate} />
      <DashboardNavLinks
        activeView={activeView}
        data={data}
        onNavigate={onNavigate}
        t={t}
      />
      <DashboardNavActions
        canInstall={canInstall}
        installed={installed}
        offlineReady={offlineReady}
        online={online}
        onInstall={onInstall}
        onRefresh={onRefresh}
        refreshing={refreshing}
        secureContext={secureContext}
        t={t}
      />
    </aside>
  );
}

export function SectionNav({
  activeView,
  canInstall,
  data,
  drawerOpen,
  freshness,
  freshnessText,
  installed,
  onCloseDrawer,
  onInstall,
  onNavigate,
  onOpenDrawer,
  offlineReady,
  onRefresh,
  online,
  refreshing,
  secureContext,
  t,
}: {
  activeView: DashboardView;
  canInstall: boolean;
  data: DashboardNavData | null;
  drawerOpen: boolean;
  freshness: DashboardFreshness;
  freshnessText: string;
  installed: boolean;
  onCloseDrawer: () => void;
  onInstall: () => void;
  onNavigate: (view: DashboardView) => void;
  onOpenDrawer: () => void;
  offlineReady: boolean;
  onRefresh: () => void;
  online: boolean;
  refreshing: boolean;
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
          {freshnessText}
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
              <DashboardBrandLink onNavigate={onNavigate} />
              <div className="drawer-title">
                <span className="eyebrow">EJClaw</span>
                <strong>{t.nav.operations}</strong>
              </div>
              <button
                aria-label={t.nav.menuClose}
                className="rail-btn drawer-close"
                onClick={onCloseDrawer}
                type="button"
              >
                {t.actions.close}
              </button>
            </div>
            <DashboardNavLinks
              activeView={activeView}
              data={data}
              onAfterNavigate={onCloseDrawer}
              onNavigate={onNavigate}
              t={t}
            />
            <DashboardNavActions
              canInstall={canInstall}
              installed={installed}
              offlineReady={offlineReady}
              online={online}
              onInstall={onInstall}
              onRefresh={onRefresh}
              refreshing={refreshing}
              secureContext={secureContext}
              t={t}
            />
          </aside>
        </>
      ) : null}
    </>
  );
}
