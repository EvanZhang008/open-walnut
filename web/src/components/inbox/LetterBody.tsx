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
import { useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { AGENT_REF_CHANNEL, claimAgentRef, openAgentRef, parseAgentRef, registerAgentRef, type AgentRef } from '@/utils/agent-ref-open';
import { renderMarkdownWithRefs } from '@/utils/markdown';
import { linkAgentHtml } from '../../../../src/lib/agent-html-refs';
import { secureAgentHtml } from '../../../../src/lib/agent-html-security';
import { useEntityLabelsVersion } from '@/hooks/useEntityLabels';
import { randomId } from '@/utils/random-id';
import { useAgentFileOpener } from '@/hooks/useAgentFileOpener';
import type { AgentTextSource } from '@/utils/agent-text-source';
import type { LetterBodyFormat } from '@/api/human-inbox';
import { LETTER_IFRAME_SANDBOX, planLetterFrame, wrapLetterHtml } from './letter-html-frame';

export { LETTER_IFRAME_SANDBOX, wrapLetterHtml };

export function LetterBody({ body, format, subject, onClick, bodyUrl, onRefOpen, source }: {
  body: string;
  format: LetterBodyFormat;
  subject: string;
  /** Delegated markdown link clicks. */
  onClick?: (e: React.MouseEvent) => void;
  /**
   * Set when the server DEFERRED the document (over LETTER_INLINE_BODY_MAX_BYTES,
   * so `body` is empty). The iframe points at it with `?frame=1`, which serves the
   * body already wrapped in this same frame — streamed, never held whole in JS.
   * A 100MB digest is exactly why: putting it in `srcDoc` would mean the string,
   * the JSON it arrived in, and the document all resident at once.
   */
  bodyUrl?: string;
  onRefOpen?: (ref: AgentRef) => void;
  source?: AgentTextSource;
}) {
  const labelsVersion = useEntityLabelsVersion();
  const navigate = useNavigate();
  const file = useAgentFileOpener(source);
  const { cwd, host, images } = file.render;
  const token = useMemo(() => randomId().replace(/-/g, ''), [body, bodyUrl, format]);
  useEffect(() => {
    const unregister = registerAgentRef(token, (ref) => {
      if (onRefOpen) onRefOpen(ref);
      else if (ref.kind === 'file' && file.onFileOpen) file.onFileOpen(ref.path, ref.line, undefined, ref.endLine);
      else openAgentRef(ref, navigate);
    });
    if (typeof BroadcastChannel === 'undefined') return unregister;
    const channel = new BroadcastChannel(AGENT_REF_CHANNEL);
    channel.onmessage = (event) => {
      const { ask, href } = event.data ?? {};
      if (typeof ask !== 'string' || typeof href !== 'string' || parseAgentRef(href)?.token !== token) return;
      if (claimAgentRef(href)) channel.postMessage({ answer: ask });
    };
    return () => { unregister(); channel.close(); };
  }, [token, navigate, onRefOpen, file.onFileOpen]);
  const deferredSrc = useMemo(() => {
    if (!bodyUrl) return undefined;
    return bodyUrl + (bodyUrl.includes('?') ? '&' : '?') + `frame=1&ref_token=${token}`;
  }, [bodyUrl, token]);
  const html = useMemo(
    () => {
      if (deferredSrc) return '';
      if (format !== 'html') return renderMarkdownWithRefs(body, cwd, host, { inlineImages: images });
      const plan = planLetterFrame(body);
      const linked = linkAgentHtml(plan.head + body.slice(plan.consumed) + plan.tail, { token, refBase: `${window.location.origin}/open-ref`, scriptingEnabled: false });
      return secureAgentHtml(linked, { scriptingEnabled: false, trustedPrefix: plan.head });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- labelsVersion invalidates ref lookups inside
    [body, format, labelsVersion, deferredSrc, token, cwd, host, images],
  );
  // One object per html string: React 19 re-sets innerHTML whenever this prop's
  // OBJECT changes, so a fresh `{ __html }` on every render rebuilt the body each
  // time the letter refreshed, and every image in it reloaded from zero height,
  // pushing the thread the reader was in (2026-10-25).
  const inner = useMemo(() => ({ __html: html }), [html]);

  if (deferredSrc) {
    return (
      <iframe
        className="hib-html-frame"
        sandbox={LETTER_IFRAME_SANDBOX}
        referrerPolicy="no-referrer"
        src={deferredSrc}
        title={subject || 'Letter'}
      />
    );
  }

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
      dangerouslySetInnerHTML={inner}
    />
  );
}
