/**
 * Detect a session→session SEND in the SENDING session's own transcript — pure,
 * dependency-free, render-agnostic.
 *
 * The receiving side has had a provenance card since the envelope shipped
 * (session-envelope.ts + SessionProvenanceCard): an arriving message is framed, so
 * the renderer can name the peer and quote its words. The sending side had
 * nothing. The same conversation showed up as a generic tool row
 * (`mcp__walnut__session_send`, or a Bash one-liner whose payload is a
 * single-quoted JSON blob), so the one fact a human wants — I told WHICH session
 * WHAT — was the least readable thing in the timeline.
 *
 * Two transports reach the same server op:
 *
 *  1. the MCP tool (`mcp__<server>__session_send`): the arguments arrive as a real
 *     object, so there is nothing to parse but the result;
 *  2. the CLI (`walnut tools call session_send '{…}'`) inside a Bash command: the
 *     payload is a SHELL WORD, and that is where the work is.
 *
 * Three rules this file encodes, each one a way the naive version is wrong:
 *
 *  · Tokenize the command; never regex the raw string. `echo "run walnut tools
 *    call session_send …"` is ONE quoted word, not four, so a tokenizer rejects it
 *    for free — while `python3 … | walnut tools call session_send -` (a real
 *    pipeline) is accepted, because the pipe puts the command at a command
 *    position. A substring match gets both of those backwards.
 *  · `walnut tools help session_send` and `walnut tools call session_send --help`
 *    ASK ABOUT the op. They send nothing, so they must not card.
 *  · The payload is not always in the transcript. `@/path/args.json` and `-`
 *    (stdin) are the documented big-payload forms, so the card has to be able to
 *    say "the body was not here" rather than invent one.
 *
 * Nothing here throws. A malformed payload still yields a card (the command is
 * `raw`, and the reader can open the disclosure): a send that happened is worth
 * showing even when its arguments cannot be read.
 */
import type { SessionHistoryTool } from '@/types/session';
import { sendTargetRefs } from '@open-walnut/send-targets';
import { isCardedOp, opCardFields, type OpCardFields } from '../../../../src/core/op-cards';
import { findOpCalls, tokenizeCommand, type OpArgForm } from '../../../../src/lib/walnut-op-command';

export { tokenizeCommand };

/** The resolved target, as the server reports it back. */
export interface OutboundTarget {
  /** Printed `Title [8hex]` — the form `to` accepts back. */
  handle?: string;
  sessionId?: string;
  taskId?: string;
  /** Title as the server printed it (flattened, clipped at 80 code points). */
  title?: string;
}

export interface OutboundSend {
  /** The Walnut op (task_send, thread_update, brief_write, …: core/op-cards.ts). */
  op: string;
  /** To / Title / Summary / Detail, from the arguments the transcript holds. A
   *  call whose arguments it does not hold has none of the words; the card asks
   *  Walnut's own record of the call (op-call-store.ts). */
  fields: OpCardFields;
  /** How the CLI got its arguments. */
  form?: OpArgForm;
  /** `@path` as typed. */
  path?: string;
  /** Which transport carried the call. */
  via: 'mcp' | 'cli';
  /** 'reply' when the send answers a pending request (`in_reply_to`/`repliedTo`). */
  kind: 'peer-note' | 'reply';
  /** What the caller addressed: an id, a prefix, a task, or a title substring. */
  to?: string;
  /** Every target the call reached, as ids or id prefixes (send-targets.ts): the
   *  server's answer, then the arguments. A loop over targets is one call with
   *  several; arguments built in a subshell leave only the answer to name them. */
  refs?: string[];
  /** The words that were sent. Absent when the payload never rode the command. */
  body?: string;
  /** The one-line TL;DR the sender gave (`title`), the folded card's line. */
  title?: string;
  requestId?: string;
  repliedTo?: string;
  target?: OutboundTarget;
  /** `queued` / `deferred`, or the server's own outcome sentence when it sent one. */
  delivery?: string;
  error?: string;
  /** Set when the payload lived OUTSIDE the transcript, so a card can say so
   *  instead of rendering an empty body. */
  payloadFrom?: 'file' | 'stdin';
  /** What the model actually issued: the shell command, or the MCP arguments. */
  raw: string;
}

/** `mcp__<server>__<op>`. The server key is per-install, so it is a pattern;
 *  `[^_]` after the prefix keeps `mcp____…` out. */
const MCP_OP = /^mcp__[^_].*?__([a-z][a-z0-9_]*)$/;

/** The send ops: their answer names a target session (task_send, and
 *  session_send, the deprecated alias that takes the same arguments). */
const SEND_OPS = new Set(['task_send', 'session_send']);

