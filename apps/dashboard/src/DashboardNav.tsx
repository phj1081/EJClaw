import { type ReactNode } from 'react';
import { Clock, Gauge, MessageSquare, Settings } from 'lucide-react';

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

export function SideRail({
  activeView,
  data,
  onNavigate,
  t,
}: {
  activeView: DashboardView;
  data: DashboardNavData | null;
  onNavigate: (view: DashboardView) => void;
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
    </aside>
  );
}

export function SectionNav({
  activeView,
  data,
  drawerOpen,
  freshness,
  freshnessText,
  onCloseDrawer,
  onNavigate,
  onOpenDrawer,
  onRefresh,
  refreshing,
  t,
}: {
  activeView: DashboardView;
  data: DashboardNavData | null;
  drawerOpen: boolean;
  freshness: DashboardFreshness;
  freshnessText: string;
  onCloseDrawer: () => void;
  onNavigate: (view: DashboardView) => void;
  onOpenDrawer: () => void;
  onRefresh: () => void;
  refreshing: boolean;
  t: Messages;
}) {
  const activeLabel =
    navItems(t).find((item) => item.view === activeView)?.label ?? t.nav.rooms;
  const showManualRefresh = freshness !== 'fresh';

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
        {showManualRefresh ? (
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
        ) : null}
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
          </aside>
        </>
      ) : null}
    </>
  );
}
