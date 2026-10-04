/**
 * Provenance card for Walnut-authored session envelopes.
 *
 * A session→session message arrives in the receiving CLI's stdin wrapped in a
 * machine-readable envelope (see session-envelope.ts). Rendered as prose it was
 * a wall of blue bubble in which the ONE thing a human needs — which session /
 * task is this about — was an 8-char hex fragment buried mid-sentence, and the
 * machine framing (fence markers, the "carries no user authorization" warning,
 * the follow-up command) dominated the actual words.
 *
 * This card inverts that: who + which task in the header, the other session's
 * words as the body, and every machine line folded into one disclosure.
 *
 * It cards both the current `<walnut-message …>` tag and the pre-v2 prose shapes,
 * plus Claude Code's own `<cross-session-message …>`; the parser normalizes all
 * of them, so this file only ever reads a SessionEnvelope.
 *
 * Two things it deliberately does NOT do:
 *  · It never re-parses the body looking for structure. The body is the other
 *    session's untrusted text; the header comes only from attributes/framing
 *    outside it (that is the injection defence — see session-envelope.ts).
 *  · It never invents a link. The 8-char short id becomes a clickable chip only
 *    when it resolves to exactly ONE live session (the same unique-prefix rule
 *    the server's session_send uses); otherwise it stays plain text.
 *
 * Clicks ride the existing `.session-link` / `.task-link` delegation on
 * `.session-msg-content` (useEntityClickHandler), so the chips open the Home
 * session column / focus the task through exactly the same path as chat pills.
 *
 * Every card starts FOLDED to one line of who and one line of what: the sender's
 * own TL;DR (`title`), a notice's outcome sentence, or the first sentence of the
 * words (message-fold.ts). A click opens the rest; a slim reply-request row has
 * nothing to fold.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  envelopeDirectionGlyph,
  envelopeDirectionLabel,
  type EnvelopeSegment,
  type NoticeQuoteSection,
  type SessionEnvelope,
  type SessionEnvelopePeer,
  type SessionEnvelopeSource,
} from './session-envelope';
import { resolveRefInIndex } from '@/components/chat/session-mention';
import {
  ensureSessionMentionIndex,
  getSessionMentionIndex,
  subscribeSessionMentionIndex,
} from '@/stores/session-mention-index';
import { sessionStatusStore } from '@/stores/session-status-store';
import { useRenderedMarkdown, useTaskLabel } from '@/hooks/useEntityLabels';
import { copyTextRobust } from '@/utils/clipboard';
import { log } from '@/utils/log';
import { fallbackTitle, foldKey, noticeText, noticeTitle, useMessageFold } from './message-fold';
import { MessageFoldSummary } from './MessageFoldSummary';
import '@/styles/provenance-quote.css';
import '@/styles/provenance-fold.css';

/** '__local__' is the wire value; the envelope prints 'local'. */
function hostLabel(host: string | undefined): string | undefined {
  if (!host) return undefined;
  return host === '__local__' ? 'local' : host;
}

interface ResolvedPeer {
  /** Full session id — present only when resolution was unambiguous. */
  fullId?: string;
  /** Live title when resolved (never truncated), else the envelope's printed one. */
  title?: string;
  host?: string;
  taskId?: string;
  /** The short id matched more than one session: show text, never a link. */
  ambiguous: boolean;
}

/**
 * Resolve the envelope's peer against the in-browser session index — the same
 * unique-id-prefix rule the server applies, so a chip can never point at a
 * different session than a `session_send` with that same short id would reach.
 */
