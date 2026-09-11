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
  /** Which transport carried the call. */
  via: 'mcp' | 'cli';
  /** 'reply' when the send answers a pending request (`in_reply_to`/`repliedTo`). */
  kind: 'peer-note' | 'reply';
  /** What the caller addressed: an id, a prefix, a task, or a title substring. */
  to?: string;
  /** The words that were sent. Absent when the payload never rode the command. */
  body?: string;
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

/** `mcp__<server>__session_send`. The server key is per-install, so it is a
 *  pattern; `[^_]` after the prefix keeps `mcp____…` out. */
const MCP_SEND = /^mcp__[^_].*__session_send$/;

/** Shell metacharacters that end a word and start a new command position. */
const OPERATOR_CHARS = new Set([';', '|', '&', '(', ')', '{', '}', '\n']);

/** Tokens that may precede a command without moving it out of head position. */
const COMMAND_WRAPPERS = new Set(['env', 'exec', 'sudo', 'time', 'nice', 'command', 'builtin']);

/** `NAME=value` prefix assignments, which also keep the head position. */
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** A printed handle's id part: `Title [8hex]`. Not restricted to hex — the
 *  bracket holds a session-id PREFIX, and only unique-prefix resolution (never
 *  this regex) decides whether it earns a link. */
const HANDLE_ID = /\[([^[\]\s]{4,})\]\s*$/;

/** Guard against doing tokenizer work inside a render for a pathological input. */
const MAX_COMMAND_CHARS = 400_000;

interface ShellToken {
  /** The word with one level of quoting removed. */
  value: string;
  /** True when any part of the word was quoted — a quoted `walnut` is prose. */
  quoted: boolean;
  /** True for a run of shell operators (`|`, `&&`, `;`, newline, …). */
  op: boolean;
}

/**
 * Split a shell command into words, undoing ONE level of quoting.
 *
 * This is not a shell; it is the smallest thing that reads a `walnut tools call`
 * line correctly. Concatenation is what makes it work: `'it'\''s'` and
 * `'it'"'"'s'` are both three adjacent pieces of one word, so appending each
 * piece in turn reproduces the literal the shell would have passed — which is
 * exactly how a `session_send` payload carries an apostrophe.
 */
export function tokenizeCommand(command: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  const n = command.length;
  let i = 0;
  while (i < n) {
    const c = command[i];
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (OPERATOR_CHARS.has(c)) {
      let j = i;
      while (j < n && OPERATOR_CHARS.has(command[j])) j++;
      tokens.push({ value: command.slice(i, j), quoted: false, op: true });
      i = j;
      continue;
    }
    let value = '';
    let quoted = false;
    while (i < n) {
      const ch = command[i];
      if (ch === ' ' || ch === '\t' || ch === '\r' || OPERATOR_CHARS.has(ch)) break;
      if (ch === "'") {
        quoted = true;
        const close = command.indexOf("'", i + 1);
        if (close < 0) { value += command.slice(i + 1); i = n; break; }
        value += command.slice(i + 1, close);
        i = close + 1;
        continue;
      }
      if (ch === '"') {
        quoted = true;
        i++;
        while (i < n && command[i] !== '"') {
          // Inside double quotes only a few escapes are real; passing the escaped
          // character through is right for every one of them.
          if (command[i] === '\\' && i + 1 < n) { value += command[i + 1]; i += 2; continue; }
          value += command[i++];
        }
        i++;
        continue;
      }
      if (ch === '\\' && i + 1 < n) { value += command[i + 1]; i += 2; continue; }
      value += ch;
      i++;
    }
    tokens.push({ value, quoted, op: false });
  }
  return tokens;
}

/** True when `tokens[i]` sits where a shell would look for a command name. */
function atCommandPosition(tokens: ShellToken[], i: number): boolean {
  if (i === 0) return true;
  const prev = tokens[i - 1];
  if (prev.op) return true;
  if (prev.quoted) return false;
  return ENV_ASSIGN.test(prev.value) || COMMAND_WRAPPERS.has(prev.value);
}

/** `walnut`, `open-walnut`, or either behind a path. */
function isWalnutBinary(word: string): boolean {
  const base = word.slice(word.lastIndexOf('/') + 1);
  return base === 'walnut' || base === 'open-walnut';
}

/**
 * The argument word of a real `… walnut tools call session_send …` in `command`.
 *
 * Returns `null` when the command does not send (help, a different op, prose), and
 * `{ arg: undefined }` when it sends with no argument word at all.
 */
