import type { Locale } from './i18n';

const KO_ROLE_LABELS: Record<string, string> = {
  arbiter: '중재자',
  owner: '오너',
  reviewer: '리뷰어',
};

const KO_VERDICT_LABELS: Record<string, string> = {
  blocked: '차단',
  continue: '계속',
  done: '완료',
  done_with_concerns: '우려 있음',
  needs_context: '컨텍스트 필요',
  proceed: '진행',
  reset: '초기화',
  revise: '수정 필요',
  step_done: '단계 완료',
  task_done: '작업 완료',
};

export function displayRole(
  value: string | null | undefined,
  locale: Locale,
): string {
  const raw = value ?? '';
  if (locale !== 'ko') return raw;
  return KO_ROLE_LABELS[raw.trim().toLowerCase()] ?? raw;
}

export function displayVerdict(value: string, locale: Locale): string {
  if (locale !== 'ko') return value;
  return KO_VERDICT_LABELS[value.trim().toLowerCase()] ?? value;
}
