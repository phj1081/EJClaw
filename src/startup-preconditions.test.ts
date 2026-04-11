import { describe, expect, it } from 'vitest';

import {
  STARTUP_PRECONDITION_EXIT_CODE,
  StartupPreconditionError,
  isStartupPreconditionError,
  resolveStartupFailureExitCode,
} from './startup-preconditions.js';

describe('startup preconditions', () => {
  it('maps startup precondition errors to the non-restart exit code', () => {
    const error = new StartupPreconditionError('legacy migration required');

    expect(isStartupPreconditionError(error)).toBe(true);
    expect(resolveStartupFailureExitCode(error)).toBe(
      STARTUP_PRECONDITION_EXIT_CODE,
    );
  });

  it('keeps generic startup failures on exit code 1', () => {
    expect(resolveStartupFailureExitCode(new Error('boom'))).toBe(1);
  });
});
