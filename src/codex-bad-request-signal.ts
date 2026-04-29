export const CODEX_BAD_REQUEST_DETAIL_JSON = '{"detail":"Bad Request"}';

export function isCodexBadRequestText(
  text: string | null | undefined,
): boolean {
  return text?.trim() === CODEX_BAD_REQUEST_DETAIL_JSON;
}
