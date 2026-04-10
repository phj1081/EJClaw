export const DEFAULT_WATCH_CI_INTERVAL_SECONDS = 60;
export const MIN_WATCH_CI_INTERVAL_SECONDS = 30;
export const DEFAULT_GITHUB_WATCH_CI_INTERVAL_SECONDS = 15;
export const MIN_GITHUB_WATCH_CI_INTERVAL_SECONDS = 10;
export const MAX_WATCH_CI_INTERVAL_SECONDS = 3600;
export const DEFAULT_WATCH_CI_CONTEXT_MODE = 'isolated';

export interface NormalizeWatchCiIntervalOptions {
  ciProvider?: 'github';
}

export interface BuildCiWatchPromptArgs {
  target: string;
  checkInstructions: string;
}

export function normalizeWatchCiIntervalSeconds(
  seconds?: number,
  options?: NormalizeWatchCiIntervalOptions,
): number {
  const isGitHub = options?.ciProvider === 'github';
  const defaultSeconds = isGitHub
    ? DEFAULT_GITHUB_WATCH_CI_INTERVAL_SECONDS
    : DEFAULT_WATCH_CI_INTERVAL_SECONDS;
  const minSeconds = isGitHub
    ? MIN_GITHUB_WATCH_CI_INTERVAL_SECONDS
    : MIN_WATCH_CI_INTERVAL_SECONDS;

  if (seconds === undefined) {
    return defaultSeconds;
  }

  if (!Number.isInteger(seconds)) {
    throw new Error('poll_interval_seconds must be an integer.');
  }

  if (seconds < minSeconds || seconds > MAX_WATCH_CI_INTERVAL_SECONDS) {
    throw new Error(
      `poll_interval_seconds must be between ${minSeconds} and ${MAX_WATCH_CI_INTERVAL_SECONDS}.`,
    );
  }

  return seconds;
}

export function buildCiWatchPrompt({
  target,
  checkInstructions,
}: BuildCiWatchPromptArgs): string {
  return `
[BACKGROUND CI WATCH]

You are running as an EJClaw background CI watcher.

Watch target:
${target}

Check instructions:
${checkInstructions}

Rules:
- Use the watch target and check instructions in this prompt as the source of truth for what to inspect.
- On each run, check whether the target is still queued, pending, running, in progress, or otherwise non-terminal.
- If it is still not finished, send no visible message and end this run quietly.
- If it reached a terminal state such as success, failure, cancelled, timed out, neutral, skipped, or action required:
  1. Send exactly one concise completion message with \`send_message\`.
  2. Format it as a short multiline summary when possible, not one long paragraph.
  3. Preferred shape:
     - First line: \`CI 완료: <target>\`
     - Second line: \`판정: <one-line conclusion>\`
     - Then 2-4 flat bullet points with only the most important metrics, errors, or comparisons.
     - Optional final line: \`다음: <next action>\` if a concrete follow-up is needed.
  4. Adapt the content to the specific CI. Do not invent fixed fields when they do not fit.
  5. Avoid tables unless they are clearly the shortest readable format.
  6. Keep the message compact and easy for other agents to parse.
  7. Call \`cancel_task\` (no arguments needed) so this watcher stops itself.
- If you hit a transient problem such as a rate limit, network issue, or temporary auth failure, send no visible message and leave the task active for the next retry.
- Prefer no normal final response. Use \`send_message\` for the completion message, and keep any non-user-facing notes inside \`<internal>\` tags if needed.
- Do not claim continued monitoring after you cancel the task.
`.trim();
}
