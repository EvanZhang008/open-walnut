/**
 * The card for a Walnut call that carried words to someone: a session's send to
 * another task (the mirror of SessionProvenanceCard, which shows the receiving
 * side), and every other op core/op-cards.ts lists (thread_update, brief_write,
 * human_inbox_send, board_post, org_send, task_create, …).
 *
 * The user's design (2026-11-09: "To Who, Title, Summary, detail collapse"): To
 * (the task as a pill), the Title, a Summary of a line or two, and below them,
 * folded, the full words with the raw call and the server's answer.
 *
 * The words come from Walnut's own record of the call first (op-call-store.ts:
 * what the CLI actually sent, read from `@file` or stdin before the file was
 * gone), else from the transcript (an MCP call's arguments, inline JSON, a
 * heredoc the same command wrote). It never invents a link: a pill appears only
 * for a task the call or the server named.
 *
 * Clicks: the card is rendered from GenericToolCall, which sits inside
 * `.session-msg-content` for an in-message tool and OUTSIDE it for a merged
 * cross-message tool run, so the card carries its own `useEntityClickHandler`
 * and stops propagation on a chip hit so the two paths can never both fire.
 */
import { matchIdRef } from '../../../../src/lib/id-ref';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { stableHtml } from '@/hooks/useStableHtml';
import {
  outboundDirectionGlyph,
  replyRequestToLookUp,
  splitOutboundHandle,
  type OutboundSend,
} from './session-outbound';
import { fetchRequestAsker } from '@/api/sessions';
import { candidateTaskId, resolveRefInIndex } from '@/components/chat/session-mention';
import {
  ensureSessionMentionIndex,
  getSessionMentionIndex,
  subscribeSessionMentionIndex,
} from '@/stores/session-mention-index';
import { sessionStatusStore } from '@/stores/session-status-store';
import { useEntityClickHandler } from '@/hooks/useEntityClickHandler';
import { useEntityLabelsVersion, useRenderedMarkdown, useTaskLabel } from '@/hooks/useEntityLabels';
import { lookupTaskByRef } from '@/stores/entity-label-store';
import { copyTextRobust } from '@/utils/clipboard';
import { fallbackTitle, foldKey, useMessageFold } from './message-fold';
import { useOpCallRecords, type OpCallRecord } from '@/stores/op-call-store';
import type { OpCardFields } from '../../../../src/core/op-cards';
import { disclosureIds, useDetailsDisclosure } from './row-disclosure';
import '@/styles/provenance-fold.css';
import { taskPath } from '@/utils/task-path';

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
  /** The call's other targets (a loop over several tasks), by task. */
  others?: { id: string; title: string }[];
}

/**
 * Where the send went when nothing above named it: the tasks its answer or its
 * arguments name (`refs`, send-targets.ts), by id or id prefix. 2026-10-30, the
 * user, of "To another session": which session? Arguments built in a subshell
 * leave only the answer's "delivered on this host to <id>".
 */
