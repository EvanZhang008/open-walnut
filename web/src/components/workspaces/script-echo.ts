/**
 * The Scripts menu types a long line into the session's terminal (a subshell, a
 * folder check, an end line: src/core/workspaces/script-line.ts), and the shell
 * echoes all of it, three to five wrapped rows before the script's own output.
 * The line starts by printing an undrawn mark, `ESC ] 1337 ; walnut-run-start=<id> BEL`:
 * from the echo's first word up to that mark the terminal draws nothing of the
 * echo, and shows the script's own command in its place.
 *
 * It fails open. Output before the echo begins (a prompt) passes as it is, and
 * when the mark does not come in time (a program in the foreground took the
 * typed text) everything held back is drawn unchanged; so is an echo that holds
 * another run's end line (a line typed while that run still ran). Mode switches
 * inside the echo (bracketed paste on or off) are still passed on.
 *
 * A terminal that attaches again (a reload, a reopened app) replays its earlier
 * output, echoes of earlier runs included: each echo followed by its mark is
 * hidden the same way, with the command that run had (kept in localStorage), or
 * its name when this browser never ran it.
 */

// eslint-disable-next-line no-control-regex
const MODE = /\x1b\[\?[0-9;]*[hl]/g;
/** The run line's first word, as the shell echoes it (a highlighter may color it, never split it). */
const ECHO_START = 'printf';
/** How long a terminal that is still opening may take to echo the line. */
const OPEN_MS = 20_000;
/** How long the mark may take once the echo began. */
const HOLD_MS = 4_000;

interface Pending {
  runId: string;
  shown: string;
  /** Output since the echo began (held back), or null while it has not begun. */
  held: string | null;
  /** Output before the echo began that may still hold the start of its first word. */
  carry: string;
  timer: ReturnType<typeof setTimeout> | null;
  write: ((s: string) => void) | null;
  /** The echo naming this run was seen: from then on only the mark is awaited. */
  seen: boolean;
  /** When the whole wait ends, the echo seen or not. */
  deadline: number;
}

const pending = new Map<string, Pending>();

// eslint-disable-next-line no-control-regex
const START_MARK = /\x1b\]1337;walnut-run-start=([A-Za-z0-9-]{1,40})\x07/g;
// eslint-disable-next-line no-control-regex
const END_MARK = '\x1b]1337;walnut-run=';
/** What follows the echo's first word in a run line (src/core/workspaces/script-line.ts). */
const ECHO_REST = " '\\033]1337;walnut-run-start=%s";
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>]/g;
/** How long a replayed echo cut between two chunks is held for the rest. */
const REPLAY_HOLD_MS = 150;
/** How far before its mark a replayed echo may begin (a long command wraps to many rows). */
const ECHO_REACH = 16 * 1024;

/** The command each run showed, so a replayed echo shows it again. */
const RUNS_KEY = 'walnut.scriptEcho.runs';
const RUNS_KEEP = 200;
function runStore(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}
function knownRuns(): Array<[string, string]> {
  try {
    const rows = JSON.parse(runStore()?.getItem(RUNS_KEY) ?? '[]') as Array<[string, string]>;
    return Array.isArray(rows) ? rows.filter((r) => Array.isArray(r) && typeof r[0] === 'string' && typeof r[1] === 'string') : [];
  } catch { return []; }
}
function rememberRun(runId: string, shown: string): void {
  try {
    const rows = knownRuns().filter(([id]) => id !== runId);
    rows.push([runId, shown]);
    runStore()?.setItem(RUNS_KEY, JSON.stringify(rows.slice(-RUNS_KEEP)));
  } catch { /* storage full or off: a replay shows the name instead */ }
}

/** What a replayed echo of this run shows: its command, else the name its end line names. */
function shownFor(runId: string, echo: string): string {
  const known = knownRuns().find(([id]) => id === runId);
  if (known) return known[1];
  const plain = echo.replace(ANSI, '');
  const m = plain.match(new RegExp(`'${runId}' '((?:[^']|'\\\\'')*)' "\\$\\?"`));
  return m ? `\x1b[1m${m[1].replace(/'\\''/g, "'")}\x1b[0m\r\n` : '';
}

