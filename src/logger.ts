import pino, { type Logger } from 'pino';

const serviceName = (process.env.ASSISTANT_NAME || 'claude').toLowerCase();
const isTestEnv =
  process.env.VITEST === 'true' || process.env.NODE_ENV === 'test';

type LoggerGlobalState = typeof globalThis & {
  __ejclawLogger?: Logger;
  __ejclawProcessHandlersInstalled?: boolean;
};

const globalState = globalThis as LoggerGlobalState;

function createRootLogger(): Logger {
  const baseOptions = {
    level: process.env.LOG_LEVEL || 'info',
    name: serviceName,
  };

  if (isTestEnv) {
    return pino(baseOptions);
  }

  return pino({
    ...baseOptions,
    transport: { target: 'pino-pretty', options: { colorize: true } },
  });
}

export const logger =
  globalState.__ejclawLogger ??
  (globalState.__ejclawLogger = createRootLogger());

type LogBindings = Record<string, unknown>;

function normalizeBindings(bindings: LogBindings): LogBindings {
  const normalized = Object.fromEntries(
    Object.entries(bindings).filter(([, value]) => value !== undefined),
  );

  if (
    typeof normalized.groupName === 'string' &&
    normalized.group === undefined
  ) {
    normalized.group = normalized.groupName;
  }

  return normalized;
}

export function createScopedLogger(bindings: LogBindings): Logger {
  return logger.child(normalizeBindings(bindings));
}

// Route uncaught errors through pino so they get timestamps in stderr
function handleUncaughtException(err: unknown): void {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
}

function handleUnhandledRejection(reason: unknown): void {
  logger.error({ err: reason }, 'Unhandled rejection');
}

if (!globalState.__ejclawProcessHandlersInstalled) {
  process.on('uncaughtException', handleUncaughtException);
  process.on('unhandledRejection', handleUnhandledRejection);
  globalState.__ejclawProcessHandlersInstalled = true;
}