function useRefTargets(send: OutboundSend, resolved: ResolvedTarget): ResolvedTarget {
  const version = useEntityLabelsVersion();
  return useMemo(() => {
    if (resolved.taskId || resolved.fullId || !send.refs?.length) return resolved;
    const tasks = send.refs.map((r) => lookupTaskByRef(r)).filter((t) => !!t);
    if (tasks.length === 0) return resolved;
    return {
      ...resolved,
      taskId: tasks[0].id,
      title: tasks.map((t) => t.label.title).join(' and '),
      ...(tasks.length > 1 ? { others: tasks.slice(1).map((t) => ({ id: t.id, title: t.label.title })) } : {}),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- version invalidates the label lookups
  }, [resolved, send.refs, version]);
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
 * A reply whose answer was cut from the transcript asks the server who sent the
 * request (`replyRequestToLookUp`), and resolves that session the same way.
 */
function useResolvedTarget(send: OutboundSend): ResolvedTarget {
  const candidates = useSyncExternalStore(
    subscribeSessionMentionIndex,
    getSessionMentionIndex,
    getSessionMentionIndex,
  );
  useEffect(() => { void ensureSessionMentionIndex(); }, []);

  const lookUp = replyRequestToLookUp(send);
  const [asker, setAsker] = useState<{ requestId: string; sessionId: string } | null>(null);
  useEffect(() => {
    if (!lookUp) return;
    let alive = true;
    void fetchRequestAsker(lookUp).then((sessionId) => {
      if (alive && sessionId) setAsker({ requestId: lookUp, sessionId });
    });
    return () => { alive = false; };
  }, [lookUp]);
  const askerSid = lookUp && asker?.requestId === lookUp ? asker.sessionId : undefined;

  const resolved = useMemo<ResolvedTarget>(() => {
    const target = askerSid ? { ...send.target, sessionId: askerSid } : send.target ?? {};
    const handle = splitOutboundHandle(target.handle);
    const printedTitle = handle.title ?? target.title;
    if (target.sessionId) {
      const exact = candidates.find((c) => c.id === target.sessionId);
      return {
        fullId: target.sessionId,
        shortId: target.sessionId.slice(0, 8),
        title: exact?.title || printedTitle,
        host: hostLabel(exact?.host),
        ...(target.taskId || candidateTaskId(exact) ? { taskId: target.taskId || candidateTaskId(exact) } : {}),
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
        ...(target.taskId || candidateTaskId(hit) ? { taskId: target.taskId || candidateTaskId(hit) } : {}),
        ambiguous: false,
      };
    }
    const matches = matchIdRef(candidates, ref).length;
    return {
      // Only a PRINTED short id is shown as a dim chip: `to` may be a title or a
      // task, and printing that as an id would be a lie about what it is.
      ...(handle.shortId ? { shortId: handle.shortId } : {}),
      title: printedTitle,
      ...(target.taskId ? { taskId: target.taskId } : {}),
      ambiguous: matches > 1,
    };
  }, [candidates, send, askerSid]);

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

/** What this session said. Same quoted block the inbound card gives the peer. */
function OutboundBody({ body, sessionCwd }: { body: string; sessionCwd?: string }) {
  const html = useRenderedMarkdown(body, sessionCwd);
  return (
    <blockquote className="provenance-body markdown-body" dangerouslySetInnerHTML={stableHtml(html)} />
  );
}

/** The command and the server's answer, ids included: present, never dominant. */
function OutboundDetails({ send, result, sessionId }: { send: OutboundSend; result?: string; sessionId?: string }) {
  const requestId = send.repliedTo ?? send.requestId;
  // Kept by the command, which the live card and its saved twin share.
  const disclosure = useDetailsDisclosure(disclosureIds.content('outbound', send.raw));
  return (
    <details className="provenance-details" {...disclosure}>
      <summary>{send.via === 'cli' ? 'Command & response' : 'Call & response'}</summary>
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

/** Where the payload lived when neither the transcript nor Walnut's record holds it. */
function payloadNote(send: OutboundSend): string | null {
  if (send.body !== undefined) return null;
  if (send.payloadFrom === 'file') return `Sent from ${send.path ?? 'a file'}; Walnut kept no copy of this call\u2019s words.`;
  if (send.payloadFrom === 'stdin') return 'Sent from stdin; Walnut kept no copy of this call\u2019s words.';
  return null;
}

/** "To", "Reply to": the line the card opens with. */
function directionOf(send: OutboundSend, kind: OpCardFields['kind']): string {
  if (send.kind === 'reply' || kind === 'reply') return 'Reply to';
  return 'To';
}

/** The send as Walnut recorded it, over what the transcript holds: Walnut's own
 *  record is what the CLI actually sent, whatever way it got its arguments. */
function withRecord(send: OutboundSend, record: OpCallRecord | undefined): OutboundSend {
  if (!record) return send;
  const f = record.fields;
  return {
    ...send,
    fields: f,
    ...(f.detail !== undefined ? { body: f.detail } : {}),
    ...(f.title && !send.title ? { title: f.title } : {}),
    ...(!send.to && f.to[0] ? { to: f.to[0] } : {}),
    // What the record says it reached is that call's own; the transcript's may be another send's.
    ...(f.to.length ? { refs: f.to } : {}),
    ...(f.kind === 'reply' ? { kind: 'reply' as const } : {}),
    ...(!record.ok ? { error: record.error ?? 'The call was refused' } : {}),
    payloadFrom: undefined,
  };
}

/** A task the call names, as a pill (a click opens it), else nothing. */
function TaskPill({ taskId }: { taskId: string }) {
  const label = useTaskLabel(taskId);
  return (
    <a
      className="provenance-chip provenance-chip-task task-link op-card-to-pill"
      data-task-id={taskId}
      href={taskPath(taskId)}
      title={label?.project ? `${label.project} / ${label.title}` : label?.title}
    >{label?.title ?? taskId}</a>
  );
}

/** Who the call went to: the target's task as a pill, else its session, else words. */
function ToLine({ send, resolved, direction }: { send: OutboundSend; resolved: ResolvedTarget; direction: string }) {
  const version = useEntityLabelsVersion();
  const isSend = send.op === 'task_send' || send.op === 'session_send';
  const taskIds = useMemo(() => {
    if (isSend) return resolved.taskId ? [resolved.taskId, ...(resolved.others ?? []).map((o) => o.id)] : [];
    return send.fields.to.map((r) => lookupTaskByRef(r)?.id).filter((t): t is string => !!t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- version invalidates the label lookups
  }, [isSend, resolved, send.fields.to, version]);
  const fallback = isSend
    ? (resolved.fullId
      ? <a className="provenance-chip provenance-chip-session session-link op-card-to-pill" data-session-id={resolved.fullId} href={`/sessions?id=${resolved.fullId}`}>{resolved.title || 'Open session'}</a>
      : <span className="op-card-to-text">{resolved.title || send.to || (send.kind === 'reply' ? 'The session that asked' : 'another session')}</span>)
    : (send.fields.to[0] && !send.fields.toLabel ? <span className="op-card-to-text">{send.fields.to[0]}</span> : null);
  return (
    <div className="op-card-to">
      <span className="provenance-glyph" aria-hidden="true">{outboundDirectionGlyph(send.kind)}</span>
      <span className="op-card-dir">{direction}</span>
      {taskIds.length > 0 ? taskIds.map((id) => <TaskPill key={id} taskId={id} />) : fallback}
      {send.fields.toLabel && <span className="op-card-to-label">{send.fields.toLabel}</span>}
    </div>
  );
}

export function SessionOutboundCard({
  send: transcriptSend, record, result, sessionCwd, sessionHost, sessionId, onTaskClick, onSessionClick,
}: {
  send: OutboundSend;
  /** Walnut's own record of this call (op-call-store.ts), when it has one. */
  record?: OpCallRecord;
  /** Raw tool output — the disclosure's second half. */
  result?: string;
  sessionCwd?: string;
  sessionHost?: string;
  sessionId?: string;
  onTaskClick?: (taskId: string) => void;
  onSessionClick?: (sessionId: string) => void;
}) {
  const send = withRecord(transcriptSend, record);
  const resolved = useRefTargets(send, useResolvedTarget(send));
  const handleClick = useEntityClickHandler(onTaskClick, onSessionClick, undefined, sessionHost, sessionId);
  const taskLabel = useTaskLabel(resolved.taskId);
  const [open, toggle] = useMessageFold(foldKey(`${send.raw}\u0000${send.op}\u0000${record?.id ?? send.fields.title ?? ''}`));

  const note = payloadNote(send);
  const title = send.title || send.fields.title || fallbackTitle(send.body) || note || undefined;
  const summary = send.fields.summary;
  const status = send.error
    ? send.error
    : send.delivery === 'queued' ? 'Delivered to the session’s queue'
      : send.delivery === 'deferred' ? 'Held: the target is waiting on a permission prompt'
        : send.delivery;
  const direction = directionOf(send, send.fields.kind);
  const hasDetail = send.body !== undefined;

  return (
    <div
      className="provenance-card op-card"
      data-envelope-kind="outbound"
      data-op={send.op}
      data-outbound-via={send.via}
      data-folded={open ? 'false' : 'true'}
      aria-label={`${direction} ${taskLabel?.title || resolved.title || send.fields.toLabel || send.to || 'another session'}: ${title ?? ''}`}
      {...(send.error ? { 'data-outbound-error': 'true' } : {})}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('a.session-link, a.task-link')) e.stopPropagation();
        handleClick(e);
      }}
    >
      <ToLine send={send} resolved={resolved} direction={direction} />
      <button
        type="button"
        className="op-card-main"
        aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); toggle(); }}
      >
        {title && <span className="op-card-title">{title}</span>}
        {summary && <span className="op-card-summary">{summary}</span>}
        <span className="op-card-more">
          <span className="op-card-more-chevron" aria-hidden="true">›</span>
          {open ? 'Hide details' : 'Details'}
        </span>
      </button>
      {send.error && <div className="provenance-status">{send.error}</div>}
      {open && (
        <div className="op-card-detail">
          {!send.error && status && <div className="provenance-status">{status}</div>}
          {hasDetail && <OutboundBody body={send.body!} sessionCwd={sessionCwd} />}
          {note && <div className="provenance-outbound-payload">{note}</div>}
          <OutboundDetails send={send} result={result} sessionId={resolved.fullId} />
        </div>
      )}
    </div>
  );
}

