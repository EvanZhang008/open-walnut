/**
 * Forensic Observability — evidence bundle capture.
 *
 * When an incident opens, the felt bug ("delivery stalled", "silent success",
 * "UI flashed") usually can't be reproduced and the logs that prove it rotate
 * out within a day or two. captureBundle() freezes ALL-LAYER evidence for one
 * sessionId into a single directory the moment the incident fires, so the
 * investigation later is "open the bundle" instead of hours of cross-layer grep.
 *
 * It mirrors the exact sources scripts/walnut-logs.sh already greps — server
 * JSON log, daemon log, the CLI's .jsonl stream, the CLI's own --debug file —
 * plus the wide `obs` turn events. Pure read + write into the bundle dir; it
 * never mutates a source log, and any missing file is noted, never thrown.
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { CLAUDE_HOME, LOG_DIR, SESSION_STREAMS_DIR } from '../../constants.js';
import { log } from '../../logging/index.js';

/**
 * Stream a file line-by-line, collecting the lines `keep` accepts.
 * The dated server logs run 40-60MB by end of day; the old readFileSync here
 * blocked the WHOLE event loop for the entire read+split (every in-flight HTTP
 * request stalled, not just this one). Streaming yields between chunks, so a
 * bundle capture is now invisible to concurrent requests. Missing/unreadable
 * file → empty array, matching the old catch-and-skip semantics.
 */