function useResolvedPeer(peer: SessionEnvelopePeer, source?: SessionEnvelopeSource): ResolvedPeer {
  const candidates = useSyncExternalStore(
    subscribeSessionMentionIndex,
    getSessionMentionIndex,
    getSessionMentionIndex,
  );
  useEffect(() => { void ensureSessionMentionIndex(); }, []);

  const resolved = useMemo<ResolvedPeer>(() => {
    if (peer.anonymous) return { host: peer.host, ambiguous: false };
    // A Walnut envelope prints the target's FULL id — no prefix guessing.
    const exact = peer.sessionId
      ? candidates.find((c) => c.id === peer.sessionId)
      : undefined;
    // Claude Code's `from-session` names a CLI session Walnut may not track at
    // all, so it earns a link only by being IN the live index; a Walnut envelope's
    // own id is authoritative even when the index has not caught up yet.
    if (peer.sessionId && (exact || source !== 'claude-code')) {
      return {
        fullId: peer.sessionId,
        title: exact?.title || peer.title,
        host: hostLabel(exact?.host) ?? peer.host,
        ...(exact?.taskId ? { taskId: exact.taskId } : {}),
        ambiguous: false,
      };
    }
    if (!peer.shortId) return { title: peer.title, host: peer.host, ambiguous: false };
    const hit = resolveRefInIndex(peer.shortId, candidates);
    if (hit) {
      return {
        fullId: hit.id,
        title: hit.title || peer.title,
        host: hostLabel(hit.host) ?? peer.host,
        ...(hit.taskId ? { taskId: hit.taskId } : {}),
        ambiguous: false,
      };
    }
    const matches = candidates.filter((c) => c.id.startsWith(peer.shortId!)).length;
    return { title: peer.title, host: peer.host, ambiguous: matches > 1 };
  }, [candidates, peer, source]);

  // Task id, best source first: the envelope printed one (notification shape) →
  // the session index → the WS-fed status store (fresher after a task move).
  const taskId = peer.taskId
    ?? resolved.taskId
    ?? (resolved.fullId ? sessionStatusStore.getStatus(resolved.fullId)?.taskId ?? undefined : undefined);

  // One line per short id that stays unresolvable, not one per index refresh:
  // a chat can hold dozens of these cards and this is diagnostics, not an event.
  const loggedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!peer.shortId || resolved.fullId || loggedRef.current === peer.shortId) return;
    loggedRef.current = peer.shortId;
    log.info('session-envelope', 'peer short id did not resolve to one session', {
      shortId: peer.shortId, ambiguous: resolved.ambiguous, indexSize: candidates.length,
    });
  }, [peer.shortId, resolved.fullId, resolved.ambiguous, candidates.length]);

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

/**
 * Where the other side lives, by name: its task (a click opens that task's
 * session), else its session by title. An id means nothing to a reader, so
 * none shows here; the ids live in the details.
 */
function PeerChips({ resolved }: { resolved: ResolvedPeer }) {
  const taskLabel = useTaskLabel(resolved.taskId);
  const chip = resolved.taskId ? (
    <a
      className="provenance-chip provenance-chip-task task-link"
      data-task-id={resolved.taskId}
      href={`/tasks/${resolved.taskId}`}
      title={taskLabel?.project ? `${taskLabel.project} / ${taskLabel.title}` : taskLabel?.title}
    >{taskLabel?.title ?? 'Open task'}</a>
  ) : resolved.fullId ? (
    <a
      className="provenance-chip provenance-chip-session session-link"
      data-session-id={resolved.fullId}
      href={`/sessions?id=${resolved.fullId}`}
      title={resolved.title ? `Open ${resolved.title}` : 'Open the session'}
    >{resolved.title || 'Open session'}</a>
  ) : null;
  if (!chip && !resolved.host) return null;
  return (
    <div className="provenance-chips">
      {chip}
      {resolved.host && <span className="provenance-host">{resolved.host}</span>}
    </div>
  );
}

/** "Reply from", "From", … — the word before the sender on the folded line. */
function foldDirection(envelope: SessionEnvelope): string {
  if (envelope.peer.anonymous) return 'From';
  switch (envelope.kind) {
    case 'reply': return 'Reply from';
    case 'notification': return 'Walnut, about';
    case 'trigger': return 'Trigger';
    default: return envelope.source === 'claude-code' ? 'Claude Code session' : 'From';
  }
}

/**
 * The folded title, best source first; never empty when the card has words. A
 * notice's outcome runs to several sentences (measured on real notices: median
 * 183 characters), so it folds to its first.
 */
