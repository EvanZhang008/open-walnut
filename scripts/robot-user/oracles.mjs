#!/usr/bin/env node
/**
 * Oracles (invariants) for the robot user.
 *
 * These run after EVERY action. The point of a soak test is that we cannot write step
 * assertions for a random walk — instead we assert things that must ALWAYS hold, and let
 * the random walk find the state that breaks one of them.
 *
 * Each oracle returns { name, ok, detail } (plus optional { capture: true } to ask the
 * runner for a screenshot + hierarchy dump). A failing oracle never stops the episode; it
 * is appended to anomalies[] so the whole run keeps producing evidence.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const IOS_CLIENT_LOG_DIR = '/tmp/open-walnut/ios-client';
const DIAGNOSTIC_REPORTS = path.join(os.homedir(), 'Library', 'Logs', 'DiagnosticReports');

const ok = (name, detail) => ({ name, ok: true, detail: detail ?? null });
const bad = (name, detail, extra = {}) => ({ name, ok: false, detail, ...extra });

/** iPhone-class logical screen used to normalise bounds into bands. */
const SCREEN_W = 402;
const SCREEN_H = 874;

/**
 * Text rows that live INSIDE the scrollable conversation area — i.e. the message bubbles.
 * Excludes the root/window container (its accessibilityText is the screen title and its
 * bounds cover the whole screen), control rows (they carry a resource-id), the nav bar, and
 * the composer band. Without this filter the nav title alone keeps a blank screen "non-blank".
 */
function scrollAreaTextRows(rows) {
  return (rows || []).filter((r) => {
    if (r.id) return false;
    if (!r.text || r.text.trim().length < 2) return false;
    if (!r.bounds) return false;
    const { y, y2, w, h } = r.bounds;
    if (w >= SCREEN_W && h >= SCREEN_H) return false;   // full-screen container
    if (y2 <= SCREEN_H * 0.13) return false;            // nav bar
    if (y >= SCREEN_H * 0.86) return false;             // composer / tab bar band
    return true;
  });
}

/** "iPhone 16 Pro Stress2" -> "iPhone-16-Pro-Stress2" (how the client names its log file). */
export function logSlug(deviceName) {
  return String(deviceName || '').trim().replace(/\s+/g, '-');
}

/**
 * Names this device may log under. One physical simulator uploads under BOTH its simctl
 * display name and whatever name the build was paired with (e.g. "iPhone 16 Pro Stress2"
 * and "sim-stress2"), so a single-name match silently misses half the telemetry.
 */
export function deviceLogNames(deviceName, extraNames = []) {
  const names = new Set();
  for (const n of [deviceName, ...extraNames]) {
    if (!n) continue;
    names.add(String(n).trim());
    names.add(logSlug(n));
  }
  return [...names].filter(Boolean);
}

