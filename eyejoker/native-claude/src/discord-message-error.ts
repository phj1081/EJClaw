function discordErrorCode(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const direct = (error as { code?: unknown }).code;
  if (typeof direct === "number") return direct;
  if (typeof direct === "string" && /^\d+$/.test(direct)) return Number(direct);
  const raw = (error as { rawError?: unknown }).rawError;
  if (!raw || typeof raw !== "object") return null;
  const nested = (raw as { code?: unknown }).code;
  if (typeof nested === "number") return nested;
  if (typeof nested === "string" && /^\d+$/.test(nested)) return Number(nested);
  return null;
}

export function isUnknownDiscordMessage(error: unknown): boolean {
  return discordErrorCode(error) === 10_008;
}

export async function resolveExistingDiscordMessage<T>(operation: () => Promise<T>): Promise<T | null> {
  try {
    return await operation();
  } catch (error) {
    if (isUnknownDiscordMessage(error)) return null;
    throw error;
  }
}