export async function grepFileLines(file: string, keep: (line: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  try {
    const rl = readline.createInterface({
      input: fs.createReadStream(file, { encoding: 'utf-8' }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (keep(line)) out.push(line);
    }
  } catch {
    return out; // partial results are fine — bundle capture is best-effort
  }
  return out;
}

/** Default look-back window for server/turn log lines. */
const DEFAULT_WINDOW_MINS = 60;
/** How many tail lines to keep from line-oriented streams (jsonl, debug). */
const TAIL_LINES = 200;

interface BundleMeta {
  sessionId: string;
  capturedAt: string;
  windowMins: number;
  filesIncluded: string[];
  notesIfMissing: string[];
}

/**
 * Capture an all-layer evidence bundle for a session into
 * `LOG_DIR/incidents/<sessionId>-<ts>` and return that absolute dir path.
 * Lives under LOG_DIR (/tmp/open-walnut) — same place as the source logs it
 * copies — NOT under WALNUT_HOME, which git-sync commits every 30s. An evidence
 * bundle is an ephemeral forensic dump; it must never enter version control.
 * Defensive: a missing/unreadable source is recorded in meta.notesIfMissing
 * rather than thrown — the bundle is best-effort by design.
 */
export async function captureBundle(
  sessionId: string,
  opts?: { windowMins?: number },
): Promise<string> {
  const windowMins = opts?.windowMins ?? DEFAULT_WINDOW_MINS;
  const ts = Date.now();
  const dir = path.join(LOG_DIR, 'incidents', `${sessionId}-${ts}`);

  const meta: BundleMeta = {
    sessionId,
    capturedAt: new Date(ts).toISOString(),
    windowMins,
    filesIncluded: [],
    notesIfMissing: [],
  };

  // Record a produced artifact (only counts non-empty writes as "included").
  const writeArtifact = (name: string, content: string, emptyNote: string) => {
    try {
      if (content.trim().length === 0) {
        meta.notesIfMissing.push(emptyNote);
        return;
      }
      fs.writeFileSync(path.join(dir, name), content);
      meta.filesIncluded.push(name);
    } catch (err) {
      meta.notesIfMissing.push(`${name}: write failed (${errMsg(err)})`);
    }
  };

  try {
    fs.mkdirSync(dir, { recursive: true });

    const cutoffMs = ts - windowMins * 60_000;
    const recent = recentLogFiles();

    // 1. server.log.txt — sid-mentioning lines from the 1-2 most recent dated
    //    logs, filtered to the window. (UTC-vs-local-date gotcha: a session
    //    active across UTC-midnight is split over two files — scan both.)
    writeArtifact(
      'server.log.txt',
      await grepDatedLogs(recent, sessionId, cutoffMs, () => true),
      `server.log.txt: no lines mention ${sessionId} in the last ${windowMins}min (scanned ${recent.length} dated logs)`,
    );

    // 2. cli.jsonl.tail.txt — last ~200 lines of the CLI stream, + .err tail.
    writeArtifact('cli.jsonl.tail.txt', captureCliJsonl(sessionId, meta), `cli.jsonl.tail.txt: no .jsonl stream found for ${sessionId}`);

    // 3. cli-debug.txt — last ~200 lines of the CLI's own --debug file.
    writeArtifact(
      'cli-debug.txt',
      tailFile(path.join(CLAUDE_HOME, 'debug', `${sessionId}.txt`), TAIL_LINES),
      `cli-debug.txt: no ${path.join(CLAUDE_HOME, 'debug', `${sessionId}.txt`)} (CLI debug log; remote sessions write it on the remote host)`,
    );

    // 4. daemon.log.txt — sid-mentioning lines across every daemon-d-*.log.
    writeArtifact('daemon.log.txt', await captureDaemonLogs(sessionId), `daemon.log.txt: no daemon-d-*.log mentions ${sessionId}`);

    // 5. turn-events.txt — the wide `obs` "turn" records for this sid.
    writeArtifact(
      'turn-events.txt',
      await grepDatedLogs(recent, sessionId, cutoffMs, isObsTurnLine),
      `turn-events.txt: no obs turn events for ${sessionId} in the last ${windowMins}min`,
    );

    // 6. host-connectivity.txt — daemon-connection lifecycle lines for the
    //    session's host + live pool state. These lines carry the HOST but not
    //    the sid, so the sid-grep above misses them — which is exactly the
    //    evidence that was absent when an SSH-down window (reconnect stuck on
    //    spawn EBADF) made history reads time out (inc-1783406628291).
    writeArtifact(
      'host-connectivity.txt',
      await captureHostConnectivity(sessionId, recent, cutoffMs),
      'host-connectivity.txt: local session on a healthy pool (no connection lines in window)',
    );

    // 7. process-health.txt — fd count / memory / uptime of THIS process at
    //    capture time. An exhausted fd table explains EBADF-class failures.
    writeArtifact('process-health.txt', await captureProcessHealth(), 'process-health.txt: unavailable');
  } catch (err) {
    // Even the mkdir/orchestration failing must not throw on the incident path.
    meta.notesIfMissing.push(`bundle capture error: ${errMsg(err)}`);
    log.obs.warn('bundle capture failed', { sessionId, error: errMsg(err) });
  }

  // 6. meta.json — always written last so it reflects what actually landed.
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  } catch (err) {
    log.obs.warn('bundle meta write failed', { sessionId, dir, error: errMsg(err) });
  }

  log.obs.info('evidence bundle captured', {
    sessionId,
    dir,
    files: meta.filesIncluded.length,
    missing: meta.notesIfMissing.length,
  });
  return dir;
}

// ── helpers ──

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The 1-2 most recent `open-walnut-<date>.log` files, oldest-first. Mirrors
 * walnut-logs.sh `recent_logs`: timestamps are UTC but filenames use the local
 * date, so a single session can straddle two files — we scan both.
 */
export function recentLogFiles(): string[] {
  let files: string[];
  try {
    files = fs
      .readdirSync(LOG_DIR)
      .filter(f => f.startsWith('open-walnut-') && f.endsWith('.log'))
      .map(f => path.join(LOG_DIR, f));
  } catch {
    return [];
  }
  // Sort by mtime descending, take 2, then reverse to oldest-first.
  return files
    .map(f => ({ f, mtime: safeMtime(f) }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 2)
    .map(x => x.f)
    .reverse();
}

function safeMtime(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Collect lines from the given dated JSON logs that mention `sessionId`, pass
 * the `extra` predicate, and fall within the time window. A line whose `time`
 * we can't parse is KEPT (don't drop evidence over a parse miss); a line older
 * than the cutoff is dropped. Returns them oldest-first across files.
 */
async function grepDatedLogs(
  files: string[],
  sessionId: string,
  cutoffMs: number,
  extra: (line: string) => boolean,
): Promise<string> {
  const out: string[] = [];
  for (const file of files) {
    const hits = await grepFileLines(file, (line) => {
      if (!line.includes(sessionId)) return false;
      if (!extra(line)) return false;
      const t = lineTimeMs(line);
      return !(t !== null && t < cutoffMs); // older than window → drop
    });
    out.push(...hits);
  }
  return out.join('\n');
}

/** Parse the `"time":"...Z"` field (UTC ISO) → epoch ms, or null if absent/unparseable. */
export function lineTimeMs(line: string): number | null {
  const m = line.match(/"time":"([^"]+)"/);
  if (!m) return null;
  const ms = Date.parse(m[1]);
  return Number.isNaN(ms) ? null : ms;
}

/** A structured log line emitted by the recorder's wide turn event. */
function isObsTurnLine(line: string): boolean {
  return line.includes('"subsystem":"obs"') && line.includes('"message":"turn"');
}

/**
 * Tail the session's CLI .jsonl stream (+ its .jsonl.err if present). The stream
 * lives in different dirs depending on session type — local/embedded sessions
 * write to SESSION_STREAMS_DIR (LOG_DIR/streams) while the remote daemon writes
 * to /tmp/open-walnut-streams — so we probe both and use whichever exists.
 */
function captureCliJsonl(sessionId: string, meta: BundleMeta): string {
  const candidates = streamDirs().map(d => path.join(d, `${sessionId}.jsonl`));
  const jsonl = candidates.find(p => fileExists(p));
  if (!jsonl) return '';

  const parts = [`### ${jsonl} (last ${TAIL_LINES} lines)`, tailFile(jsonl, TAIL_LINES)];
  const errPath = `${jsonl}.err`;
  if (fileExists(errPath)) {
    const errTail = tailFile(errPath, TAIL_LINES);
    if (errTail.trim().length > 0) {
      parts.push(`\n### ${errPath} (stderr, last ${TAIL_LINES} lines)`, errTail);
    }
  } else {
    meta.notesIfMissing.push(`${path.basename(errPath)}: not present (no CLI stderr captured)`);
  }
  return parts.join('\n');
}

/** Candidate stream directories, de-duplicated, in probe order. */
function streamDirs(): string[] {
  const dirs = [SESSION_STREAMS_DIR, '/tmp/open-walnut-streams'];
  return [...new Set(dirs)];
}

/** Concatenate sid-mentioning lines from every daemon-d-*.log, labelled by file. */
async function captureDaemonLogs(sessionId: string): Promise<string> {
  let files: string[];
  try {
    files = fs
      .readdirSync(LOG_DIR)
      .filter(f => f.startsWith('daemon-d-') && f.endsWith('.log'))
      .map(f => path.join(LOG_DIR, f));
  } catch {
    return '';
  }
  const blocks: string[] = [];
  for (const file of files) {
    const hits = await grepFileLines(file, l => l.includes(sessionId));
    if (hits.length > 0) blocks.push(`### ${file}`, hits.join('\n'));
  }
  return blocks.join('\n');
}

/**
 * Host-connectivity evidence: current daemon pool state + the DaemonConnection
 * lifecycle lines (connect/reconnect/lost/deploy/EBADF…) for the session's
 * host within the window. Lazy imports so bundle capture never hard-depends
 * on provider modules being loadable.
 */
async function captureHostConnectivity(sessionId: string, recent: string[], cutoffMs: number): Promise<string> {
  const parts: string[] = [];

  let host: string | undefined;
  try {
    const { getSessionByClaudeId } = await import('../session-tracker.js');
    host = (await getSessionByClaudeId(sessionId))?.host;
  } catch { /* record lookup is best-effort */ }

  try {
    const { getDaemonPoolStatus, getDaemonDisconnectedSince } = await import('../../providers/daemon-connection.js');
    const pool = getDaemonPoolStatus().map(s => ({
      ...s,
      disconnectedSince: getDaemonDisconnectedSince(s.host)
        ? new Date(getDaemonDisconnectedSince(s.host)!).toISOString()
        : null,
    }));
    parts.push('### daemon pool state at capture', JSON.stringify({ sessionHost: host ?? '__local__', pool }, null, 2));
  } catch { /* pool state is best-effort */ }

  // Connection lifecycle lines mention the host, not the sid — grep by host.
  if (host) {
    const needle = `"host":"${host}"`;
    const hits = await grepDatedLogs(recent, needle, cutoffMs, l =>
      l.includes('DaemonConnection') || l.includes('EBADF') || l.includes('EMFILE'));
    if (hits.trim().length > 0) parts.push(`### DaemonConnection lines for host=${host} (window)`, hits);
  }

  return parts.join('\n');
}

/** Process resource snapshot (fd count, memory, uptime). */
async function captureProcessHealth(): Promise<string> {
  try {
    const { processHealthSnapshot } = await import('./process-health.js');
    return processHealthSnapshot();
  } catch {
    return '';
  }
}

function fileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Bytes read from the end of a file per tail attempt. Generous for 200 log
 *  lines (~64KB typical); doubles once if the window held too few lines. */
const TAIL_WINDOW_BYTES = 1024 * 1024;

/**
 * Last `n` lines of a file, or '' if missing/unreadable.
 * Reads only a bounded window from the END of the file — session JSONL streams
 * run to 100MB+ and the old whole-file readFileSync blocked the event loop for
 * the full read just to keep 200 lines.
 */
export function tailFile(file: string, n: number): string {
  try {
    const size = fs.statSync(file).size;
    if (size === 0) return '';
    let window = Math.min(size, TAIL_WINDOW_BYTES);
    for (;;) {
      const buf = Buffer.alloc(window);
      const fd = fs.openSync(file, 'r');
      try {
        fs.readSync(fd, buf, 0, window, size - window);
      } finally {
        fs.closeSync(fd);
      }
      const lines = buf.toString('utf-8').split('\n');
      // Drop a trailing empty line from the final newline so the tail isn't blank-padded.
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
      // First line of a mid-file window is almost certainly partial — drop it
      // (unless the window covers the whole file, where it's a real line).
      if (window < size && lines.length > 0) lines.shift();
      if (lines.length >= n || window >= size) return lines.slice(-n).join('\n');
      window = Math.min(size, window * 2); // rare: huge lines — widen once and retry
    }
  } catch {
    return '';
  }
}
