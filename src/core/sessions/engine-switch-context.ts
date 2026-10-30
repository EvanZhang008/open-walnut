/**
 * What an engine switch carries into the new session: everything the old
 * session holds in its context RIGHT NOW (2026-10-29, the user: "就让他直接拥有所有的
 * conversation ... 你 compaction 之前肯定不算"). That is the latest compaction
 * summary, when there is one, plus every turn after it in full: messages, tool
 * calls, tool results. Nothing from before the last compaction beyond that
 * summary; the full transcript file (written beside it) holds the rest.
 *
 * The active context is read the harness's own way, never guessed:
 *  - Claude Code: the CLI's load chain (transcript-chain.ts computeCliLoadedChain,
 *    a port of the CLI's own leaf pick and parentUuid walk). A compact boundary
 *    has no parent, so the walk from the active leaf stops there: the chain IS
 *    what the CLI would load on a resume.
 *  - ACP engines: Walnut's own journal is the conversation (no compaction of ours).
 *
 * When it does not fit the target engine's window, the OLDEST turns after the
 * summary go first, and the text says how many (never a failed switch).
 */
import type { SessionHistoryMessage, SessionHistoryTool } from '../session-history.js';
import type { SessionRecord } from '../types.js';
import { engineCaps, isAcpEngine, resolveEngine } from '../agents/engine-registry.js';
import { log } from '../../logging/index.js';

/** The hint kind the carried context rides in (hints/hint-format.ts): display shows the user's words only. */
export const ENGINE_SWITCH_HINT = 'engine-switch';
/** A single tool result kept whole up to this (one huge file dump never eats the budget alone). */
export const CARRY_TOOL_RESULT_MAX = 60_000;
const CARRY_TOOL_INPUT_MAX = 20_000;
/**
 * The raw transcript read stays inside the reader's own ceiling (32 MB by default);
 * a bigger file falls back to the parsed history, which reads a bounded window.
 * Parsing costs about 3 ms per MB of the event loop (replica/host-history.ts), and
 * the line pass yields every 2000 lines, so one switch never stalls the server.
 */
async function maxTranscriptBytes(): Promise<number> {
  const { DaemonFileReader } = await import('../daemon-file-reader.js');
  return DaemonFileReader.maxReadBytes();
}
/** Share of the target window the carried context may take: the new session needs room to work. */
export const CARRY_WINDOW_SHARE = 0.6;

export interface ActiveContext {
  messages: SessionHistoryMessage[];
  /** The context starts at a compaction summary. */
  compacted: boolean;
  source: 'cli-chain' | 'acp-journal' | 'history';
  /** The old session's own transcript file (Claude Code's JSONL), when Walnut found it. */
  rawTranscriptPath?: string;
}

/** Yield to the event loop every so often: a long transcript is tens of MB. */
const tick = () => new Promise<void>((r) => setImmediate(r));

/**
 * The old session's active context as history rows. Never throws for an
 * unreadable transcript: it falls back to the parsed history after the last
 * compaction row (logged), and to nothing at all.
 */
export async function readActiveContext(record: SessionRecord): Promise<ActiveContext> {
  if (engineCaps(record.engine).historySource === 'acp-journal') {
    const { readProviderSessionHistory } = await import('./session-lifecycle.js');
    const { messages } = await readProviderSessionHistory(record.claudeSessionId, record, record.host, true);
    return { messages, compacted: false, source: 'acp-journal' };
  }
  try {
    const chain = await readClaudeChain(record);
    if (chain) return chain;
  } catch (err) {
    log.session.warn('engine switch: reading the CLI chain failed, using the parsed history', {
      sessionId: record.claudeSessionId, error: err instanceof Error ? err.message : String(err),
    });
  }
  const { readProviderSessionHistory } = await import('./session-lifecycle.js');
  const { messages } = await readProviderSessionHistory(record.claudeSessionId, record, record.host, true);
  const cut = lastCompactionIndex(messages);
  return { messages: cut >= 0 ? messages.slice(cut) : messages, compacted: cut >= 0, source: 'history' };
}

function lastCompactionIndex(messages: readonly SessionHistoryMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'system' && messages[i].systemVariant === 'compact') return i;
  }
  return -1;
}

