/**
 * Provenance card for a session→session SEND — the mirror of
 * SessionProvenanceCard.
 *
 * The receiving session has always shown "Message from another session" with the
 * peer named and its words quoted. The SENDING session showed a generic tool row:
 * `mcp__walnut__session_send` with a JSON dump, or a Bash block whose command is a
 * single-quoted payload. Two halves of one conversation, rendered in two
 * languages, and the outgoing half was the unreadable one.
 *
 * So this card is deliberately the SAME visual language (same `provenance-*`
 * classes, same chip/disclosure idioms) with the direction flipped: who I told,
 * which task that session owns, what I said, and every machine line (the command
 * itself, the server's answer) folded into one disclosure.
 *
 * Two things it does NOT do, both inherited from the inbound card on purpose:
 *  · It never invents a link. A chip appears only when the server named the target
 *    session outright, or when a printed short id resolves to exactly ONE live
 *    session (the same unique-prefix rule `session_send` itself applies).
 *  · It never re-parses the body. The body is the text this session sent, rendered
 *    as markdown and nothing more.
 *
 * Clicks: the card is rendered from GenericToolCall, which sits inside
 * `.session-msg-content` for an in-message tool and OUTSIDE it for a merged
 * cross-message tool run — so the card carries its own `useEntityClickHandler`
 * rather than relying on a delegating ancestor that is only sometimes there, and
 * stops propagation on a chip hit so the two paths can never both fire.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  outboundDirectionGlyph,
  outboundDirectionLabel,
  splitOutboundHandle,
  type OutboundSend,
} from './session-outbound';
import { resolveRefInIndex } from '@/components/chat/session-mention';
import {
  ensureSessionMentionIndex,
  getSessionMentionIndex,
  subscribeSessionMentionIndex,
} from '@/stores/session-mention-index';
import { sessionStatusStore } from '@/stores/session-status-store';
import { useEntityClickHandler } from '@/hooks/useEntityClickHandler';
import { useRenderedMarkdown, useTaskLabel } from '@/hooks/useEntityLabels';
import { copyTextRobust } from '@/utils/clipboard';

interface ResolvedTarget {
  /** Full session id — present only when it is unambiguous. */
  fullId?: string;
  /** Short id to print on the chip. */
  shortId?: string;
  /** Live title when the index knows the session, else what the server printed. */
  title?: string;
  host?: string;
  taskId?: string;
  /** A printed short id matched more than one session: text, never a link. */
  ambiguous: boolean;
}

/** '__local__' is the wire value; a card prints 'local'. */
function hostLabel(host: string | undefined): string | undefined {
  if (!host) return undefined;
  return host === '__local__' ? 'local' : host;
}

/**
 * Resolve the send's target against the in-browser session index.
 *
 * Best source first: the id the SERVER resolved (authoritative — it is the session
 * the message actually reached), then the short id inside the printed handle, then
 * the raw `to` the model typed, which only earns a link when it happens to be a
 * unique session-id prefix (it may equally be a task id or a title substring).
 */
function useResolvedTarget(send: OutboundSend): ResolvedTarget {
  const candidates = useSyncExternalStore(
    subscribeSessionMentionIndex,
    getSessionMentionIndex,
    getSessionMentionIndex,
  );
  useEffect(() => { void ensureSessionMentionIndex(); }, []);

  const resolved = useMemo<ResolvedTarget>(() => {
    const target = send.target ?? {};
    const handle = splitOutboundHandle(target.handle);
    const printedTitle = handle.title ?? target.title;
    if (target.sessionId) {
      const exact = candidates.find((c) => c.id === target.sessionId);
      return {
        fullId: target.sessionId,
        shortId: target.sessionId.slice(0, 8),
        title: exact?.title || printedTitle,
        host: hostLabel(exact?.host),
        ...(target.taskId || exact?.taskId ? { taskId: target.taskId || exact?.taskId } : {}),
        ambiguous: false,
      };
    }
    const ref = handle.shortId ?? send.to;
    if (!ref) return { title: printedTitle, ambiguous: false };
    const hit = resolveRefInIndex(ref, candidates);
    if (hit) {
      return {
        fullId: hit.id,
        shortId: ref,
        title: hit.title || printedTitle,
        host: hostLabel(hit.host),
        ...(target.taskId || hit.taskId ? { taskId: target.taskId || hit.taskId } : {}),
        ambiguous: false,
      };
    }
    const matches = candidates.filter((c) => c.id.startsWith(ref)).length;
    return {
      // Only a PRINTED short id is shown as a dim chip: `to` may be a title or a
      // task, and printing that as an id would be a lie about what it is.
      ...(handle.shortId ? { shortId: handle.shortId } : {}),
      title: printedTitle,
      ...(target.taskId ? { taskId: target.taskId } : {}),
      ambiguous: matches > 1,
    };
  }, [candidates, send]);

  // The WS-fed status store is fresher than the index after a task move.
  const taskId = resolved.taskId
    ?? (resolved.fullId ? sessionStatusStore.getStatus(resolved.fullId)?.taskId ?? undefined : undefined);
  return taskId ? { ...resolved, taskId } : resolved;
}