/**
 * Every Walnut call one tool row made (a command may send, then update two
 * threads), one card each. Walnut's record of the row wins: it holds what each
 * call really sent, a loop's every send included, whatever way the CLI got the
 * arguments; the transcript's reading covers history recorded before it.
 */
export function SessionOutboundCards({
  calls, toolUseId, running, result, sessionCwd, sessionHost, sessionId, onTaskClick, onSessionClick,
}: {
  calls: OutboundSend[];
  toolUseId?: string;
  /** The call has not returned yet: the record lands just before it does. */
  running: boolean;
  result?: string;
  sessionCwd?: string;
  sessionHost?: string;
  sessionId?: string;
  onTaskClick?: (taskId: string) => void;
  onSessionClick?: (sessionId: string) => void;
}) {
  const viaCli = calls.some((c) => c.via === 'cli');
  const records = useOpCallRecords(sessionId, toolUseId, viaCli, running ? 'running' : 'done');
  const pairs = useMemo(() => pairWithRecords(calls, records), [calls, records]);
  const shared = { result, sessionCwd, sessionHost, sessionId, onTaskClick, onSessionClick };
  if (pairs.length === 1) return <SessionOutboundCard send={pairs[0].send} record={pairs[0].record} {...shared} />;
  return (
    <div className="op-card-stack">
      {pairs.map((p, i) => <SessionOutboundCard key={p.record?.id ?? i} send={p.send} record={p.record} {...shared} />)}
    </div>
  );
}