/** Keys that identify a session_send answer among other JSON in the output. */
const RESULT_KEYS = [
  'delivery', 'targetSessionId', 'targetTitle', 'targetTaskId', 'target',
  'requestId', 'repliedTo', 'messageId', 'outcome', 'error',
];

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** What only a send answers with: on a row with other calls, another op's
 *  answer may carry `outcome` or `error` too. */
const SEND_ONLY_KEYS = RESULT_KEYS.filter((k) => k !== 'outcome' && k !== 'error');

function looksLikeSendResult(v: Json, strict = false): boolean {
  return (strict ? SEND_ONLY_KEYS : RESULT_KEYS).some((k) => k in v);
}

/** Index just past the `}` matching the `{` at `start`, or -1. String-aware. */
function balancedEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') { i++; continue; }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i + 1;
  }
  return -1;
}

/** Every top-level `{…}` in `text` that parses as a JSON object, in order. */
function parseObjectsIn(text: string, budget: number): Json[] {
  const out: Json[] = [];
  let from = 0;
  for (let n = 0; n < budget; n++) {
    const open = text.indexOf('{', from);
    if (open < 0) break;
    const end = balancedEnd(text, open);
    if (end < 0) break;
    try {
      const parsed: unknown = JSON.parse(text.slice(open, end));
      if (isObject(parsed)) { out.push(parsed); from = end; continue; }
    } catch { /* not JSON at this offset — keep scanning */ }
    from = open + 1;
  }
  return out;
}

/**
 * Every send answer inside a tool output, in the order printed, however it is
 * wrapped: the CLI prints it as stdout (sometimes with other lines around it),
 * MCP wraps it in content blocks (`text` / `content[].text`).
 */
