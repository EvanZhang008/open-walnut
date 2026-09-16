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
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  envelopeDirectionGlyph,
  envelopeDirectionLabel,
  type EnvelopeSegment,
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

/** The other session: a clickable chip when resolved, plain text when not. */
function PeerChips({ peer, resolved }: { peer: SessionEnvelopePeer; resolved: ResolvedPeer }) {
  const taskLabel = useTaskLabel(resolved.taskId);
  // Last fallback: an id the envelope printed but the index could not confirm
  // still names the sender, so it shows as a dim chip rather than disappearing.
  const shortId = peer.shortId ?? resolved.fullId?.slice(0, 8) ?? peer.sessionId?.slice(0, 8);
  return (
    <div className="provenance-chips">
      {resolved.fullId && shortId ? (
        <a
          className="provenance-chip provenance-chip-session session-link"
          data-session-id={resolved.fullId}
          href={`/sessions?id=${resolved.fullId}`}
          title={`Open session ${resolved.fullId}`}
        >{`@${shortId}`}</a>
      ) : shortId ? (
        <span
          className="provenance-chip provenance-chip-dim"
          title={resolved.ambiguous
            ? `${shortId} matches more than one session — no unique target to open`
            : `${shortId} is not in the current session list`}
        >{`@${shortId}`}</span>
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

/** The other session's own words. Quoted, never presented as the user's. */
function EnvelopeBody({ body, sessionCwd }: { body: string; sessionCwd?: string }) {
  const html = useRenderedMarkdown(body, sessionCwd);
  return (
    <blockquote className="provenance-body markdown-body" dangerouslySetInnerHTML={{ __html: html }} />
  );
}

/** Everything the model was told that a human does not need on screen. */
function EnvelopeDetails({ envelope }: { envelope: SessionEnvelope }) {
  return (
    <details className="provenance-details">
      <summary>Envelope details</summary>
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
  const { kind, peer, source } = envelope;

  // A bare reply-requested trailer names no peer and carries no words — it is a
  // one-line instruction, so it gets a one-line row instead of a card.
  if (kind === 'reply-request') {
    return (
      <div className="provenance-card provenance-card-slim" data-envelope-kind={kind}>
        <span className="provenance-glyph">{envelopeDirectionGlyph(kind)}</span>
        <span className="provenance-label">{envelopeDirectionLabel(kind, source)}</span>
        {envelope.requestId && <span className="provenance-rq">{envelope.requestId}</span>}
        <EnvelopeDetails envelope={envelope} />
      </div>
    );
  }

  // A trigger comes from a routine, not a session: no peer to resolve, no chips.
  // The head says what happened (fired vs. a plain scheduled run), the title is
  // the routine's name, the status line is the daemon's "fired <when>, N new
  // items", and the body is the delivery the model was given.
  if (kind === 'trigger') {
    const name = (peer.title ?? '').replace(/^Trigger:\s*/, '') || 'Routine';
    const scheduled = envelope.statusLine === 'scheduled';
    return (
      <div className="provenance-card" data-envelope-kind={kind}>
        <div className="provenance-head">
          <span className="provenance-glyph">{envelopeDirectionGlyph(kind)}</span>
          <span className="provenance-label">{scheduled ? 'Routine ran on schedule' : envelopeDirectionLabel(kind, source)}</span>
        </div>
        <div className="provenance-title" title={name}>{name}</div>
        {envelope.statusLine && !scheduled && <div className="provenance-status">{envelope.statusLine}</div>}
        {envelope.body !== undefined && <EnvelopeBody body={envelope.body} sessionCwd={sessionCwd} />}
        <EnvelopeDetails envelope={envelope} />
      </div>
    );
  }

  const headline = peer.anonymous
    ? 'Unidentified process (no tracked session)'
    : resolved.title || (peer.shortId ? `Session ${peer.shortId}` : 'Unknown session');

  return (
    <div
      className="provenance-card"
      data-envelope-kind={kind}
      {...(peer.anonymous ? { 'data-anonymous': 'true' } : {})}
      {...(source ? { 'data-envelope-source': source } : {})}
    >
      <div className="provenance-head">
        <span className="provenance-glyph">{envelopeDirectionGlyph(kind)}</span>
        <span className="provenance-label">
          {peer.anonymous
            ? 'Message from an unidentified process'
            : envelopeDirectionLabel(kind, source)}
        </span>
        {envelope.requestId && <span className="provenance-rq">{envelope.requestId}</span>}
      </div>
      <div className="provenance-title" title={headline}>{headline}</div>
      <PeerChips peer={peer} resolved={resolved} />
      {envelope.askedPreview && (
        <div className="provenance-asked">
          <span className="provenance-asked-label">You asked</span>
          <span className="provenance-asked-text">{envelope.askedPreview}</span>
        </div>
      )}
      {envelope.statusLine && <div className="provenance-status">{envelope.statusLine}</div>}
      {envelope.body !== undefined && <EnvelopeBody body={envelope.body} sessionCwd={sessionCwd} />}
      {envelope.replyRequest && (
        <div className="provenance-reply-request">
          <span className="provenance-reply-request-label">Reply requested</span>
          <span className="provenance-rq">{envelope.replyRequest.requestId}</span>
          {envelope.replyRequest.command && (
            <CopyChip
              value={envelope.replyRequest.command}
              label="copy reply command"
              title={envelope.replyRequest.command}
            />
          )}
        </div>
      )}
      <EnvelopeDetails envelope={envelope} />
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