async function readClaudeChain(record: SessionRecord): Promise<ActiveContext | null> {
  const host = record.host || '__local__';
  const { findTranscript } = await import('../transfer/daemon-transfer-client.js');
  const found = await findTranscript(host, record.claudeSessionId);
  if (found.kind !== 'one') return null;
  const { DaemonFileReader } = await import('../daemon-file-reader.js');
  const bytes = await new DaemonFileReader(host).readFileBytes(found.path, await maxTranscriptBytes());
  if (!bytes) return null;
  const rawLines = bytes.toString('utf8').split('\n');
  const parsed: Array<{ uuid?: string } & Record<string, unknown>> = [];
  const raws: string[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    if (i % 2000 === 1999) await tick();
    const raw = rawLines[i];
    if (!raw.trim()) continue;
    try { parsed.push(JSON.parse(raw)); raws.push(raw); } catch { /* a torn line: the CLI skips it too */ }
  }
  const { computeCliLoadedChain } = await import('../transcript-chain.js');
  const { chainUuids } = computeCliLoadedChain(parsed as never);
  if (chainUuids.size === 0) return { messages: [], compacted: false, source: 'cli-chain', rawTranscriptPath: found.path };
  const kept: string[] = [];
  let compacted = false;
  for (let i = 0; i < parsed.length; i++) {
    if (i % 5000 === 4999) await tick();
    const uuid = parsed[i].uuid;
    if (typeof uuid !== 'string' || !chainUuids.has(uuid)) continue;
    if (parsed[i].type === 'system' && parsed[i].subtype === 'compact_boundary') compacted = true;
    kept.push(raws[i]);
  }
  const { parseSessionMessages } = await import('../session-history.js');
  const messages = parseSessionMessages(kept.join('\n'), { toolResultMaxAll: CARRY_TOOL_RESULT_MAX });
  return { messages, compacted, source: 'cli-chain', rawTranscriptPath: found.path };
}

// ── Rendering ──

/** A token estimate that does not undercount: CJK is about a token a character, the rest about 3.5 characters. */
export function estimateTokens(text: string): number {
  let cjk = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if ((c >= 0x3000 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af) || (c >= 0xf900 && c <= 0xfaff) || c >= 0x20000) cjk++;
  }
  return Math.ceil(cjk + (text.length - cjk) / 3.5);
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n[... ${text.length - max} more characters cut]` : text;
}

function renderTool(tool: SessionHistoryTool): string {
  const input = JSON.stringify(tool.input ?? {}, null, 1);
  const parts = [`[tool call: ${tool.name}${tool.isError ? ' (failed)' : ''}]`, cut(input === '{}' ? '' : input, CARRY_TOOL_INPUT_MAX)].filter(Boolean);
  const result = tool.result;
  if (result !== undefined && result !== '') {
    const more = tool.resultChars && tool.resultChars > result.length ? `\n[... ${tool.resultChars - result.length} more characters cut]` : '';
    parts.push(`[tool result]\n${result}${more}`);
  }
  return parts.join('\n');
}

function renderRow(m: SessionHistoryMessage, switchHints = true): string {
  if (m.role === 'system') {
    return m.systemVariant === 'compact'
      ? '[The conversation was compacted here. The summary below stands for everything before it.]'
      : `[${m.text.trim()}]`;
  }
  const who = m.role === 'user' ? (m.injected ? 'Context (not typed by the user)' : 'User') : 'Assistant';
  const parts = [`### ${who}`];
  // The context an earlier switch carried in is part of that session's context
  // (a round trip keeps everything); Walnut's other per-message hints are not.
  if (switchHints) for (const hint of m.hints ?? []) if (hint.kind === ENGINE_SWITCH_HINT) parts.push(hint.text);
  const text = m.text.trim();
  if (text) parts.push(text);
  for (const tool of m.tools ?? []) parts.push(renderTool(tool));
  return parts.join('\n');
}

/** Each turn starts at a message the user typed; what comes before the first one (the summary) is the head. */
function splitTurns(messages: readonly SessionHistoryMessage[]): { head: SessionHistoryMessage[]; turns: SessionHistoryMessage[][] } {
  const head: SessionHistoryMessage[] = [];
  const turns: SessionHistoryMessage[][] = [];
  for (const m of messages) {
    if (m.role !== 'system' && !m.text.trim() && !(m.tools?.length)) continue;
    const startsTurn = m.role === 'user' && !m.injected;
    if (startsTurn) turns.push([m]);
    else if (turns.length === 0) head.push(m);
    else turns[turns.length - 1].push(m);
  }
  return { head, turns };
}

/**
 * A session's OWN turns as one text, without the context an engine switch carried
 * into it: what a resumed earlier session missed (engine-switch-resume.ts).
 */
export async function renderOwnTurns(messages: readonly SessionHistoryMessage[]): Promise<{ text: string; turns: number }> {
  const { turns } = splitTurns(messages);
  const out: string[] = [];
  for (let i = 0; i < turns.length; i++) {
    if (i % 50 === 49) await tick();
    out.push(turns[i].map((m) => renderRow(m, false)).join('\n\n'));
  }
  return { text: out.join('\n\n'), turns: turns.length };
}

export interface CarriedContext {
  text: string;
  carriedTurns: number;
  /** Oldest turns after the summary left out to fit the target window. */
  trimmedTurns: number;
  tokens: number;
  budgetTokens: number;
}

export interface CarryMeta {
  fromEngine: string;
  fromModel?: string;
  toEngine: string;
  transcriptPath?: string;
  /** The old session's own transcript file, kept where its engine wrote it. */
  rawTranscriptPath?: string;
  compacted: boolean;
}

/**
 * The carried context as one text: a short header, the summary (when compacted),
 * then every turn in order. Turns that do not fit `budgetTokens` are left out
 * oldest first; the summary is kept (only its own head is cut when it alone is too big).
 */