/** Parse a client-log ISO timestamp to epoch ms; null when absent/unparseable. */
function parseTs(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * @param {object} opts
 * @param {string} opts.deviceName   device name as it appears in the uploaded client log
 * @param {string} [opts.serverUrl]  e.g. http://localhost:3456
 * @param {number} opts.startedAt    episode start (epoch ms)
 * @param {string} [opts.logDir]     override the ios-client log dir (tests)
 * @param {string} [opts.reportsDir] override DiagnosticReports (tests)
 * @param {Function} [opts.fetchImpl]
 * @param {string[]} [opts.extraDeviceNames] other names this device uploads logs under
 * @param {number} [opts.baselineMs] pre-seeded hierarchy-read baseline (see setBaseline)
 */
export function createOracles(opts) {
  const {
    deviceName,
    serverUrl = 'http://localhost:3456',
    startedAt = Date.now(),
    logDir = IOS_CLIENT_LOG_DIR,
    reportsDir = DIAGNOSTIC_REPORTS,
    fetchImpl = globalThis.fetch,
    extraDeviceNames = [],
  } = opts || {};

  // ── per-oracle memory ──
  const logOffsets = new Map();     // log path -> bytes already consumed
  const maxRowsSeen = new Map();    // screen key -> max content-row count ever observed
  const seenReports = new Set();    // crash report filenames already reported
  let pendingStreak = 0;
  let consecutiveActionFailures = 0;
  let logOffsetsPrimed = false;
  let baselineMs = typeof opts.baselineMs === 'number' ? opts.baselineMs : null;

  /**
   * Every log file this device may write to, found by GLOBBING the directory rather than by
   * predicting filenames.
   *
   * Do not go back to building `<name>-<today>.log` strings: the client names the file with
   * the UTC date while the harness computed a LOCAL date, so a run starting at 23:48 local
   * (06:48 UTC) primed `…-07-24.log` and never primed the `…-07-25.log` the device was
   * actually writing. When local midnight passed, that unprimed file entered the candidate
   * list at offset 0 and the whole day of pre-existing lines was replayed as "new" — which is
   * exactly how a 05:10Z freeze got reported by an episode that started at 06:48Z.
   */
  function candidateLogPaths() {
    const names = deviceLogNames(deviceName, extraDeviceNames);
    if (names.length === 0) return [];
    let entries = [];
    try { entries = fs.readdirSync(logDir); } catch { return []; }
    return entries
      .filter((f) => f.endsWith('.log') && names.some((n) => f.startsWith(`${n}-`)))
      .map((f) => path.join(logDir, f));
  }

  /**
   * Prime offsets to current EOF. Called once before step 1 and, crucially, re-applied to any
   * file that appears LATER in the run: a file we have never seen before is pre-existing from
   * this oracle's point of view, so it is primed to EOF instead of read from byte 0.
   */
  function primeLogOffsets() {
    for (const p of candidateLogPaths()) {
      if (logOffsets.has(p)) continue;
      try { logOffsets.set(p, fs.statSync(p).size); } catch { logOffsets.set(p, 0); }
    }
    logOffsetsPrimed = true;
  }

  function readNewLogLines() {
    const firstPass = !logOffsetsPrimed;
    if (firstPass) primeLogOffsets();
    const lines = [];
    for (const p of candidateLogPaths()) {
      let size;
      try { size = fs.statSync(p).size; } catch { continue; }
      if (!logOffsets.has(p)) {
        // Newly appeared file. Anything already in it predates our discovery of it, so start
        // at EOF; only what the device appends from now on counts as new.
        logOffsets.set(p, size);
        continue;
      }
      const from = logOffsets.get(p);
      if (size <= from) {
        // Truncated/rotated: resync to the new EOF rather than re-reading from 0.
        logOffsets.set(p, size);
        continue;
      }
      let chunk = '';
      try {
        const fd = fs.openSync(p, 'r');
        const buf = Buffer.alloc(size - from);
        fs.readSync(fd, buf, 0, buf.length, from);
        fs.closeSync(fd);
        chunk = buf.toString('utf8');
      } catch { continue; }
      logOffsets.set(p, size);
      for (const line of chunk.split('\n')) if (line.trim()) lines.push({ file: p, line });
    }
    return lines;
  }

  // ── oracles ──

  function freezeTelemetry() {
    const hits = [];
    let staleSkipped = 0;
    // Small grace window: the client stamps `ts` when the stall is DETECTED, which can be a
    // beat before our startedAt on a run that begins right as the app settles.
    const tsFloor = startedAt - 5000;
    for (const { file, line } of readNewLogLines()) {
      let rec = null;
      try { rec = JSON.parse(line); } catch { /* not JSON — fall back to substring match */ }
      const subsystem = rec ? rec.subsystem : (/"subsystem":"(\w+)"/.exec(line) || [])[1];
      const message = rec ? String(rec.message || '') : line;
      const rawTs = rec ? rec.ts : (/"ts":"([^"]+)"/.exec(line) || [])[1];
      const isCrash = subsystem === 'crash';
      const isFreeze = subsystem === 'freeze' && /main thread unresponsive/i.test(message);
      if (!isCrash && !isFreeze) continue;
      // Belt and suspenders over the byte-offset tailing: even if a file is re-read from 0
      // for any reason, a line stamped before this episode started can never be our anomaly.
      const tsMs = parseTs(rawTs);
      if (tsMs !== null && tsMs < tsFloor) { staleSkipped += 1; continue; }
      hits.push(isCrash
        ? { kind: 'crash', file: path.basename(file), message: message.slice(0, 200), ts: rawTs }
        : { kind: 'freeze', file: path.basename(file), stalledSeconds: rec ? rec.m_stalledSeconds : null, ts: rawTs });
    }
    if (hits.length === 0) return ok('freezeTelemetry', staleSkipped ? { staleSkipped } : null);
    return bad('freezeTelemetry', { hits, staleSkipped }, { capture: true });
  }

  function crashArtifacts() {
    let entries = [];
    try { entries = fs.readdirSync(reportsDir); } catch { return ok('crashArtifacts', { reportsDir: 'unreadable' }); }
    const fresh = [];
    for (const name of entries) {
      if (!/walnut/i.test(name) || seenReports.has(name)) continue;
      let st;
      try { st = fs.statSync(path.join(reportsDir, name)); } catch { continue; }
      if (st.mtimeMs >= startedAt) { seenReports.add(name); fresh.push(name); }
    }
    if (fresh.length === 0) return ok('crashArtifacts');
    return bad('crashArtifacts', { reports: fresh, dir: reportsDir }, { capture: true });
  }

  /**
   * Blank-screen bug class: we are on a chat-like screen that used to render rows and now
   * renders none. Requires having seen > 3 rows on this screen before, so a genuinely empty
   * conversation is not reported.
   */
  function blankTimeline(rows, state) {
    const isChatLike = rows.some((r) => r.id === 'chat.composer');
    if (!isChatLike) return ok('blankTimeline', { skipped: 'not-chat-like' });
    const key = `chat:${state && state.tab ? state.tab : 'Chat'}`;
    const textRows = scrollAreaTextRows(rows);
    const prevMax = maxRowsSeen.get(key) || 0;
    if (textRows.length < 1 && prevMax > 3) {
      return bad('blankTimeline', { screen: key, rows: textRows.length, previousMax: prevMax }, { capture: true });
    }
    if (textRows.length > prevMax) maxRowsSeen.set(key, textRows.length);
    return ok('blankTimeline', { rows: textRows.length, max: maxRowsSeen.get(key) || 0 });
  }

  /**
   * Freeze suspicion: a hierarchy read that is slow RELATIVE TO THIS RIG, or two timing-out
   * actions in a row.
   *
   * A raw 3000 ms threshold measures the maestro CLI, not the app: every inspectHierarchy
   * pays a runner spawn + MCP roundtrip, which on a real simulator is 3-20 s all by itself,
   * so a fixed 3 s flagged 17 of 17 steps in the first pilot while every judge verdict said
   * the app was healthy. Instead we calibrate: `setBaseline()` records the median of a few
   * idle reads before step 1, and we only flag above max(3000, baseline * 2.5) — i.e. a read
   * that is meaningfully slower than this rig's own floor.
   */
  function setBaseline(ms) {
    baselineMs = typeof ms === 'number' && ms > 0 ? ms : null;
    return baselineMs;
  }

  function responsivenessThreshold() {
    return baselineMs ? Math.max(3000, Math.round(baselineMs * 2.5)) : 3000;
  }

  function responsiveness(hierarchyMs, lastAction) {
    const timedOut = !!(lastAction && lastAction.ok === false && /timed out|ETIMEDOUT|timeout/i.test(String(lastAction.error || '')));
    consecutiveActionFailures = timedOut ? consecutiveActionFailures + 1 : 0;
    const threshold = responsivenessThreshold();
    if (typeof hierarchyMs === 'number' && hierarchyMs > threshold) {
      return bad('responsiveness', {
        hierarchyMs, threshold, baselineMs,
        reason: `post-action hierarchy ${hierarchyMs}ms > ${threshold}ms (baseline ${baselineMs ?? 'uncalibrated'})`,
      }, { capture: true });
    }
    if (consecutiveActionFailures >= 2) {
      return bad('responsiveness', { consecutiveTimeouts: consecutiveActionFailures, reason: 'two consecutive action timeouts' }, { capture: true });
    }
    return ok('responsiveness', { hierarchyMs: hierarchyMs ?? null, threshold, baselineMs });
  }

  /** A "Waiting for reply"/pending marker that never clears (~6 checks ≈ 2 min). */
  function stuckPending(rows) {
    const hit = rows.find((r) => r.text && /Waiting for reply|pending/i.test(r.text));
    if (!hit) { pendingStreak = 0; return ok('stuckPending'); }
    pendingStreak += 1;
    if (pendingStreak > 6) {
      return bad('stuckPending', { checks: pendingStreak, text: hit.text.slice(0, 120) }, { capture: true });
    }
    return ok('stuckPending', { streak: pendingStreak });
  }

  /** The app claims offline while the server answers 200 — a client-side connectivity bug. */
  async function offlineWhileHealthy(rows) {
    const banner = rows.find((r) => r.text && /unreachable — read-only|unreachable — |offline/i.test(r.text));
    if (!banner) return ok('offlineWhileHealthy');
    if (typeof fetchImpl !== 'function') return ok('offlineWhileHealthy', { skipped: 'no-fetch' });
    const headers = {};
    if (process.env.WALNUT_ROBOT_TOKEN) headers.Authorization = `Bearer ${process.env.WALNUT_ROBOT_TOKEN}`;
    let status = 0;
    try {
      const ctl = AbortSignal.timeout ? AbortSignal.timeout(5000) : undefined;
      const res = await fetchImpl(`${serverUrl.replace(/\/$/, '')}/api/v1/status`, { headers, signal: ctl });
      status = res.status;
    } catch (e) {
      return ok('offlineWhileHealthy', { serverError: String(e && e.message).slice(0, 120) });
    }
    if (status === 200) {
      return bad('offlineWhileHealthy', { banner: banner.text.slice(0, 120), serverStatus: status }, { capture: true });
    }
    return ok('offlineWhileHealthy', { serverStatus: status });
  }

  /**
   * Run every oracle.
   * @param {{ rows: Array, hierarchyMs?: number, lastAction?: object, state?: object }} ctx
   */
  async function runAll(ctx) {
    const rows = (ctx && ctx.rows) || [];
    const results = [
      freezeTelemetry(),
      crashArtifacts(),
      blankTimeline(rows, (ctx && ctx.state) || {}),
      responsiveness(ctx && ctx.hierarchyMs, ctx && ctx.lastAction),
      stuckPending(rows),
      await offlineWhileHealthy(rows),
    ];
    return results;
  }

  return {
    runAll,
    setBaseline,
    responsivenessThreshold,
    get baselineMs() { return baselineMs; },
    candidateLogPaths,
    primeLogOffsets,
    scrollAreaTextRows,
    // exported individually so they can be unit-tested against fixture hierarchies
    freezeTelemetry,
    crashArtifacts,
    blankTimeline,
    responsiveness,
    stuckPending,
    offlineWhileHealthy,
  };
}