function CopyChip({ value, label, title }: { value: string; label: string; title: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1_200);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      type="button"
      className="provenance-chip provenance-chip-copy"
      title={title}
      onClick={(e) => { e.stopPropagation(); void copyTextRobust(value); setCopied(true); }}
    >{copied ? 'copied' : label}</button>
  );
}

/** The target session: a clickable chip when resolved, plain text when not. */
function TargetChips({ resolved }: { resolved: ResolvedTarget }) {
  const taskLabel = useTaskLabel(resolved.taskId);
  return (
    <div className="provenance-chips">
      {resolved.fullId && resolved.shortId ? (
        <a
          className="provenance-chip provenance-chip-session session-link"
          data-session-id={resolved.fullId}
          href={`/sessions?id=${resolved.fullId}`}
          title={`Open session ${resolved.fullId}`}
        >{`@${resolved.shortId}`}</a>
      ) : resolved.shortId ? (
        <span
          className="provenance-chip provenance-chip-dim"
          title={resolved.ambiguous
            ? `${resolved.shortId} matches more than one session — no unique target to open`
            : `${resolved.shortId} is not in the current session list`}
        >{`@${resolved.shortId}`}</span>
      ) : null}
      {resolved.taskId && (
        <a
          className="provenance-chip provenance-chip-task task-link"
          data-task-id={resolved.taskId}
          href={`/tasks/${resolved.taskId}`}
          title={taskLabel?.project ? `${taskLabel.project} / ${taskLabel.title}` : resolved.taskId}
        >{taskLabel?.title ?? `task ${resolved.taskId.slice(0, 8)}`}</a>
      )}
      {resolved.host && <span className="provenance-host">{resolved.host}</span>}
      {resolved.fullId && (
        <CopyChip value={resolved.fullId} label="copy id" title={resolved.fullId} />
      )}
    </div>
  );
}

/** What this session said. Same quoted block the inbound card gives the peer. */
function OutboundBody({ body, sessionCwd }: { body: string; sessionCwd?: string }) {
  const html = useRenderedMarkdown(body, sessionCwd);
  return (
    <blockquote className="provenance-body markdown-body" dangerouslySetInnerHTML={{ __html: html }} />
  );
}

/** The command and the server's answer: present, never dominant. */
function OutboundDetails({ send, result }: { send: OutboundSend; result?: string }) {
  return (
    <details className="provenance-details">
      <summary>{send.via === 'cli' ? 'Command & response' : 'Call & response'}</summary>
      <pre className="provenance-raw">{send.raw}</pre>
      {result !== undefined && result !== '' && (
        <>
          <div className="provenance-outbound-raw-label">Response</div>
          <pre className="provenance-raw">{result}</pre>
        </>
      )}
    </details>
  );
}

/** Where the payload lived when the transcript does not hold it. */
function payloadNote(send: OutboundSend): string | null {
  if (send.body !== undefined) return null;
  if (send.payloadFrom === 'file') return 'Payload from file — the text is not in this transcript.';
  if (send.payloadFrom === 'stdin') return 'Payload from stdin — the text is not in this transcript.';
  return null;
}

export function SessionOutboundCard({
  send, result, sessionCwd, sessionHost, sessionId, onTaskClick, onSessionClick,
}: {
  send: OutboundSend;
  /** Raw tool output — the disclosure's second half. */
  result?: string;
  sessionCwd?: string;
  sessionHost?: string;
  sessionId?: string;
  onTaskClick?: (taskId: string) => void;
  onSessionClick?: (sessionId: string) => void;
}) {
  const resolved = useResolvedTarget(send);
  const handleClick = useEntityClickHandler(onTaskClick, onSessionClick, undefined, sessionHost, sessionId);

  const headline = resolved.title
    || send.to
    || (resolved.shortId ? `Session ${resolved.shortId}` : 'Unknown session');
  const note = payloadNote(send);
  const status = send.error
    ? send.error
    : send.delivery === 'queued' ? 'Delivered to the session’s queue'
      : send.delivery === 'deferred' ? 'Held: the target is waiting on a permission prompt'
        : send.delivery;

  return (
    <div
      className="provenance-card"
      data-envelope-kind="outbound"
      data-outbound-via={send.via}
      {...(send.error ? { 'data-outbound-error': 'true' } : {})}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('a.session-link, a.task-link')) e.stopPropagation();
        handleClick(e);
      }}
    >
      <div className="provenance-head">
        <span className="provenance-glyph">{outboundDirectionGlyph(send.kind)}</span>
        <span className="provenance-label">{outboundDirectionLabel(send.kind)}</span>
        {(send.requestId || send.repliedTo) && (
          <span className="provenance-rq">{send.repliedTo ?? send.requestId}</span>
        )}
      </div>
      <div className="provenance-title" title={headline}>{headline}</div>
      <TargetChips resolved={resolved} />
      {status && <div className="provenance-status">{status}</div>}
      {send.body !== undefined && <OutboundBody body={send.body} sessionCwd={sessionCwd} />}
      {note && <div className="provenance-outbound-payload">{note}</div>}
      <OutboundDetails send={send} result={result} />
    </div>
  );
}