function foldTitle(envelope: SessionEnvelope): string | undefined {
  if (envelope.title) return envelope.title;
  if (envelope.kind === 'notification' && envelope.statusLine) return noticeTitle(envelope.statusLine);
  if (envelope.kind === 'trigger' && envelope.statusLine && envelope.statusLine !== 'scheduled') return envelope.statusLine;
  return fallbackTitle(envelope.body) ?? fallbackTitle(envelope.quote?.[0]?.text);
}

/**
 * A block a Walnut notification quoted from the session it is about: its last
 * message (rendered like any other session's words) or the tool calls it made
 * after it (plain lines, never markdown: they are command summaries).
 */
function NoticeQuote({ section, sessionCwd }: { section: NoticeQuoteSection; sessionCwd?: string }) {
  return (
    <div className="provenance-quote" data-quote-kind={section.kind}>
      <div className="provenance-quote-label">
        {section.label}
        {section.clipped && <span className="provenance-quote-note"> (clipped; the rest is in its history)</span>}
      </div>
      {section.kind === 'message'
        ? <EnvelopeBody body={section.text} sessionCwd={sessionCwd} />
        : (
          <ul className="provenance-actions">
            {section.text.split('\n').filter((line) => line.trim()).map((line, i) => (
              <li key={i} title={line}><code>{line}</code></li>
            ))}
          </ul>
        )}
    </div>
  );
}

/** The other session's own words. Quoted, never presented as the user's. */
function EnvelopeBody({ body, sessionCwd }: { body: string; sessionCwd?: string }) {
  const html = useRenderedMarkdown(body, sessionCwd);
  return (
    <blockquote className="provenance-body markdown-body" dangerouslySetInnerHTML={{ __html: html }} />
  );
}

/** Everything the model was told that a human does not need on screen, ids included. */
function EnvelopeDetails({ envelope, sessionId }: { envelope: SessionEnvelope; sessionId?: string }) {
  const requestId = envelope.requestId ?? envelope.replyRequest?.requestId;
  return (
    <details className="provenance-details">
      <summary>Envelope details</summary>
      {(requestId || sessionId) && (
        <div className="provenance-ids">
          {requestId && <span>Request <code className="provenance-rq">{requestId}</code></span>}
          {sessionId && (
            <span>
              Session <code>{sessionId}</code>
              <CopyChip value={sessionId} label="copy" title="Copy the session id" />
            </span>
          )}
        </div>
      )}
      {envelope.followUp && (
        <div className="provenance-followup">
          <code>{envelope.followUp}</code>
          <CopyChip value={envelope.followUp} label="copy" title="Copy the follow-up command" />
        </div>
      )}
      {/* Claude Code's transport address. Diagnostic only: it is not a Walnut id,
          so it never becomes a chip or a link — it lives here or nowhere. */}
      {envelope.source === 'claude-code' && envelope.peer.address && (
        <div className="provenance-address">
          <span className="provenance-address-label">Address</span>
          <code>{envelope.peer.address}</code>
        </div>
      )}
      <pre className="provenance-raw">{envelope.raw}</pre>
    </details>
  );
}

