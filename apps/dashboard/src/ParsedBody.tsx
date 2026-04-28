import { useMemo, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { redactSecretsForMarkdown } from './redaction';

export function ParsedBody({
  text,
  truncate,
}: {
  text: string | null | undefined;
  truncate?: number;
}): ReactNode {
  const cleaned = useMemo(() => {
    if (!text) return '';
    let out = redactSecretsForMarkdown(text);
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