/** Every echo in `text` followed by its own mark (but `except`'s), replaced by what that run shows. */
function hideEchoes(text: string, except?: string): string {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(START_MARK)) {
    const at = m.index ?? 0;
    const id = m[1];
    if (id === except) continue;
    const floor = Math.max(last, at - ECHO_REACH);
    // The id's first mention is the argument of the line's first printf.
    const named = text.indexOf(`'${id}'`, floor);
    const from = named >= 0 && named < at ? text.lastIndexOf(ECHO_START, named) : -1;
    if (from < floor) continue;
    const echo = text.slice(from, at);
    if (!pureEcho(echo)) continue;
    out += text.slice(last, from) + (echo.match(MODE) ?? []).join('') + shownFor(id, echo);
    last = at + m[0].length;
  }
  return last ? out + text.slice(last) : text;
}

/**
 * Only the typed line itself is hidden: one run line, ending where the line ends.
 * A line typed while something still ran in the foreground (another run, or a
 * command typed by hand) is echoed by the terminal at once and again by the shell
 * later, with that command's output between the two: that is drawn as it came.
 */
function pureEcho(echo: string): boolean {
  if (echo.includes(END_MARK)) return false;
  const plain = echo.replace(ANSI, '');
  const first = plain.indexOf(ECHO_REST);
  const again = plain.indexOf(ECHO_REST, first + 1);
  if (again < 0) return true;
  // A shell that redraws the line (a highlighter) does so on the same rows; output starts a new one.
  const lineEnd = plain.indexOf('"$?"', first);
  return lineEnd < 0 || lineEnd > again || !/\n/.test(plain.slice(lineEnd, again));
}

/** The start of a run line's echo at or before `pos`: a first word followed by the line's own text (its last printf is not one). */
function echoStartBefore(text: string, pos: number, partialOk: boolean): number {
  let from = text.lastIndexOf(ECHO_START, pos);
  for (let n = 0; from >= 0 && n < 16 && pos - from < ECHO_REACH; n++) {
    const after = text.slice(from + ECHO_START.length, from + ECHO_START.length + 400).replace(ANSI, '');
    if (after.startsWith(ECHO_REST) || (partialOk && ECHO_REST.startsWith(after))) return from;
    from = from > 0 ? text.lastIndexOf(ECHO_START, from - 1) : -1;
  }
  return -1;
}

/** Where an echo that has not reached its mark yet begins at the end of `text`, or -1. */
function openEchoAt(text: string, partialOk: boolean): number {
  return echoStartBefore(text, text.length, partialOk);
}

interface Replay { sessionId: string; carry: string; timer: ReturnType<typeof setTimeout> | null; write: (s: string) => void }
/** Per terminal (its writer): two terminals of one session never share a held tail. */
const replays = new Map<(s: string) => void, Replay>();

function releaseReplay(write: (s: string) => void): void {
  const r = replays.get(write);
  if (!r) return;
  replays.delete(write);
  if (r.timer) clearTimeout(r.timer);
  if (r.carry) r.write(r.carry);
}

function releaseSessionReplays(sessionId: string): void {
  for (const [w, r] of [...replays]) if (r.sessionId === sessionId) releaseReplay(w);
}

/** Below this, a chunk is typing (a key or a few echoed back), never a replay cut mid-echo: it is drawn at once. */
const REPLAY_CHUNK = 32;

/** Output while no run of the menu is awaited: earlier runs' echoes (a replay) are hidden. */
function passReplay(sessionId: string, data: string, write: (s: string) => void): void {
  const r = replays.get(write);
  if (r?.timer) clearTimeout(r.timer);
  replays.delete(write);
  const raw = (r?.carry ?? '') + data;
  const bulk = raw.length >= REPLAY_CHUNK;
  const text = hideEchoes(raw);
  const open = openEchoAt(text, bulk);
  const keep = open >= 0 ? text.length - open : bulk ? partialStart(text) : 0;
  if (keep === 0 || keep > 64 * 1024) { write(text); return; }
  write(text.slice(0, text.length - keep));
  const next: Replay = { sessionId, carry: text.slice(text.length - keep), timer: null, write };
  next.timer = setTimeout(() => { if (replays.get(write) === next) releaseReplay(write); }, REPLAY_HOLD_MS);
  replays.set(write, next);
}

/** What the terminal shows for the script's command: its first line, bold. */
export function shownCommand(command: string): string {
  const lines = command.replace(/\r\n?/g, '\n').trim().split('\n');
  const first = lines[0] ?? '';
  return `\x1b[1m${first}${lines.length > 1 ? ' …' : ''}\x1b[0m\r\n`;
}