function ProvenanceCard({ envelope, sessionCwd }: { envelope: SessionEnvelope; sessionCwd?: string }) {
  const resolved = useResolvedPeer(envelope.peer, envelope.source);
  const taskLabel = useTaskLabel(resolved.taskId);
  const [open, toggle] = useMessageFold(foldKey(envelope.raw));
  const { kind, peer, source } = envelope;

  // A bare reply-requested trailer names no peer and carries no words — it is a
  // one-line instruction, so it gets a one-line row instead of a card.
  if (kind === 'reply-request') {
    return (
      <div className="provenance-card provenance-card-slim" data-envelope-kind={kind}>
        <span className="provenance-glyph">{envelopeDirectionGlyph(kind)}</span>
        <span className="provenance-label">{envelopeDirectionLabel(kind, source)}</span>
        <EnvelopeDetails envelope={envelope} />
      </div>
    );
  }

  const title = foldTitle(envelope);

  // A trigger comes from a routine, not a session: no peer to resolve, no chips.
  // The fold line names the routine (and says when it was a plain scheduled run),
  // the title is the daemon's "fired <when>, N new items", and the open card is
  // the delivery the model was given.

  if (kind === 'trigger') {
    const name = (peer.title ?? '').replace(/^Trigger:\s*/, '') || 'Routine';
    const scheduled = envelope.statusLine === 'scheduled';
    return (
      <div className="provenance-card" data-envelope-kind={kind} data-folded={open ? 'false' : 'true'}>
        <MessageFoldSummary
          glyph={envelopeDirectionGlyph(kind)}
          direction={scheduled ? 'Routine ran on schedule' : foldDirection(envelope)}
          sender={name}
          title={title}
          open={open}
          onToggle={toggle}
        />
        {open && (
          <>
            {envelope.body !== undefined && <EnvelopeBody body={envelope.body} sessionCwd={sessionCwd} />}
            <EnvelopeDetails envelope={envelope} />
          </>
        )}
      </div>
    );
  }

  // A session is named by its title, never by its id.
  const headline = peer.anonymous
    ? 'Unidentified process (no tracked session)'
    : resolved.title || 'another session';
  // Who sent it, as the reader knows them: the task, then the session's own title.
  const sender = peer.anonymous ? 'an unidentified process' : taskLabel?.title || headline;
  // A notice's outcome IS its folded title; open, it is repeated only when the fold cut it.
  const status = envelope.statusLine && kind === 'notification' ? noticeText(envelope.statusLine) : envelope.statusLine;
  const statusIsTitle = kind === 'notification' && !envelope.title && title === status;

  return (
    <div
      className="provenance-card"
      data-envelope-kind={kind}
      data-folded={open ? 'false' : 'true'}
      aria-label={`${envelopeDirectionLabel(kind, source)}: ${sender}`}
      {...(peer.anonymous ? { 'data-anonymous': 'true' } : {})}
      {...(source ? { 'data-envelope-source': source } : {})}
    >
      <MessageFoldSummary
        glyph={envelopeDirectionGlyph(kind)}
        direction={foldDirection(envelope)}
        sender={sender}
        senderTitle={headline}
        title={title}
        open={open}
        onToggle={toggle}
      />
      {open && (
        <>
          <PeerChips resolved={resolved} />
          {envelope.askedPreview && (
            <div className="provenance-asked">
              <span className="provenance-asked-label">You asked</span>
              <span className="provenance-asked-text">{envelope.askedPreview}</span>
            </div>
          )}
          {status && !statusIsTitle && <div className="provenance-status">{status}</div>}
          {envelope.quote?.map((section, i) => (
            <NoticeQuote key={i} section={section} sessionCwd={sessionCwd} />
          ))}
          {envelope.body !== undefined && <EnvelopeBody body={envelope.body} sessionCwd={sessionCwd} />}
          {envelope.replyRequest && (
            <div className="provenance-reply-request">
              <span className="provenance-reply-request-label">Reply requested</span>
              {envelope.replyRequest.command && (
                <CopyChip
                  value={envelope.replyRequest.command}
                  label="copy reply command"
                  title={envelope.replyRequest.command}
                />
              )}
            </div>
          )}
          <EnvelopeDetails envelope={envelope} sessionId={resolved.fullId} />
        </>
      )}
    </div>
  );
}

/**
 * Render a parsed message: ordinary text stays ordinary (a batched delivery can
 * put a human message and an envelope in one bubble), each envelope becomes a card.
 */
export function SessionEnvelopeSegments({ segments, sessionCwd }: {
  segments: EnvelopeSegment[];
  sessionCwd?: string;
}) {
  return (
    <div className="provenance-segments">
      {segments.map((segment, i) => (segment.kind === 'text'
        ? <PlainSegment key={`t-${i}`} text={segment.text} sessionCwd={sessionCwd} />
        : <ProvenanceCard key={`e-${i}`} envelope={segment.envelope} sessionCwd={sessionCwd} />))}
    </div>
  );
}

function PlainSegment({ text, sessionCwd }: { text: string; sessionCwd?: string }) {
  const html = useRenderedMarkdown(text, sessionCwd);
  return <div className="markdown-body" dangerouslySetInnerHTML={{ __html: html }} />;
}