export async function renderCarriedContext(
  messages: readonly SessionHistoryMessage[], meta: CarryMeta, budgetTokens: number,
): Promise<CarriedContext> {
  const { head, turns } = splitTurns(messages);
  const headText = head.map((m) => renderRow(m)).join('\n\n');
  const rendered: string[] = [];
  for (let i = 0; i < turns.length; i++) {
    if (i % 50 === 49) await tick();
    rendered.push(turns[i].map((m) => renderRow(m)).join('\n\n'));
  }
  const costs = rendered.map(estimateTokens);
  const fixed = 400; // the header and the notes
  let headKept = headText;
  let budget = budgetTokens - fixed - estimateTokens(headText);
  if (budget < 0) {
    // The summary alone is over: keep its newest part.
    const share = Math.max(0, budgetTokens - fixed) / Math.max(1, estimateTokens(headText));
    headKept = `[... the start of the summary was cut to fit]\n${headText.slice(Math.floor(headText.length * (1 - share)))}`;
    budget = 0;
  }
  let first = rendered.length;
  for (let i = rendered.length - 1; i >= 0; i--) {
    if (costs[i] > budget) break;
    budget -= costs[i];
    first = i;
  }
  // The newest turn always goes, cut to the budget, so the new engine knows where things stand.
  const kept = rendered.slice(first);
  if (kept.length === 0 && rendered.length > 0) {
    const last = rendered[rendered.length - 1];
    const room = Math.max(2000, Math.floor((budgetTokens - fixed) * 3));
    kept.push(last.length > room ? `[... the start of this turn was cut to fit]\n${last.slice(last.length - room)}` : last);
    first = rendered.length - 1;
  }
  const trimmedTurns = first;
  const from = `${engineCaps(meta.fromEngine as never).displayName}${meta.fromModel ? ` (${meta.fromModel})` : ''}`;
  const lines: string[] = [
    `The user switched this task from ${from} to ${engineCaps(meta.toEngine as never).displayName}. You take the conversation over: below is everything the earlier session had in its context, `
      + `${meta.compacted ? 'its compaction summary and then every turn after it' : 'every turn'}, in order (the newest last). `
      + 'Continue from where it stands; do not redo work it already did. The user\'s new message follows the context.',
  ];
  if (trimmedTurns > 0) {
    lines.push(`${trimmedTurns} older turn${trimmedTurns === 1 ? '' : 's'} after the summary did not fit your context window and ${trimmedTurns === 1 ? 'is' : 'are'} left out here.`);
  }
  if (meta.transcriptPath) lines.push(`The full transcript, from the very start, is at ${meta.transcriptPath}; read it (newest part first) when you need something older.`);
  if (meta.rawTranscriptPath) lines.push(`The earlier session's own transcript file is still at ${meta.rawTranscriptPath}.`);
  lines.push('Paths, branches and results in it are from this same task; check live state before relying on it.');
  const body = [headKept, ...(trimmedTurns > 0 ? [`[${trimmedTurns} older turn${trimmedTurns === 1 ? '' : 's'} left out here]`] : []), ...kept]
    .filter((p) => p.trim());
  const text = `${lines.join(' ')}\n\n${body.length ? body.join('\n\n') : '[The earlier session held no conversation yet.]'}`;
  return { text, carriedTurns: kept.length, trimmedTurns, tokens: estimateTokens(text), budgetTokens };
}

const DEFAULT_WINDOWS: Record<string, number> = { codex: 258_000, gemini: 1_000_000 };
const CLAUDE_DEFAULT_WINDOW = 200_000;
const OTHER_DEFAULT_WINDOW = 128_000;

/**
 * The target engine's context window, as well as Walnut can know it before the
 * session exists: a window a session of that engine and model on that host
 * reported, else the model id's own marker (Claude's `[1m]`), else the
 * engine's documented default.
 */
export async function targetWindowTokens(
  engine: string, model: string | undefined, host: string, earlier: readonly SessionRecord[],
): Promise<number> {
  const target = resolveEngine(engine as never);
  const same = earlier
    .filter((r) => resolveEngine(r.engine) === target && (r.host || '__local__') === (host || '__local__') && r.modelMaxWindow)
    .filter((r) => !model || model === 'default' || (r.cliModel || r.model || r.acpModel) === model)
    .sort((a, b) => (b.lastActiveAt ?? '').localeCompare(a.lastActiveAt ?? ''))[0];
  if (same?.modelMaxWindow) return Math.min(same.modelMaxWindow, same.autoCompactAt ?? Infinity);
  try {
    const { recallModelWindow } = await import('../../providers/context-window.js');
    const known = model ? recallModelWindow(host, model) : undefined;
    if (known) return known;
  } catch { /* defaults below */ }
  if (!isAcpEngine(target)) return model?.toLowerCase().includes('[1m]') ? 1_000_000 : CLAUDE_DEFAULT_WINDOW;
  return DEFAULT_WINDOWS[target] ?? OTHER_DEFAULT_WINDOW;
}
