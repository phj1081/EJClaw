import type { DashboardOverview, StatusSnapshot } from './api';
import { formatDate } from './dashboardHelpers';
import { EmptyState } from './EmptyState';
import type { Locale, Messages } from './i18n';

export type ServiceActionKey = 'stack:restart';

type HealthLevel = 'ok' | 'stale' | 'down';
type ServiceRow = DashboardOverview['services'][number];

export interface ServicePanelProps {
  formatDuration: (value: number | null, t: Messages) => string;
  locale: Locale;
  onRestartStack: () => void;
  overview: DashboardOverview;
  serviceActionKey: ServiceActionKey | null;
  snapshots: StatusSnapshot[];
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
): HealthLevel {
  const age = serviceAgeMs(service, generatedAt);
  if (age === null) return 'stale';
  if (age >= HEALTH_DOWN_MS) return 'down';
  if (age >= HEALTH_STALE_MS) return 'stale';
  return 'ok';
}

export function ServicePanel({
  formatDuration,
  locale,
  onRestartStack,
  overview,
  serviceActionKey,
  snapshots,
  t,
}: ServicePanelProps) {
  const services = overview.services;
  const restarts = overview.operations?.serviceRestarts ?? [];
  const serviceLevels = services.map((service) => ({
    service,
    level: serviceHealthLevel(service, overview.generatedAt),
    age: serviceAgeMs(service, overview.generatedAt),
  }));
  const down = serviceLevels.filter((item) => item.level === 'down').length;
  const stale = serviceLevels.filter((item) => item.level === 'stale').length;
  const queue = snapshots.reduce(
    (acc, snapshot) => {
      for (const entry of snapshot.entries) {
        acc.pendingTasks += entry.pendingTasks;
        if (entry.pendingMessages) acc.pendingMessageRooms += 1;
      }
      return acc;
    },
    { pendingTasks: 0, pendingMessageRooms: 0 },
  );
  const ciFailures = overview.inbox.reduce(
    (count, item) =>
      item.kind === 'ci-failure' ? count + item.occurrences : count,
    0,
  );
  const healthLevel: HealthLevel =
    down > 0 ? 'down' : stale > 0 || ciFailures > 0 ? 'stale' : 'ok';
  const affectedServices = serviceLevels.filter((item) => item.level !== 'ok');

  return (
    <div className="health-board">
      <section className={`health-overview health-${healthLevel}`}>
        <span className="eyebrow">{t.health.system}</span>
        <strong>{t.health.levels[healthLevel]}</strong>
      </section>

      <section className="health-signals" aria-label={t.health.signals}>
        <div>
          <span>{t.health.services}</span>
          <strong>
            {services.length - stale - down}/{services.length}
          </strong>
          <small>{t.health.fresh}</small>
        </div>
        <div>
          <span>{t.health.stale}</span>
          <strong>{stale + down}</strong>
          <small>
            {down} {t.health.levels.down}
          </small>
        </div>
        <div>
          <span>{t.health.queue}</span>
          <strong>{queue.pendingTasks}</strong>
          <small>
            {queue.pendingMessageRooms} {t.control.pendingRooms}
          </small>
        </div>
        <div>
          <span>{t.health.ciFailures}</span>
          <strong>{ciFailures}</strong>
        </div>
      </section>

      <section className="health-actions" aria-label={t.health.restart}>
        <div>
          <span className="eyebrow">{t.health.restart}</span>
          <strong>{t.health.restartStack}</strong>
          <small>{t.health.restartHint}</small>
        </div>
        <button
          disabled={serviceActionKey === 'stack:restart'}
          onClick={onRestartStack}
          type="button"
        >
          {serviceActionKey === 'stack:restart'
            ? t.health.restarting
            : t.health.restartStack}
        </button>
      </section>

      {restarts.length > 0 ? (
        <details className="health-restart-log">
          <summary>
            {t.health.restartLog}
            <strong>{restarts.length}</strong>
          </summary>
          <div className="health-restart-list">
            {restarts.map((restart) => {
              const pill =
                restart.status === 'success'
                  ? 'ok'
                  : restart.status === 'failed'
                    ? 'error'
                    : 'stale';
              return (
                <article className="health-restart-record" key={restart.id}>
                  <div>
                    <small>{t.health.restartTarget}</small>
                    <strong>{restart.target}</strong>
                  </div>
                  <span
                    aria-label={`${t.health.restartStatus}: ${restart.status}`}
                    className={`pill pill-${pill}`}
                  >
                    {restart.status}
                  </span>
                  <div>
                    <small>{t.health.restartRequested}</small>
                    <strong>{formatDate(restart.requestedAt, locale)}</strong>
                  </div>
                  <div>
                    <small>{t.health.restartServices}</small>
                    <strong>
                      {restart.services.length > 0
                        ? restart.services.join(', ')
                        : '-'}
                    </strong>
                  </div>
                  {restart.error ? (
                    <p className="health-restart-error">{restart.error}</p>
                  ) : null}
                </article>
              );
            })}
          </div>
        </details>
      ) : null}

      {services.length === 0 ? (
        <EmptyState>{t.service.empty}</EmptyState>
      ) : affectedServices.length === 0 ? null : (
        <details className="health-service-details">
          <summary>
            {t.health.affectedServices}
            <strong>{affectedServices.length}</strong>
          </summary>
          <div className="health-service-list">
            {affectedServices.map(({ service, level, age }) => (
              <article className="health-service" key={service.serviceId}>
                <div>
                  <strong>{service.assistantName || service.serviceId}</strong>
                </div>
                <span className={`pill pill-${level}`}>
                  {t.health.levels[level]}
                </span>
                <div>
                  <small>{t.service.updated}</small>
                  <strong>{formatDate(service.updatedAt, locale)}</strong>
                  <em>{formatDuration(age, t)}</em>
                </div>
                <div>
                  <small>{t.service.rooms}</small>
                  <strong>
                    {service.activeRooms}/{service.totalRooms}
                  </strong>
                </div>
              </article>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
