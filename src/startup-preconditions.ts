export const STARTUP_PRECONDITION_EXIT_CODE = 78;

export class StartupPreconditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StartupPreconditionError';
  }
}

export function isStartupPreconditionError(
  error: unknown,
): error is StartupPreconditionError {
  return error instanceof StartupPreconditionError;
}

export function resolveStartupFailureExitCode(error: unknown): number {
  return isStartupPreconditionError(error) ? STARTUP_PRECONDITION_EXIT_CODE : 1;
}