function findCliSend(command: string): { arg?: ShellToken } | null {
  // Cheap gate first: this runs for every Bash row in a whale transcript.
  if (!command.includes('session_send')) return null;
  if (command.length > MAX_COMMAND_CHARS) return null;
  const tokens = tokenizeCommand(command);
  for (let i = 0; i + 3 < tokens.length; i++) {
    const head = tokens[i];
    if (head.op || head.quoted || !isWalnutBinary(head.value)) continue;
    const [tools, call, op] = [tokens[i + 1], tokens[i + 2], tokens[i + 3]];
    if ([tools, call, op].some((t) => t.op || t.quoted)) continue;
    if (tools.value !== 'tools' || call.value !== 'call' || op.value !== 'session_send') continue;
    if (!atCommandPosition(tokens, i)) continue;
    const arg = tokens[i + 4];
    // `--help` after the op asks for the schema; nothing is sent.
    if (arg && !arg.op && (arg.value === '--help' || arg.value === '-h')) return null;
    return { arg: arg && !arg.op ? arg : undefined };
  }
  return null;
}

/** Keys that identify a session_send answer among other JSON in the output. */
const RESULT_KEYS = [
  'delivery', 'targetSessionId', 'targetTitle', 'targetTaskId', 'target',
  'requestId', 'repliedTo', 'messageId', 'outcome', 'error',
];

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function looksLikeSendResult(v: Json): boolean {
  return RESULT_KEYS.some((k) => k in v);
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

/** Every `{…}` in `text` that parses as a JSON object, outermost first. */
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
      if (isObject(parsed)) out.push(parsed);
    } catch { /* not JSON at this offset — keep scanning */ }
    from = open + 1;
  }
  return out;
}

/**
 * The send result inside a tool output, however it is wrapped.
 *
 * The CLI prints it as stdout (sometimes with other lines around it) and MCP
 * wraps it in content blocks, so this scans for the first JSON object that looks
 * like a send answer and then descends one level into `text` / `content[].text`
 * for the MCP shape. Never throws: no hit simply means no result detail.
 */
function findSendResult(text: string | undefined, depth = 0): Json | undefined {
  if (!text || depth > 2) return undefined;
  const objs = parseObjectsIn(text, 24);
  for (const o of objs) if (looksLikeSendResult(o)) return o;
  for (const o of objs) {
    const nested: string[] = [];
    if (typeof o.text === 'string') nested.push(o.text);
    if (Array.isArray(o.content)) {
      for (const part of o.content) {
        if (isObject(part) && typeof part.text === 'string') nested.push(part.text);
      }
    }
    for (const s of nested) {
      const hit = findSendResult(s, depth + 1);
      if (hit) return hit;
    }
  }
  return undefined;
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

/**
 * A session→session send in this session's transcript, or `null` for every other
 * tool call. `result` is the tool output (the streaming path passes it separately
 * from the persisted `tool.result`).
 */
export function detectOutboundSend(
  tool: SessionHistoryTool,
  result?: string,
): OutboundSend | null {
  const name = typeof tool?.name === 'string' ? tool.name : '';
  const input = isObject(tool?.input) ? tool.input : {};

  let via: 'mcp' | 'cli';
  let raw: string;
  let args: Json | undefined;
  let payloadFrom: 'file' | 'stdin' | undefined;

  if (MCP_SEND.test(name)) {
    via = 'mcp';
    args = input;
    try {
      raw = JSON.stringify(input, null, 2);
    } catch {
      raw = String(input);
    }
  } else if (name === 'Bash' && typeof input.command === 'string') {
    const found = findCliSend(input.command);
    if (!found) return null;
    via = 'cli';
    raw = input.command;
    const word = found.arg;
    if (word) {
      if (word.value === '-' && !word.quoted) payloadFrom = 'stdin';
      else if (word.value.startsWith('@')) payloadFrom = 'file';
      else {
        try {
          const parsed: unknown = JSON.parse(word.value);
          if (isObject(parsed)) args = parsed;
        } catch { /* malformed payload — the card still shows the command */ }
      }
    }
  } else {
    return null;
  }

  const res = findSendResult(result);
  const inReplyTo = str(args?.in_reply_to) ?? str(args?.inReplyTo);
  const repliedTo = str(res?.repliedTo) ?? inReplyTo;
  const requestId = str(res?.requestId) ?? str(args?.request_id);
  const target = targetFrom(res);
  const delivery = str(res?.delivery) ?? str(res?.outcome);
  // A non-JSON failure line is still the honest answer to "what happened": show
  // its first line rather than a card that looks like it succeeded.
  const fallbackError = tool.isError && result && !res
    ? result.split('\n').map((l) => l.trim()).find((l) => l.length > 0)?.slice(0, 200)
    : undefined;
  const error = errorText(res?.error) ?? fallbackError;
  const to = str(args?.to);

  return {
    via,
    kind: inReplyTo || str(res?.repliedTo) ? 'reply' : 'peer-note',
    ...(to ? { to } : {}),
    ...(typeof args?.text === 'string' && args.text ? { body: args.text } : {}),
    ...(requestId ? { requestId } : {}),
    ...(repliedTo ? { repliedTo } : {}),
    ...(target ? { target } : {}),
    ...(delivery ? { delivery } : {}),
    ...(error ? { error } : {}),
    ...(payloadFrom ? { payloadFrom } : {}),
    raw,
  };
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
