import { useMemo, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const SECRET_ASSIGNMENT_RE =
  /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|AUTH|PRIVATE_KEY)[A-Z0-9_]*)\s*=\s*([^\s"'`]+)/gi;
const SECRET_VALUE_RE =
  /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,})\b/g;

export function ParsedBody({
  text,
  truncate,
}: {
  text: string | null | undefined;
  truncate?: number;
}): ReactNode {
  const cleaned = useMemo(() => {
    if (!text) return '';
    let out = text
      .replace(SECRET_ASSIGNMENT_RE, (_m, key) => `${key}=***`)
      .replace(SECRET_VALUE_RE, '***');
    if (truncate && out.length > truncate) {
      out = out.slice(0, truncate) + '…';
    }
    return out;
  }, [text, truncate]);

  if (!cleaned.trim()) {
    return <span className="parsed-empty">—</span>;
  }

  return (
    <div className="parsed-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{cleaned}</ReactMarkdown>
    </div>
  );
}