/**
 * Each transcript call with Walnut's record of it (same op, same order), every
 * call kept whether or not it has one; a record with no call of its own (a loop's
 * later sends) is added after the row's last call of that op, carrying only what
 * the record says: never another send's target, request or answer.
 */
export function pairWithRecords(calls: OutboundSend[], records: OpCallRecord[] | undefined): Array<{ send: OutboundSend; record?: OpCallRecord }> {
  if (!records?.length) return calls.map((send) => ({ send }));
  const byOp = new Map<string, OpCallRecord[]>();
  for (const r of records) byOp.set(r.op, [...(byOp.get(r.op) ?? []), r]);
  const used = new Map<string, number>();
  const lastOf = new Map<string, number>();
  calls.forEach((c, i) => lastOf.set(c.op, i));
  const out: Array<{ send: OutboundSend; record?: OpCallRecord }> = [];
  const extras = (op: string, base: OutboundSend) => {
    const list = byOp.get(op) ?? [];
    for (const record of list.slice(used.get(op) ?? 0)) out.push({ send: ownSend(base, record), record });
    used.set(op, list.length);
  };
  calls.forEach((send, i) => {
    const list = byOp.get(send.op) ?? [];
    const n = used.get(send.op) ?? 0;
    if (n < list.length) { out.push({ send, record: list[n] }); used.set(send.op, n + 1); } else out.push({ send });
    if (lastOf.get(send.op) === i) extras(send.op, send);
  });
  // A record of an op the transcript shows no call of (a payload built in a subshell).
  for (const op of byOp.keys()) if (!lastOf.has(op) && calls[0]) extras(op, calls[0]);
  return out;
}

/** A send built from its record alone, on the row's command (for the details). */
function ownSend(base: OutboundSend, record: OpCallRecord): OutboundSend {
  return {
    op: record.op,
    fields: record.fields,
    ...(base.form ? { form: base.form } : {}),
    via: base.via,
    kind: record.fields.kind === 'reply' ? 'reply' : 'peer-note',
    raw: base.raw,
  };
}
