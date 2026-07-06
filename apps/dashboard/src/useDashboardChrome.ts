import { useEffect, useState } from 'react';

import { isLocale, localeTags, matchLocale, type Locale } from './i18n';
import { type DashboardView } from './DashboardNav';

const LOCALE_STORAGE_KEY = 'ejclaw.dashboard.locale.v2';
const DEFAULT_VIEW: DashboardView = 'rooms';

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

function canUsePwaCore(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    'serviceWorker' in navigator
  );
}

export function useDashboardChrome(): {
  activeView: DashboardView;
  drawerOpen: boolean;
  locale: Locale;
  navigateToView: (view: DashboardView) => void;
  nickname: string;
  online: boolean;
  setDashboardLocale: (nextLocale: Locale) => void;
  setDrawerOpen: (open: boolean) => void;
  setNickname: (next: string) => void;
} {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [activeView, setActiveView] = useState<DashboardView>(readViewFromHash);
  const [locale, setLocale] = useState<Locale>(readInitialLocale);
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );
  const [nickname, setNicknameState] = useState<string>(() => {
    if (typeof window === 'undefined') return '';
    return window.localStorage.getItem('ejclaw-nickname') ?? '';
  });

  function setNickname(next: string) {
    const trimmed = next.trim().slice(0, 32);
    setNicknameState(trimmed);
    persistNickname(trimmed);
  }

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
    if (!import.meta.env.PROD || !canUsePwaCore()) return;

    void navigator.serviceWorker.register('/sw.js').catch(() => {
      /* ignore registration failures */
    });
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
    if (!drawerOpen) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setDrawerOpen(false);
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [drawerOpen]);

  return {
    activeView,
    drawerOpen,
    locale,
    navigateToView,
    nickname,
    online,
    setDashboardLocale,
    setDrawerOpen,
    setNickname,
  };
}
