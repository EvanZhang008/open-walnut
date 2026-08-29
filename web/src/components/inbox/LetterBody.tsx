/**
 * A letter's document body — the two formats an agent may write.
 *
 * HTML rides in a sandboxed iframe (email-client posture): no scripts, no
 * same-origin, so agent-written HTML can be opened blind on a phone. The ONLY
 * capability granted is popups, because without it a link in the body would be
 * a dead click — and with no scripts allowed there is no way to intercept the
 * click and route it ourselves. `<base target="_blank">` is what turns every
 * link in the document into a new-tab open. The frame document and its CSP live
 * in letter-html-frame.ts.
 *
 * Markdown goes through the SAME renderer the rest of the console uses
 * (renderMarkdownWithRefs), so task/session refs become pills and file paths
 * linkify exactly like they do in chat; the caller supplies the click handler.
 */
import { useMemo } from 'react';
import { renderMarkdownWithRefs } from '@/utils/markdown';
import { useEntityLabelsVersion } from '@/hooks/useEntityLabels';
import type { LetterBodyFormat } from '@/api/human-inbox';
import { LETTER_IFRAME_SANDBOX, wrapLetterHtml } from './letter-html-frame';

export { LETTER_IFRAME_SANDBOX, wrapLetterHtml };

export function LetterBody({ body, format, subject, onClick }: {
  body: string;
  format: LetterBodyFormat;
  subject: string;
  /** Delegated markdown link clicks (task pills, file paths). HTML: unused. */
  onClick?: (e: React.MouseEvent) => void;
}) {
  const labelsVersion = useEntityLabelsVersion();
  const html = useMemo(
    () => (format === 'html' ? wrapLetterHtml(body) : renderMarkdownWithRefs(body)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- labelsVersion invalidates ref lookups inside
    [body, format, labelsVersion],
  );

  if (format === 'html') {
    return (
      <iframe
        className="hib-html-frame"
        sandbox={LETTER_IFRAME_SANDBOX}
        referrerPolicy="no-referrer"
        srcDoc={html}
        title={subject || 'Letter'}
      />
    );
  }
  return (
    <div
      className="hib-md-body markdown-body"
      onClick={onClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
