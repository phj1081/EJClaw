import type { DashboardOverview } from './api';
import type { Messages } from './i18n';

type HealthLevel = 'stale' | 'down';
type ServiceRow = DashboardOverview['services'][number];

export interface SystemStatusStripProps {
  overview: DashboardOverview;
  t: Messages;
}

const HEALTH_STALE_MS = 5 * 60_000;
const HEALTH_DOWN_MS = 15 * 60_000;

function serviceAgeMs(service: ServiceRow, generatedAt: string): number | null {
  const updated = new Date(service.updatedAt).getTime();
  const now = new Date(generatedAt).getTime();
  if (Number.isNaN(updated) || Number.isNaN(now)) return null;
  return Math.max(0, now - updated);
}

function serviceHealthLevel(
  service: ServiceRow,
  generatedAt: string,
): HealthLevel | null {
  const age = serviceAgeMs(service, generatedAt);
  if (age === null) return 'stale';
  if (age >= HEALTH_DOWN_MS) return 'down';
  if (age >= HEALTH_STALE_MS) return 'stale';
  return null;
}

export function SystemStatusStrip({ overview, t }: SystemStatusStripProps) {
  const serviceLevels = overview.services.map((service) =>
    serviceHealthLevel(service, overview.generatedAt),
  );
  const down = serviceLevels.filter((level) => level === 'down').length;
  const stale = serviceLevels.filter((level) => level === 'stale').length;
  const ciPaused = overview.tasks.watchers.paused;
  const hasNoHeartbeat = overview.services.length === 0;
  const level: HealthLevel = hasNoHeartbeat || down > 0 ? 'down' : 'stale';

  if (!hasNoHeartbeat && down === 0 && stale === 0 && ciPaused === 0) {
    return null;
  }

  const signals: string[] = [];
  if (hasNoHeartbeat) signals.push(t.service.empty);
  if (down > 0) signals.push(`${down} ${t.health.levels.down}`);
  if (stale > 0) signals.push(`${stale} ${t.health.stale}`);
  if (ciPaused > 0) signals.push(`${ciPaused} ${t.health.ciFailures}`);

  return (
    <aside
      aria-label={t.health.signals}
      className={`system-status-strip system-status-${level}`}
      role="status"
    >
      <div>
        <span className="eyebrow">{t.health.system}</span>
        <strong>{t.health.levels[level]}</strong>
      </div>
      <p>{signals.join(' · ')}</p>
    </aside>
  );
}