function findSendResults(text: string | undefined, strict: boolean, depth = 0): Json[] {
  if (!text || depth > 2) return [];
  const objs = parseObjectsIn(text, 48);
  const direct = objs.filter((o) => looksLikeSendResult(o, strict));
  if (direct.length > 0) return direct;
  for (const o of objs) {
    const nested: string[] = [];
    if (typeof o.text === 'string') nested.push(o.text);
    if (Array.isArray(o.content)) {
      for (const part of o.content) {
        if (isObject(part) && typeof part.text === 'string') nested.push(part.text);
      }
    }
    for (const s of nested) {
      const hit = findSendResults(s, strict, depth + 1);
      if (hit.length) return hit;
    }
  }
  return [];
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

/** An error the server reported, as a string / `{code,message}` / anything. */
function errorText(v: unknown): string | undefined {
  if (typeof v === 'string') return v.trim() || undefined;
  if (isObject(v)) return str(v.message) ?? str(v.code) ?? str(v.error);
  return undefined;
}

/** Title / id parts of a printed `Title [8hex]` handle. */
export function splitOutboundHandle(handle: string | undefined): { title?: string; shortId?: string } {
  if (!handle) return {};
  const m = HANDLE_ID.exec(handle);
  if (!m) return { title: handle.trim() || undefined };
  const title = handle.slice(0, m.index).trim();
  return { ...(title ? { title } : {}), shortId: m[1] };
}

function targetFrom(result: Json | undefined): OutboundTarget | undefined {
  if (!result) return undefined;
  const nested = isObject(result.target) ? result.target : undefined;
  const handle = str(nested?.handle);
  const sessionId = str(nested?.sessionId) ?? str(result.targetSessionId);
  const taskId = str(nested?.taskId) ?? str(result.targetTaskId);
  const title = str(result.targetTitle);
  const target: OutboundTarget = {
    ...(handle ? { handle } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(taskId ? { taskId } : {}),
    ...(title ? { title } : {}),
  };
  return Object.keys(target).length > 0 ? target : undefined;
}

/** A printed handle's id part: `Title [8hex]`. */
const HANDLE_ID = /\[([^[\]\s]{4,})\]\s*$/;

interface RawCall { op: string; via: 'mcp' | 'cli'; args?: Json; form?: OpArgForm; path?: string; raw: string }

/** The Walnut op calls one tool row made, in order. */
function rawCallsOf(tool: SessionHistoryTool): RawCall[] {
  const name = typeof tool?.name === 'string' ? tool.name : '';
  const input = isObject(tool?.input) ? tool.input : {};
  const mcp = MCP_OP.exec(name);
  if (mcp && isCardedOp(mcp[1])) {
    let raw: string;
    try { raw = JSON.stringify(input, null, 2); } catch { raw = String(input); }
    return [{ op: mcp[1], via: 'mcp', args: input, raw }];
  }
  if (name !== 'Bash' || typeof input.command !== 'string') return [];
  const command = input.command;
  return findOpCalls(command, isCardedOp).map((c) => ({
    op: c.op,
    via: 'cli' as const,
    ...(c.args ? { args: c.args } : {}),
    form: c.form,
    ...(c.path ? { path: c.path } : {}),
    raw: command,
  }));
}

/**
 * Every Walnut call in this session's transcript row that carries words to
 * someone (core/op-cards.ts), in order; empty for every other tool call.
 * `result` is the tool output (the streaming path passes it separately from the
 * persisted `tool.result`).
 */
export function detectOutboundCalls(tool: SessionHistoryTool, result?: string): OutboundSend[] {
  const calls = rawCallsOf(tool);
  if (calls.length === 0) return [];
  const sendResults = calls.some((c) => SEND_OPS.has(c.op)) ? findSendResults(result, calls.length > 1) : [];
  let sendIndex = 0;
  return calls.map((c) => {
    const args = c.args;
    const isSend = SEND_OPS.has(c.op);
    // A loop's answers come one per send; a row with one send call reads its first.
    const res = isSend ? sendResults[sendIndex++] : undefined;
    const inReplyTo = str(args?.in_reply_to) ?? str(args?.inReplyTo);
    const repliedTo = str(res?.repliedTo) ?? inReplyTo;
    const requestId = str(res?.requestId) ?? str(args?.request_id);
    const target = targetFrom(res);
    const delivery = str(res?.delivery) ?? str(res?.outcome);
    // A non-JSON failure line is still the honest answer to "what happened": show
    // its first line rather than a card that looks like it succeeded.
    const fallbackError = tool.isError && result && !res && calls.length === 1
      ? result.split('\n').map((l) => l.trim()).find((l) => l.length > 0)?.slice(0, 200)
      : undefined;
    const error = errorText(res?.error) ?? fallbackError;
    const fields = opCardFields(c.op, args) ?? { op: c.op, kind: 'send' as const, to: [] };
    const to = isSend ? str(args?.to) : fields.to[0];
    const refs = isSend ? sendTargetRefs(args, c.via === 'cli' ? c.raw : undefined, calls.length === 1 ? result : undefined) : fields.to;
    const payloadFrom = !args && (c.form === 'file' || c.form === 'stdin') ? c.form : undefined;
    const body = fields.detail;
    return {
      op: c.op,
      fields,
      ...(c.form ? { form: c.form } : {}),
      ...(c.path ? { path: c.path } : {}),
      via: c.via,
      kind: inReplyTo || str(res?.repliedTo) ? 'reply' : 'peer-note',
      ...(to ? { to } : {}),
      ...(refs.length > 0 ? { refs } : {}),
      ...(body ? { body } : {}),
      ...(str(args?.title) ? { title: str(args?.title)!.replace(/\s+/g, ' ').trim() } : {}),
      ...(requestId ? { requestId } : {}),
      ...(repliedTo ? { repliedTo } : {}),
      ...(target ? { target } : {}),
      ...(delivery ? { delivery } : {}),
      ...(error ? { error } : {}),
      ...(payloadFrom ? { payloadFrom } : {}),
      raw: c.raw,
    } satisfies OutboundSend;
  });
}

/** The first carded call of a row, or null (the single-card readers). */
export function detectOutboundSend(tool: SessionHistoryTool, result?: string): OutboundSend | null {
  return detectOutboundCalls(tool, result)[0] ?? null;
}

const REQUEST_ID = /^rq-[a-f0-9]{6,}$/;

/**
 * The request a reply card must look up to name its target, or undefined.
 *
 * A reply goes to the session that asked, and the server's answer names it. The
 * model sometimes cuts that answer before it reaches the transcript (`walnut
 * tools call task_send … | tail -3` keeps only the closing lines), which left the
 * card titled "Unknown session". The request id rides the command itself, and the
 * server still holds the row that names the asker.
 */
export function replyRequestToLookUp(send: OutboundSend): string | undefined {
  if (send.kind !== 'reply' || send.target?.sessionId || send.target?.handle) return undefined;
  const id = send.repliedTo;
  return id && REQUEST_ID.test(id) ? id : undefined;
}

/** Human label for a send — the mirror of `envelopeDirectionLabel`. */
export function outboundDirectionLabel(kind: OutboundSend['kind']): string {
  return kind === 'reply' ? 'Reply to another session' : 'Message to another session';
}

/**
 * Glyph for a send. The inbound card's peer note points INTO this session ('→')
 * and its reply comes back ('↩'); a send is the same pair reversed: it leaves
 * ('↗') or it answers someone else's question ('↪').
 */
export function outboundDirectionGlyph(kind: OutboundSend['kind']): string {
  return kind === 'reply' ? '↪' : '↗';
}