/** The menu typed this run's line: hide its echo in this session's terminal. */
export function expectScriptEcho(sessionId: string, runId: string, command: string): void {
  const old = pending.get(sessionId);
  if (old) flush(sessionId, old);
  releaseSessionReplays(sessionId);
  rememberRun(runId, shownCommand(command));
  const p: Pending = { runId, shown: shownCommand(command), held: null, carry: '', timer: null, write: null, seen: false, deadline: Date.now() + OPEN_MS };
  p.timer = setTimeout(() => { if (pending.get(sessionId) === p) flush(sessionId, p); }, OPEN_MS);
  pending.set(sessionId, p);
}

/** How much of the end of `text` could be the start of the echo's first word. */
function partialStart(text: string): number {
  for (let n = Math.min(text.length, ECHO_START.length - 1); n > 0; n--) {
    if (ECHO_START.startsWith(text.slice(text.length - n))) return n;
  }
  return 0;
}

function flush(sessionId: string, p: Pending): void {
  if (p.timer) clearTimeout(p.timer);
  pending.delete(sessionId);
  const rest = p.carry + (p.held ?? '');
  if (rest && p.write) p.write(rest);
}

/**
 * Feed terminal output through it: `write` draws what the terminal should show
 * (now, or later when a held echo is let go).
 */
export function filterScriptEcho(sessionId: string, data: string, write: (s: string) => void): void {
  const p = pending.get(sessionId);
  if (!p) { passReplay(sessionId, data, write); return; }
  p.write = write;
  // Earlier runs' echoes (a replay) are hidden first, so only this run's can be open.
  const text = hideEchoes((p.held ?? p.carry) + data, p.runId);
  p.carry = '';
  // Our echo is the line naming this run's id ('<id>' after its first word). Until it
  // shows, only the last first-word seen may be its start: everything before goes out
  // (a reattached terminal replays earlier runs' echoes, each starting with the same word).
  const own = text.indexOf(`'${p.runId}'`);
  const from = own >= 0 ? text.lastIndexOf(ECHO_START, own) : echoStartBefore(text, text.length, true);
  if (from < 0) {
    const keep = partialStart(text);
    write(text.slice(0, text.length - keep));
    p.carry = text.slice(text.length - keep);
    p.held = null;
    return;
  }
  if (from > 0) write(text.slice(0, from));
  const wasHeld = p.held !== null;
  p.held = text.slice(from);
  if (own >= 0 && !p.seen) {
    p.seen = true;
    if (p.timer) clearTimeout(p.timer);
    p.timer = setTimeout(() => { if (pending.get(sessionId) === p) flush(sessionId, p); }, HOLD_MS);
  } else if (!wasHeld && !p.seen) {
    // A first word that is not (yet) ours: let it go soon if nothing names this run.
    if (p.timer) clearTimeout(p.timer);
    p.timer = setTimeout(() => { if (pending.get(sessionId) === p) release(sessionId, p); }, HOLD_MS);
  }
  const mark = `\x1b]1337;walnut-run-start=${p.runId}\x07`;
  const at = p.held.indexOf(mark);
  if (at < 0) {
    if (p.held.length > 64 * 1024) flush(sessionId, p);
    return;
  }
  if (p.timer) clearTimeout(p.timer);
  pending.delete(sessionId);
  const echo = p.held.slice(0, at);
  const rest = p.held.slice(at + mark.length);
  // Typed while something still ran: the echo holds that command's last output.
  if (!pureEcho(echo)) { write(echo + rest); return; }
  const modes = (echo.match(MODE) ?? []).join('');
  write(modes + p.shown + rest);
}

/** Held text that never named this run: draw it, and keep waiting for the echo until the open deadline. */
function release(sessionId: string, p: Pending): void {
  const rest = p.held ?? '';
  p.held = null;
  if (rest && p.write) p.write(rest);
  if (p.timer) clearTimeout(p.timer);
  p.timer = setTimeout(() => { if (pending.get(sessionId) === p) flush(sessionId, p); }, Math.max(0, p.deadline - Date.now()));
}

/** The terminal went away: nothing more of the echo will come. */
export function dropScriptEcho(sessionId: string, write?: (s: string) => void): void {
  const p = pending.get(sessionId);
  if (p) flush(sessionId, p);
  if (write) releaseReplay(write);
  else releaseSessionReplays(sessionId);
}

/** Tests only. */
export function __resetScriptEcho(): void {
  for (const p of pending.values()) if (p.timer) clearTimeout(p.timer);
  pending.clear();
  for (const r of replays.values()) if (r.timer) clearTimeout(r.timer);
  replays.clear();
  try { runStore()?.removeItem(RUNS_KEY); } catch { /* none */ }
}
