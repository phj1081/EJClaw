import { describe, expect, it, vi } from 'vitest';

describe('logger singleton', () => {
  it('reuses the root logger and does not add duplicate process listeners across module reloads', async () => {
    vi.resetModules();

    const beforeUncaught = process.listeners('uncaughtException').length;
    const beforeUnhandled = process.listeners('unhandledRejection').length;
    const beforeExit = process.listeners('exit').length;

    const first = await import('./logger.js');

    const afterFirstUncaught = process.listeners('uncaughtException').length;
    const afterFirstUnhandled = process.listeners('unhandledRejection').length;
    const afterFirstExit = process.listeners('exit').length;

    vi.resetModules();

    const second = await import('./logger.js');

    const afterSecondUncaught = process.listeners('uncaughtException').length;
    const afterSecondUnhandled = process.listeners('unhandledRejection').length;
    const afterSecondExit = process.listeners('exit').length;

    expect(second.logger).toBe(first.logger);
    expect(afterFirstUncaught).toBeGreaterThanOrEqual(beforeUncaught);
    expect(afterFirstUnhandled).toBeGreaterThanOrEqual(beforeUnhandled);
    expect(afterSecondUncaught).toBe(afterFirstUncaught);
    expect(afterSecondUnhandled).toBe(afterFirstUnhandled);
    expect(afterFirstExit).toBeGreaterThanOrEqual(beforeExit);
    expect(afterSecondExit).toBe(afterFirstExit);
  });
});
