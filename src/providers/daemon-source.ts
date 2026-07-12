/**
 * walnut-daemon.js — Embedded source code for the remote daemon server.
 *
 * ARCHITECTURE:
 * This file contains the daemon source as a string constant. When connecting
 * to a remote host, DaemonConnection:
 *   1. Deploys this code via SSH (cat > /tmp/open-walnut/daemon.cjs)
 *   2. Starts it (node /tmp/open-walnut/daemon.cjs --start)
 *   3. Connects via WebSocket through an SSH tunnel
 *
 * The daemon runs independently on the remote machine — SSH dropping
 * doesn't kill it. It NEVER auto-exits. Individual sessions are killed
 * after 2 hours of inactivity with no connected watchers.
 *
 * WHY EMBEDDED:
 * - No npm install needed on remote (uses Node.js built-in WebSocket from Node 21+,
 *   with fallback to raw HTTP upgrade for older versions)
 * - Single file deployment via SSH pipe
 * - Version always matches the Walnut server
 *
 * PROTOCOL:
 * Client sends JSON commands, daemon sends JSON events.
 * Commands: start, attach, send, stop, status, rename, read-history,
 *   subscribe-agent, unsubscribe-agent, write-inbox, fs.read, fs.write,
 *   fs.ls, fs.find, fs.stat, list, ping
 * Events: jsonl (JSONL line), exit (process exited), agent (subagent data),
 *   ok (command response), error (command error)
 */

/**
 * Get the daemon source code as a string.
 * The source is a self-contained Node.js script that:
 * - Listens on a random localhost port (WebSocket)
 * - Manages Claude CLI processes (start, stop, attach)
 * - Streams JSONL output via WebSocket
 * - Handles subagent polling
 * - Provides file system operations
 * - Never auto-exits; kills idle sessions after 2hr with no watchers
 */
import { REQUIRED_DAEMON_CAPABILITIES } from './daemon-capabilities.js'
import { computeExpectedDaemonVersion } from './daemon-version-check.js'

export function getDaemonSource(): string {
  // Inject capability list so the fallback node daemon answers `hello` with
  // the same list as the compiled binary.
  //
  // Placeholder substitution (rather than import) because DAEMON_SOURCE is a
  // raw string executed via `node -e ...` on the remote host — imports can't
  // resolve there, so the caps list must be inlined at string-build time on
  // the local machine.
  //
  // replaceAll + count check defends against two regressions: (1) someone
  // adds a second placeholder copy and forgets it, (2) someone typos the
  // placeholder so no substitution happens and the daemon ships with a
  // literal `__DAEMON_CAPABILITIES__` that crashes at parse time.
  const capsLiteral = JSON.stringify([...REQUIRED_DAEMON_CAPABILITIES])
  const placeholder = '__DAEMON_CAPABILITIES__'
  const matches = DAEMON_SOURCE.split(placeholder).length - 1
  if (matches !== 1) {
    throw new Error(
      `daemon-source: expected exactly 1 '${placeholder}' placeholder in DAEMON_SOURCE, found ${matches}`,
    )
  }

  // Stamp the real version at string-build time. The old code left
  // `process.env.DAEMON_VERSION || 'dev-source'` to be evaluated at RUNTIME on
  // the remote host, where the env var is never set — so every source deploy
  // reported 'dev-source' and could never match the binary sidecar version,
  // feeding the shouldUpgradeDaemon stop/redeploy loop. The hash here is the
  // same sha256-of-daemon-sources that scripts/build-daemon.sh bakes into the
  // binaries, so a source deploy and a binary built from the same tree report
  // the SAME version.
  const versionPlaceholder = '__DAEMON_VERSION__'
  const versionMatches = DAEMON_SOURCE.split(versionPlaceholder).length - 1
  if (versionMatches !== 1) {
    throw new Error(
      `daemon-source: expected exactly 1 '${versionPlaceholder}' placeholder in DAEMON_SOURCE, found ${versionMatches}`,
    )
  }
  const version = computeExpectedDaemonVersion() || process.env.DAEMON_VERSION || 'dev-source'

  return DAEMON_SOURCE
    .replaceAll(placeholder, capsLiteral)
    .replaceAll(versionPlaceholder, version)
}

// ── Daemon source code ──
// This is deployed to /tmp/open-walnut/daemon.cjs on the remote machine.

const DAEMON_SOURCE = `#!/usr/bin/env node
'use strict';

/**
 * walnut-daemon — Remote session manager for Open Walnut.
 *
 * Runs as a persistent server on the remote machine.
 * Manages Claude CLI processes and streams output via WebSocket.
 *
 * Usage:
 *   node daemon.js --start      # Start daemon, print port to stdout
 *   node daemon.js --stop       # Stop running daemon
 *   node daemon.js --status     # Check if daemon is running
 *
 * Protocol: JSON over WebSocket
 *   Client → Daemon: { id, cmd, ...params }
 *   Daemon → Client: { id, ok, ...data } or { ev, ...data }
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, execSync } = require('child_process');
const crypto = require('crypto');

// ── PATH setup ──
// Same logic the compiled binary uses: bun/node may launch the daemon with a
// minimal PATH that lacks claude/node/etc. Source ~/.zshrc or ~/.bashrc to pick
// up nvm/fnm/volta/pyenv/etc., and add common tool dirs as a safety net.
// Without this, cmdStart's spawn('claude', ...) fails ENOENT on most hosts.
(function() {
  const home = process.env.HOME || '/root';
  // toolbox FIRST: it may ship a logged-in claude that must win over a
  // separate ~/.local/bin/claude install (which may be NOT logged in). These
  // are only a fallback for when RC sourcing fails to provide claude.
  const extraPaths = [
    home + '/.toolbox/bin',
    home + '/.local/bin',
    home + '/.npm-global/bin',
    home + '/.cargo/bin',
    home + '/.pyenv/shims',
    home + '/.bun/bin',
    '/usr/local/bin', '/usr/bin', '/bin',
    '/usr/local/sbin', '/usr/sbin', '/sbin',
  ];
  const rcFiles = [home + '/.zshrc', home + '/.bashrc'];
  let pathFromRc = '';
  for (const rcFile of rcFiles) {
    try {
      if (!fs.existsSync(rcFile)) continue;
      const shells = rcFile.endsWith('.zshrc')
        ? ['/bin/zsh', '/usr/bin/zsh', '/bin/bash']
        : ['/bin/bash', '/bin/sh'];
      for (const shell of shells) {
        try {
          if (!fs.existsSync(shell)) continue;
          const result = execSync(
            'source ' + JSON.stringify(rcFile) + ' 2>/dev/null; echo "$PATH"',
            { encoding: 'utf-8', shell: shell, timeout: 5000 },
          ).trim();
          if (result && result.indexOf('/') >= 0 && result.length > 20) {
            pathFromRc = result;
            break;
          }
        } catch (e) { continue; }
      }
      if (pathFromRc) break;
    } catch (e) { continue; }
  }
  const allPaths = []
    .concat(extraPaths)
    .concat(pathFromRc ? pathFromRc.split(':') : [])
    .concat((process.env.PATH || '').split(':'))
    .filter(Boolean);
  const seen = {};
  const deduped = [];
  for (const p of allPaths) { if (!seen[p]) { seen[p] = true; deduped.push(p); } }
  process.env.PATH = deduped.join(':');
})();

// ── Constants ──
// DAEMON_DIR default is /tmp/open-walnut; tests override via env var.
const DAEMON_DIR = process.env.WALNUT_DAEMON_DIR || '/tmp/open-walnut';
// Sibling dir so an isolated daemon dir yields an isolated streams dir; production
// default stays /tmp/open-walnut-streams. Must mirror daemon-standalone.ts.
// NOTE: string concat (not template literal) because this code lives inside a
// template literal string in the outer TypeScript file.
const STREAMS_DIR = process.env.WALNUT_STREAMS_DIR || (DAEMON_DIR + '-streams');
// Home for ~/... expansion. WALNUT_HOME_OVERRIDE lets tests align the daemon's ~/.claude
// with their mocked CLAUDE_HOME. Mirrors daemon-standalone.ts.
const HOME_DIR = process.env.WALNUT_HOME_OVERRIDE || process.env.HOME || '/root';
const PORT_FILE = path.join(DAEMON_DIR, 'daemon.port');
const PID_FILE = path.join(DAEMON_DIR, 'daemon.pid');
const INSTANCE_ID_FILE = path.join(DAEMON_DIR, 'daemon.instance');
// Source of truth for upgrade decisions — written at startup, read by
// DaemonConnection.shouldUpgradeDaemon via cat. Must mirror daemon-standalone.ts.
const VERSION_FILE = path.join(DAEMON_DIR, 'daemon.version');

// ── Version ──
// Substituted by getDaemonSource() at deploy time with the sha256-of-sources
// hash (same value scripts/build-daemon.sh bakes into the compiled binaries).
// MUST NOT be left as a runtime env lookup: the env var is never set on the
// remote host, and a literal 'dev-source' can never match the binary sidecar
// version — that mismatch fed an infinite stop/redeploy loop.
const DAEMON_VERSION = '__DAEMON_VERSION__';
const AGENT_POLL_INTERVAL_MS = 2000;
const AGENT_REDISCOVER_INTERVAL_MS = 10000;
const PING_INTERVAL_MS = 15000;
const HEARTBEAT_INTERVAL_MS = 30000;

// ── Daemon Instance ID ──
// Must mirror daemon-standalone.ts exactly (CLAUDE.md: keep in sync).
const DAEMON_START_TS = Date.now();
const DAEMON_INSTANCE_ID = (function() {
  const seed = process.pid + '-' + DAEMON_START_TS + '-' + Math.random();
  const hash = crypto.createHash('sha256').update(seed).digest('hex').slice(0, 8);
  return 'd-' + process.pid + '-' + hash;
})();
const LOG_FILE = path.join(DAEMON_DIR, 'daemon-' + DAEMON_INSTANCE_ID + '.log');

// ── Logging ──
function logMsg(level, msg, data) {
  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    instanceId: DAEMON_INSTANCE_ID,
    ...data,
  });
  try { fs.appendFileSync(LOG_FILE, entry + '\\n'); } catch {}
  if (level === 'error') console.error(msg, data || '');
}

/** Structured state-transition log — emit BEFORE mutating state. */
function logStateTransition(sid, oldState, newState, reason, source, extra) {
  logMsg('info', 'state_transition', Object.assign({
    sid, oldState, newState, reason, source,
  }, extra || {}));
}

// ── Managed Sessions ──
// Each session has: { proc, pipe, jsonlPath, watcher, subscribers, offset,
//   state: 'running' | 'dead', exitCode, exitReason, exitedAt, parented,
//   startTime, cwd, args, orphanPollTimer }
//
// watcher: { pollTimer, offset } | null — session-bound file tailer.
//   Lives exactly as long as the session process. NOT tied to any WebSocket.
// subscribers: Set<WebSocket> — clients receiving push events for this session.
//   Add on cmdAttach / cmdStart, remove on ws.close. watcher is unaffected.
//
// Historical (pre-2026-05): watcher was Map<ws, perWsWatcher>. That tied
// watcher lifetime to WebSocket lifetime — when the ws dropped (SSH tunnel
// flap, network blip), watchers were cleared and new ws had no push until it
// explicitly re-attached. Produced the long-running "no watchers" bug where
// remote sessions silently lost streaming after any reconnect. Fixed by
// splitting into session-bound watcher + ws-bound subscribers set.
//
// state is authoritative — daemon is the single source of truth for CLI/FIFO
// lifecycle. See reapSession() below.
const sessions = new Map();

// ── Write-ahead Registry (Phase C) ──
const REGISTRY_FILE = path.join(DAEMON_DIR, 'sessions.json');
function readRegistry() {
  try {
    const raw = fs.readFileSync(REGISTRY_FILE, 'utf-8');
    const data = JSON.parse(raw);
    if (data && typeof data === 'object' && data.sessions && typeof data.sessions === 'object') {
      return data.sessions;
    }
  } catch {}
  return {};
}
function persistRegistry() {
  const out = {};
  for (const [sid, s] of sessions) {
    if (s.state !== 'running' || !s.pid) continue;
    out[sid] = {
      pid: s.pid,
      startTime: s.startTime,
      pipePath: s.pipePath,
      jsonlPath: s.jsonlPath,
      pgidPath: s.pgidPath,
      cwd: s.cwd,
      args: s.args,
      spawnedAt: new Date().toISOString(),
      parented: s.parented,
      mode: s.mode,
      pendingCtrl: s.pendingCtrl || undefined,
    };
  }
  const body = JSON.stringify({ version: 1, sessions: out });
  const tmp = REGISTRY_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, body);
    try {
      const fd = fs.openSync(tmp, 'r+');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    } catch {}
    fs.renameSync(tmp, REGISTRY_FILE);
  } catch (err) {
    logMsg('warn', 'registry persist failed', { error: err.message });
  }
}

/** Read /proc/<pid>/stat field 22 (start_time) on Linux. */
function readStartTime(pid) {
  try {
    const raw = fs.readFileSync('/proc/' + pid + '/stat', 'utf-8');
    const rparen = raw.lastIndexOf(')');
    if (rparen < 0) return null;
    const fields = raw.slice(rparen + 2).split(' ');
    return fields[19] || null;
  } catch {
    return null;
  }
}

// ── Session state broadcast (Phase B) ──
function broadcastSessionState(sid, state, extra) {
  const payload = Object.assign({ sid, state }, extra || {});
  for (const client of wsClients) {
    try { client.send(JSON.stringify(Object.assign({ ev: 'session_state' }, payload))); } catch {}
  }
}

// ── Clean turn-complete detector ──
// claude -p writes a final {"type":"result","stop_reason":"end_turn"} line
// and exits 0 after every turn. Every death path here (orphan-poll, send-
// precheck, send-enxio) can't see the true exit code because the process
// was adopted or died between SIGCHLD and our poll. Tail the JSONL as the
// authoritative signal — clean completion should not be reported as error.
function isTurnCompleteExit(jsonlPath) {
  try {
    const stat = fs.statSync(jsonlPath);
    if (stat.size === 0) return false;
    const readLen = Math.min(stat.size, 8192);
    const start = Math.max(0, stat.size - readLen);
    const fd = fs.openSync(jsonlPath, 'r');
    const buf = Buffer.alloc(readLen);
    fs.readSync(fd, buf, 0, readLen, start);
    fs.closeSync(fd);
    const text = buf.toString('utf-8');
    const lines = text.split('\\n').map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) return false;
    const last = lines[lines.length - 1];
    const parsed = JSON.parse(last);
    if (parsed.type !== 'result') return false;
    if (parsed.subtype === 'error_max_turns' || parsed.subtype === 'error_during_execution') return false;
    return true;
  } catch {
    return false;
  }
}

// ── Idempotent Reaper (Phase B, primitive P1) ──
function reapSession(sid, code, reason) {
  const session = sessions.get(sid);
  if (!session) return;
  if (session.state === 'dead') return;  // idempotent guard

  // Normalize code=-1 from poll-based death paths to 0 when the CLI finished
  // a turn cleanly. Prevents spurious "exited with code -1" errors in the UI
  // every time claude -p naturally exits at the end of a turn.
  let jsonlAgeMs = null;
  try { jsonlAgeMs = Date.now() - fs.statSync(session.jsonlPath).mtimeMs; } catch {}
  const cleanExit = isTurnCompleteExit(session.jsonlPath);
  if (code !== 0 && cleanExit) {
    logMsg('info', 'reapSession: turn-complete detected, normalizing exit code', {
      sid, pid: session.pid, originalCode: code, originalReason: reason, jsonlAgeMs,
    });
    code = 0;
    reason = reason + '+turn-complete';
  }

  logStateTransition(sid, 'running', 'dead', reason, 'reapSession', {
    pid: session.pid, code, cleanExit, jsonlAgeMs,
  });
  session.state = 'dead';
  session.exitCode = code;
  session.exitReason = reason;
  session.exitedAt = Date.now();

  logMsg('info', 'reapSession', { sid, pid: session.pid, code, reason, cleanExit, jsonlAgeMs });

  if (session.orphanPollTimer) {
    try { clearInterval(session.orphanPollTimer); } catch {}
    session.orphanPollTimer = null;
  }

  try { fs.unlinkSync(session.pipePath); } catch {}

  if (session.pid) {
    try { killProcessGroup(session.pid, 'SIGTERM'); } catch {}
    setTimeout(() => {
      if (session.pid) { try { killProcessGroup(session.pid, 'SIGKILL'); } catch {} }
    }, 2000);
  }

  let stderrTail;
  try {
    const errStat = fs.statSync(session.jsonlPath + '.err');
    if (errStat.size > 0) {
      const readLen = Math.min(errStat.size, 4096);
      const start = Math.max(0, errStat.size - readLen);
      const fd = fs.openSync(session.jsonlPath + '.err', 'r');
      const buf = Buffer.alloc(readLen);
      fs.readSync(fd, buf, 0, readLen, start);
      fs.closeSync(fd);
      stderrTail = buf.toString('utf-8').trim() || undefined;
    }
  } catch {}

  try { persistRegistry(); } catch {}

  // Stop the session-bound watcher first (no more pushes after this point).
  stopSessionWatcher(sid);

  // Notify all subscribers the session exited, then clear the set.
  for (const client of session.subscribers) {
    try { client.send(JSON.stringify({ ev: 'exit', sid, code, stderr: stderrTail })); } catch {}
  }
  session.subscribers.clear();
  broadcastSessionState(sid, 'dead', { exitCode: code, reason, stderr: stderrTail });
}

// ── Orphan poll (Phase D, layer 3.2) ──
const ORPHAN_POLL_INTERVAL_MS = 1000;
function startOrphanPoll(sid) {
  const session = sessions.get(sid);
  if (!session || session.state !== 'running' || !session.pid || session.orphanPollTimer) return;
  const pid = session.pid;
  const capturedStartTime = session.startTime;
  logMsg('info', 'startOrphanPoll: started', { sid, pid, startTime: capturedStartTime });
  const timer = setInterval(() => {
    const s = sessions.get(sid);
    if (!s || s.state !== 'running') {
      if (s && s.orphanPollTimer) {
        try { clearInterval(s.orphanPollTimer); } catch {}
        s.orphanPollTimer = null;
      }
      return;
    }
    // Stale-timer guard: if cmdStart replaced the session with a new pid,
    // we must not reap — that would kill the newborn CLI. Self-terminate.
    if (s.pid !== pid) {
      logMsg('warn', 'orphan poll: stale timer detected (session replaced), self-terminating', {
        sid, capturedPid: pid, currentPid: s.pid,
      });
      try { clearInterval(timer); } catch {}
      return;
    }
    try { process.kill(pid, 0); } catch {
      logMsg('info', 'orphan poll: kill(pid,0) ESRCH — reaping', { sid, pid });
      reapSession(sid, -1, 'orphan-poll-dead');
      return;
    }
    if (capturedStartTime) {
      const current = readStartTime(pid);
      if (current && current !== capturedStartTime) {
        logMsg('warn', 'orphan poll: pid recycled (start_time drift) — reaping', {
          sid, pid, captured: capturedStartTime, current,
        });
        reapSession(sid, -1, 'pid-recycled');
      }
    }
  }, ORPHAN_POLL_INTERVAL_MS);
  session.orphanPollTimer = timer;
}

// ── L2: daemon-authoritative per-session task state (the k8s .status object) ──
// Materializes background-task state from task_* events with the SAME idempotent,
// terminal-is-terminal rules Walnut uses, served on the getState RPC so Walnut can reconcile a
// lost-terminal event without guessing liveness. resourceVersion = the event byte offset v
// (monotonic, rebuildable from the jsonl). MUST stay byte-equivalent to daemon-standalone.ts.
const BG_TERMINAL_STATUSES = new Set(['completed', 'failed', 'stopped', 'cancelled']);
const BG_TRANSITION_CAP = 50;

function emptyTaskState() {
  return { tasks: {}, resourceVersion: 0, updatedAt: 0, derivedRunning: 0, recentTransitions: [] };
}

// GATING count: tasks the CLI flagged is_backgrounded are excluded — the CLI's own
// turn-end does not wait for them (incident 07fffbe5). Mirrors daemon-standalone.ts.
function runningTaskCount(ts) {
  let n = 0;
  for (const id in ts.tasks) {
    if (ts.tasks[id].isBackgrounded) continue;
    if (!BG_TERMINAL_STATUSES.has(ts.tasks[id].status)) n++;
  }
  return n;
}

function applyTaskEvent(ts, parsed, v, now) {
  if (parsed.type !== 'system') return false;
  const subtype = parsed.subtype;
  const taskId = parsed.task_id;
  if (!subtype || !taskId) return false;
  const prev = ts.tasks[taskId];
  let nextStatus;
  let isBackgrounded = prev ? prev.isBackgrounded === true : false;
  if (subtype === 'task_started') {
    nextStatus = prev && BG_TERMINAL_STATUSES.has(prev.status) ? prev.status : 'running';
  } else if (subtype === 'task_progress') {
    nextStatus = prev && BG_TERMINAL_STATUSES.has(prev.status) ? prev.status : 'running';
  } else if (subtype === 'task_updated') {
    const ps = parsed.patch && parsed.patch.status;
    nextStatus = ps || (prev && prev.status) || 'running';
    // Sticky: is_backgrounded=true detaches the task from turn-over gating forever.
    if (parsed.patch && parsed.patch.is_backgrounded === true) isBackgrounded = true;
  } else if (subtype === 'task_notification') {
    nextStatus = parsed.status || (prev && prev.status) || 'running';
  } else {
    return false;
  }
  const wasTerminal = prev ? BG_TERMINAL_STATUSES.has(prev.status) : false;
  const isTerminal = BG_TERMINAL_STATUSES.has(nextStatus);
  ts.tasks[taskId] = { status: nextStatus, v, t: now, description: parsed.description || (prev && prev.description), isBackgrounded: isBackgrounded || undefined };
  if (v > ts.resourceVersion) ts.resourceVersion = v;
  ts.updatedAt = now;
  ts.derivedRunning = runningTaskCount(ts);
  if (!wasTerminal && isTerminal) {
    ts.recentTransitions.push({ taskId, status: nextStatus, v, t: now });
    if (ts.recentTransitions.length > BG_TRANSITION_CAP) ts.recentTransitions.shift();
    return true;
  }
  return false;
}

function rebuildTaskStateFromJsonl(jsonlPath, now) {
  const ts = emptyTaskState();
  let text;
  try { text = fs.readFileSync(jsonlPath, 'utf-8'); } catch { return ts; }
  let lineStartV = 0;
  for (const line of text.split('\\n')) {
    const v = lineStartV + Buffer.byteLength(line, 'utf-8') + 1;
    lineStartV = v;
    if (!line.trim() || !line.includes('"task_')) continue;
    try { applyTaskEvent(ts, JSON.parse(line), v, now); } catch {}
  }
  return ts;
}

// ── Startup reconcile (Phase C, primitive P4) ──
function reconcileRegistry() {
  const registry = readRegistry();
  for (const sid of Object.keys(registry)) {
    const entry = registry[sid];
    const pid = entry.pid;
    if (!pid || pid <= 0) continue;

    // Re-entrant guard: skip if already adopted (prevents timer leak on
    // repeated reconcile calls).
    if (sessions.has(sid)) continue;

    // Adopt at the CURRENT end of the stream file, not 0 — a new daemon
    // generation must never replay history it didn't stream itself.
    // Keep in sync with daemon-standalone.ts createAdoptedSession (CLAUDE.md).
    let adoptOffset = 0;
    try { adoptOffset = fs.statSync(entry.jsonlPath).size; } catch {}
    const session = {
      proc: null,
      pipePath: entry.pipePath,
      jsonlPath: entry.jsonlPath,
      pgidPath: entry.pgidPath,
      pid,
      offset: adoptOffset,
      taskState: rebuildTaskStateFromJsonl(entry.jsonlPath, Date.now()),
      watcher: null,
      subscribers: new Set(),
      exitCode: null,
      state: 'running',
      exitReason: null,
      exitedAt: null,
      parented: false,
      startTime: entry.startTime,
      cwd: entry.cwd || '',
      args: entry.args || [],
      orphanPollTimer: null,
      mode: entry.mode || 'default',
      pendingCtrl: entry.pendingCtrl || null,
    };
    sessions.set(sid, session);

    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch (err) {
      if (err && err.code === 'EPERM') {
        reapSession(sid, -1, 'reconcile-not-ours');
        continue;
      }
      reapSession(sid, -1, 'reconcile-dead');
      continue;
    }

    if (alive && entry.startTime) {
      const current = readStartTime(pid);
      if (current && current !== entry.startTime) {
        reapSession(sid, -1, 'reconcile-pid-recycled');
        continue;
      }
    }

    logStateTransition(sid, 'none', 'running', 'reconcile-adopt', 'reconcileRegistry', { pid });
    logMsg('info', 'reconcile: adopted orphan session', { sid, pid });
    startOrphanPoll(sid);
    broadcastSessionState(sid, 'running', { pid, adopted: true });
  }

  // Zombie FIFO sweep
  try {
    const files = fs.readdirSync(STREAMS_DIR);
    for (const f of files) {
      if (!f.endsWith('.pipe')) continue;
      const sid = f.replace('.pipe', '');
      if (!sessions.has(sid)) {
        try { fs.unlinkSync(path.join(STREAMS_DIR, f)); } catch {}
      }
    }
  } catch {}
}

// ── Process group helpers ──
// Claude is spawned with detached:true, so pid === PGID.
// kill(-pid) sends signal to the entire process group (Claude + MCP servers).

function killProcessGroup(pid, signal) {
  try { process.kill(-pid, signal); return true; } catch { return false; }
}

function isProcessGroupAlive(pid) {
  try { process.kill(-pid, 0); return true; } catch { return false; }
}

function killSessionProcessGroup(pid, sid) {
  if (!isProcessGroupAlive(pid)) return;
  logMsg('info', 'kill sequence: SIGINT', { sid, pid });
  killProcessGroup(pid, 'SIGINT');
  setTimeout(() => {
    if (!isProcessGroupAlive(pid)) return;
    logMsg('info', 'kill sequence: SIGTERM', { sid, pid });
    killProcessGroup(pid, 'SIGTERM');
    setTimeout(() => {
      if (!isProcessGroupAlive(pid)) return;
      logMsg('warn', 'kill sequence: SIGKILL', { sid, pid });
      killProcessGroup(pid, 'SIGKILL');
    }, 2000);
  }, 5000);
}

// ── WebSocket connections ──
const wsClients = new Set();

// Daemon NEVER auto-exits. It's a permanent process manager on the remote host.
// Mac disconnecting should NOT cause daemon to exit — sessions keep running.
// Session lifecycle is managed by the session idle scanner (scanIdleSessions).

// ── Agent subscriptions ──
// Map<subKey, { timer, rediscoverTimer, files: Map<filePath, offset> }>
const agentSubs = new Map();

// ── WebSocket server (using built-in or manual upgrade) ──

function createWsServer(httpServer) {
  // Try Node.js 21+ built-in WebSocket server, fall back to manual
  try {
    // Node 22+ has WebSocketServer
    const { WebSocketServer } = require('ws');
    const wss = new WebSocketServer({ server: httpServer });
    return wss;
  } catch {
    // Fall back: try native
    try {
      const { WebSocketServer } = require('node:ws');
      const wss = new WebSocketServer({ server: httpServer });
      return wss;
    } catch {
      // Manual WebSocket upgrade (no external deps)
      return createManualWsServer(httpServer);
    }
  }
}

/**
 * Minimal WebSocket server using raw HTTP upgrade.
 * Handles frames manually — supports text messages + ping/pong.
 * This is a fallback for Node.js versions without 'ws' package.
 */
function createManualWsServer(httpServer) {
  const EventEmitter = require('events');
  const emitter = new EventEmitter();

  httpServer.on('upgrade', (req, socket, head) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }

    const acceptKey = crypto
      .createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');

    socket.write(
      'HTTP/1.1 101 Switching Protocols\\r\\n' +
      'Upgrade: websocket\\r\\n' +
      'Connection: Upgrade\\r\\n' +
      'Sec-WebSocket-Accept: ' + acceptKey + '\\r\\n' +
      '\\r\\n'
    );

    // Create a WebSocket-like wrapper
    const ws = createWsWrapper(socket);
    emitter.emit('connection', ws);
  });

  return emitter;
}

function createWsWrapper(socket) {
  const EventEmitter = require('events');
  const ws = new EventEmitter();
  ws.readyState = 1; // OPEN
  let buffer = Buffer.alloc(0);

  ws.send = function(data) {
    if (ws.readyState !== 1) return;
    const payload = Buffer.from(data, 'utf-8');
    const frame = encodeFrame(payload, 0x01); // text frame
    try { socket.write(frame); } catch {}
  };

  ws.close = function() {
    ws.readyState = 3; // CLOSED
    try { socket.end(); } catch {}
  };

  ws.ping = function() {
    if (ws.readyState !== 1) return;
    try { socket.write(encodeFrame(Buffer.alloc(0), 0x09)); } catch {}
  };

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const result = decodeFrame(buffer);
      if (!result) break;
      buffer = result.remaining;
      const { opcode, payload } = result;

      if (opcode === 0x01 || opcode === 0x02) { // text or binary
        ws.emit('message', payload.toString('utf-8'));
      } else if (opcode === 0x08) { // close
        ws.readyState = 3;
        ws.emit('close');
        socket.end();
        return;
      } else if (opcode === 0x09) { // ping
        try { socket.write(encodeFrame(payload, 0x0A)); } catch {} // pong
      } else if (opcode === 0x0A) { // pong
        ws.emit('pong');
      }
    }
  });

  socket.on('close', () => {
    ws.readyState = 3;
    ws.emit('close');
  });

  socket.on('error', (err) => {
    ws.readyState = 3;
    ws.emit('error', err);
  });

  return ws;
}

function encodeFrame(payload, opcode) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode; // FIN + opcode
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0F;
  const masked = !!(buf[1] & 0x80);
  let payloadLen = buf[1] & 0x7F;
  let offset = 2;

  if (payloadLen === 126) {
    if (buf.length < 4) return null;
    payloadLen = buf.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    if (buf.length < 10) return null;
    payloadLen = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }

  if (masked) {
    if (buf.length < offset + 4 + payloadLen) return null;
    const mask = buf.slice(offset, offset + 4);
    offset += 4;
    const payload = buf.slice(offset, offset + payloadLen);
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    return { opcode, payload, remaining: buf.slice(offset + payloadLen) };
  } else {
    if (buf.length < offset + payloadLen) return null;
    const payload = buf.slice(offset, offset + payloadLen);
    return { opcode, payload, remaining: buf.slice(offset + payloadLen) };
  }
}

// ── Session management commands ──

// Commands the cloud bridge is allowed to invoke — MUST match the standalone
// twin's BRIDGE_ALLOWED_COMMANDS. Anything else from a bridge socket is a
// compromised-cloud-box escalation attempt (fs.write/start/bridge.configure/…)
// and is rejected; those stay reachable only over the trusted SSH path.
var BRIDGE_ALLOWED_COMMANDS = new Set([
  'status', 'appendUserMarker', 'send', 'attach', 'read-history', 'ping', 'bridgeResume',
]);

function handleCommand(ws, msg) {
  let cmd;
  try { cmd = JSON.parse(msg); } catch { return sendError(ws, null, 'invalid JSON'); }
  const { id } = cmd;

  // Per-command receive log (drop ping — too high frequency to log).
  if (cmd.cmd !== 'ping') {
    logMsg('debug', 'cmd_recv', {
      cmd: cmd.cmd, id,
      sid: typeof cmd.sid === 'string' ? cmd.sid : undefined,
      traceId: typeof cmd.traceId === 'string' ? cmd.traceId : undefined,
    });
  }

  // Cloud bridge is a PUBLIC relay: restrict it to the phone-proxy command set.
  // A frame outside the allowlist on a bridge socket means the cloud box was
  // compromised and is trying to escalate to fs.write/start/etc — refuse it.
  if (ws.origin === 'bridge' && !BRIDGE_ALLOWED_COMMANDS.has(cmd.cmd)) {
    logMsg('warn', 'bridge: rejected non-allowlisted command', { cmd: cmd.cmd, id });
    return sendError(ws, id, 'command not permitted over bridge: ' + cmd.cmd);
  }

  switch (cmd.cmd) {
    case 'start': return cmdStart(ws, id, cmd);
    case 'attach': return cmdAttach(ws, id, cmd);
    case 'send': return cmdSend(ws, id, cmd);
    case 'sendRaw': return cmdSendRaw(ws, id, cmd);
    case 'appendUserMarker': return cmdAppendUserMarker(ws, id, cmd);
    case 'stop': return cmdStop(ws, id, cmd);
    case 'setMode': return cmdSetMode(ws, id, cmd);
    case 'status': return cmdStatus(ws, id, cmd);
    case 'getState': return cmdGetState(ws, id, cmd);
    case 'rename': return cmdRename(ws, id, cmd);
    case 'read-history': return cmdReadHistory(ws, id, cmd);
    case 'subscribe-agent': return cmdSubscribeAgent(ws, id, cmd);
    case 'unsubscribe-agent': return cmdUnsubscribeAgent(ws, id, cmd);
    case 'write-inbox': return cmdWriteInbox(ws, id, cmd);
    case 'fs.read': return cmdFsRead(ws, id, cmd);
    case 'fs.write': return cmdFsWrite(ws, id, cmd);
    case 'fs.ls': return cmdFsLs(ws, id, cmd);
    case 'fs.find': return cmdFsFind(ws, id, cmd);
    case 'fs.stat': return cmdFsStat(ws, id, cmd);
    case 'fs.readRange': return cmdFsReadRange(ws, id, cmd);
    case 'git.diff': return cmdGitDiff(ws, id, cmd);
    case 'list': return cmdList(ws, id);
    case 'bridge.configure': return cmdBridgeConfigure(ws, id, cmd);
    case 'bridgeResume': return cmdBridgeResume(ws, id, cmd);
    case 'ping': return sendOk(ws, id, { pong: true });
    case 'hello': return sendOk(ws, id, {
      version: DAEMON_VERSION,
      capabilities: __DAEMON_CAPABILITIES__,
      instanceId: DAEMON_INSTANCE_ID,
      startedAt: DAEMON_START_TS,
      uptimeSec: Math.floor((Date.now() - DAEMON_START_TS) / 1000),
    });
    default: return sendError(ws, id, 'unknown command: ' + cmd.cmd);
  }
}

// ── Bridge-safe resume: respawn a dead session using its stored args ──
function cmdBridgeResume(ws, id, cmd) {
  var sid = cmd.sid, message = cmd.message;
  if (!sid || !message) {
    return sendError(ws, id, 'bridgeResume: missing sid or message');
  }

  var session = sessions.get(sid);
  if (!session) {
    var jsonlPath = path.join(STREAMS_DIR, sid + '.jsonl');
    if (!fs.existsSync(jsonlPath)) {
      return sendError(ws, id, 'bridgeResume: session not found: ' + sid);
    }
    return sendError(ws, id, 'bridgeResume: session record lost (only files remain)');
  }

  if (session.state === 'running') {
    return cmdSend(ws, id, { cmd: 'send', sid: sid, message: message });
  }

  if (!session.args || session.args.length === 0 || !session.cwd) {
    return sendError(ws, id, 'bridgeResume: dead session has no stored args/cwd');
  }

  // Ensure --resume <sid> is present (fresh-start args lack it; stale --resume
  // values point at an older generation). Keep in sync with daemon-standalone.
  var args = session.args.slice();
  var ri = args.indexOf('--resume');
  if (ri >= 0 && ri + 1 < args.length) {
    args[ri + 1] = sid;
  } else {
    args.push('--resume', sid);
  }

  logMsg('info', 'bridgeResume: respawning dead session', { sid: sid, cwd: session.cwd });
  cmdStart(ws, id, {
    cmd: 'start',
    sid: sid,
    args: args,
    cwd: session.cwd,
    message: message,
    resume: true,
    mode: session.mode,
  });
}

// ── Start a Claude session ──
function cmdStart(ws, id, cmd) {
  const { sid, args, cwd, message, resume, mode } = cmd;
  if (!sid || !args || !cwd || !message) {
    return sendError(ws, id, 'start: missing required fields (sid, args, cwd, message)');
  }

  // Replace-existing cleanup: prevents stale orphanPollTimer from the old
  // session mis-firing pid-recycled against the newborn pid.
  const existing = sessions.get(sid);
  if (existing) {
    logMsg('warn', 'cmdStart: replacing existing session', {
      sid,
      oldPid: existing.pid,
      oldState: existing.state,
      oldHasOrphanPoll: !!existing.orphanPollTimer,
      resume: !!resume,
    });
    if (existing.orphanPollTimer) {
      try { clearInterval(existing.orphanPollTimer); } catch {}
      existing.orphanPollTimer = null;
    }
    // Stop the old watcher BEFORE sessions.set() replaces the entry — the poll
    // timer re-resolves sessions.get(sid) each tick, so with the new session in
    // place the old timer would tail the same jsonl at its own offset (doubled
    // fan-out) and leak forever. Keep in sync with daemon-standalone.ts.
    stopSessionWatcher(sid);
    if (existing.state === 'running' && existing.pid) {
      let oldAlive = false;
      try { process.kill(existing.pid, 0); oldAlive = true; } catch {}
      if (oldAlive) {
        logMsg('warn', 'cmdStart: killing old-session process group before respawn', {
          sid, oldPid: existing.pid,
        });
        try { process.kill(-existing.pid, 'SIGTERM'); } catch {}
      }
    }
    existing.state = 'dead';
    existing.exitReason = 'replaced-by-cmdstart';
    existing.exitedAt = Date.now();
  }

  fs.mkdirSync(STREAMS_DIR, { recursive: true });

  const pipePath = path.join(STREAMS_DIR, sid + '.pipe');
  const jsonlPath = path.join(STREAMS_DIR, sid + '.jsonl');
  const stderrPath = jsonlPath + '.err';
  const pgidPath = path.join(STREAMS_DIR, sid + '.pgid');

  // Record offset before spawn (for resume — only stream new data)
  let offset = 0;
  if (resume) {
    try { offset = fs.statSync(jsonlPath).size; } catch { offset = 0; }
  }

  // Create FIFO
  try { fs.unlinkSync(pipePath); } catch {}
  try { execSync('mkfifo ' + JSON.stringify(pipePath)); } catch (err) {
    return sendError(ws, id, 'mkfifo failed: ' + err.message);
  }

  // Open files. jsonl fd MUST be O_APPEND ('a') — the daemon also appends
  // turn-start marker lines (appendUserMarker); a positional 'w' fd would
  // overwrite them. Fresh spawns truncate explicitly first.
  const pipeFd = fs.openSync(pipePath, fs.constants.O_RDWR);
  if (!resume) { try { fs.writeFileSync(jsonlPath, ''); } catch {} }
  const outputFd = fs.openSync(jsonlPath, 'a');
  const stderrFd = fs.openSync(stderrPath, resume ? 'a' : 'w');

  // Touch output file on resume so health checks see fresh mtime
  if (resume) {
    try { const now = new Date(); fs.utimesSync(jsonlPath, now, now); } catch {}
  }

  // Spawn Claude
  const proc = spawn(args[0] || 'claude', args.slice(1), {
    detached: true,
    stdio: [pipeFd, outputFd, stderrFd],
    cwd: cwd,
    // MCP_CONNECTION_NONBLOCKING=1: CLI emits init immediately instead of blocking
    // up to 5s waiting for MCP servers (they keep connecting in background). Cuts
    // time-to-init ~6.9s → ~2.9s with no loss of MCP functionality. Keep in sync
    // with daemon-standalone.ts.
    // CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1: opt into the CLI authoritative
    // session_state_changed (running/idle/requires_action) stream events. idle
    // is the only reliable turn-over signal (a single dynamic-workflow turn emits
    // MANY result events as background subagents finish, so result is NOT a turn
    // boundary). Verified by live capture: idle fires exactly once, strictly after
    // the last result + all task_notifications. Walnut keys turn-completion off
    // this instead of result.
    //
    // We intentionally DO NOT set CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: background
    // Bash tasks (run_in_background) are a useful capability with no reason to be
    // amputated. The orphan-process worry doesn't hold — the CLI is spawned detached
    // (pid === PGID) and reapSession() kills the whole process group, so a background
    // shell is reaped with the CLI. Verified that enabling it leaves the running→idle
    // turn-completion signal intact. Keep in sync with daemon-standalone.ts.
    env: {
      ...process.env,
      MCP_CONNECTION_NONBLOCKING: '1',
      CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1',
    },
  });

  // Write initial message to FIFO
  const payload = JSON.stringify({
    type: 'user',
    message: { role: 'user', content: message },
  });
  fs.writeSync(pipeFd, Buffer.from(payload + '\\n'));
  fs.closeSync(pipeFd);

  // Close fds in parent
  fs.closeSync(outputFd);
  fs.closeSync(stderrFd);

  // Save PID
  const pid = proc.pid;
  proc.unref();
  try { fs.writeFileSync(pgidPath, String(pid)); } catch {}

  logStateTransition(sid, 'none', 'running', resume ? 'spawn-resume' : 'spawn-fresh', 'cmdStart', { pid });
  logMsg('info', 'session started', { sid, pid, resume: !!resume });

  // Track session
  const sessionData = {
    proc,
    pipePath,
    jsonlPath,
    pgidPath,
    pid,
    offset,
    taskState: resume ? rebuildTaskStateFromJsonl(jsonlPath, Date.now()) : emptyTaskState(),
    watcher: null,           // session-bound file tailer (see ensureWatcher)
    subscribers: new Set(),  // ws clients receiving push events
    exitCode: null,
    state: 'running',
    exitReason: null,
    exitedAt: null,
    parented: true,
    startTime: readStartTime(pid),
    cwd,
    args,
    orphanPollTimer: null,
    mode: mode || 'default',
    pendingCtrl: null,
    spawnTs: Date.now(),     // latency instrumentation: CLI spawn → first init line
    sawInit: false,
  };

  proc.on('exit', (code) => {
    // Generation guard: if cmdStart replaced this sid (killing this process),
    // the map holds the replacement — the OLD process's death must not reap
    // the NEW session. Keep in sync with daemon-standalone.ts.
    if (sessions.get(sid) !== sessionData) return;
    reapSession(sid, code == null ? 1 : code, 'proc-exit');
  });

  sessions.set(sid, sessionData);
  try { persistRegistry(); } catch {}

  broadcastSessionState(sid, 'running', { pid });
  // Session-bound watcher: lives for the session lifetime, independent of ws.
  // addSubscriber both ensures the watcher exists and adds this ws to the
  // subscribers set; fromOffset=offset replays nothing (fresh file).
  addSubscriber(ws, sid, offset);

  sendOk(ws, id, { pid, outputFile: jsonlPath, offset });
}

// ── Permission policy helpers ──

function shouldAutoRespond(mode, toolName) {
  if (mode === 'bypass') return true;
  if (mode === 'plan') return toolName !== 'ExitPlanMode';
  return false;
}

function buildControlResponse(requestId, request, allow, message) {
  const result = allow
    ? { behavior: 'allow', updatedInput: request.input || {} }
    : { behavior: 'deny', message: message || 'Permission denied by daemon policy' };
  return JSON.stringify({
    type: 'control_response',
    response: { subtype: 'success', request_id: requestId, response: result },
  });
}

function writeFifoRaw(pipePath, raw) {
  try {
    const buf = Buffer.from(raw.endsWith('\\n') ? raw : raw + '\\n');
    return writeFifoFully(pipePath, buf) === 'ok';
  } catch { return false; }
}

// Write a full buffer to a FIFO with O_NONBLOCK + retry. PIPE_BUF on macOS is
// 512 bytes; a single non-blocking writeSync of a larger buffer may return a
// partial count, and stopping there leaves the pipe corrupted (CLI's stdin
// line parser will splice the truncated fragment with whatever bytes follow,
// causing JSON.parse to fail and the CLI to exit). Loop on partial writes,
// short-retry on EAGAIN, surface ENXIO when the reader is gone.
//
// Returns: 'ok' (full write), 'ENXIO' (no reader), 'EAGAIN' (no progress
// within budget), or 'partial' (some bytes written but not all — caller MUST
// reap because the pipe now holds half a JSON line).
function writeFifoFully(pipePath, buf) {
  let fd;
  try {
    fd = fs.openSync(pipePath, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
  } catch (err) {
    if (err && err.code === 'ENXIO') return 'ENXIO';
    throw err;
  }
  try {
    let offset = 0;
    let consecutiveEagain = 0;
    const MAX_EAGAIN_RETRIES = 50; // ~500ms total
    while (offset < buf.length) {
      try {
        const n = fs.writeSync(fd, buf, offset, buf.length - offset);
        if (n > 0) { offset += n; consecutiveEagain = 0; continue; }
        consecutiveEagain++;
      } catch (err) {
        if (err && err.code === 'EAGAIN') {
          if (offset === 0 && consecutiveEagain === 0) return 'EAGAIN';
          consecutiveEagain++;
        } else {
          throw err;
        }
      }
      if (consecutiveEagain >= MAX_EAGAIN_RETRIES) {
        return offset === 0 ? 'EAGAIN' : 'partial';
      }
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); } catch {}
    }
    return 'ok';
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
}

// ── File watching for JSONL streaming ──
//
// Watcher lifecycle is bound to the session, not to any WebSocket. A single
// poll timer per session reads the JSONL file and fans out new lines to all
// currently-subscribed ws clients. ws connects/disconnects do not affect the
// watcher.

// Idempotent: if the session already has a watcher, does nothing.
function ensureWatcher(sid) {
  const session = sessions.get(sid);
  if (!session) return;
  if (session.watcher) return; // already running
  if (session.state !== 'running') return;

  let offset = session.offset || 0;
  // Tailer self-heal (incident 6c8428ac): a per-tick exception swallowed by the old
  // empty catch froze offset forever while the CLI kept writing. Track consecutive
  // failures; persistent failure = stalled tailer, log + rebuild. Keep in sync with
  // daemon-standalone.ts.
  let consecutiveErrors = 0;
  let lastErrorLogTs = 0;
  const STALL_ERRORS_BEFORE_HEAL = 50; // ~5s of 100ms ticks failing back-to-back
  const HEAL_COOLDOWN_MS = 60000;

  const pollTimer = setInterval(() => {
    const s = sessions.get(sid);
    if (!s || s.state !== 'running') return; // reapSession will clean up
    try {
      const stat = fs.statSync(s.jsonlPath);
      if (stat.size <= offset) { consecutiveErrors = 0; return; }

      const fd = fs.openSync(s.jsonlPath, 'r');
      const bytesToRead = stat.size - offset;
      const buf = Buffer.alloc(bytesToRead);
      fs.readSync(fd, buf, 0, bytesToRead, offset);
      fs.closeSync(fd);
      consecutiveErrors = 0;
      const batchStart = offset;
      offset = stat.size;
      s.watcher.offset = offset; // expose for catch-up

      const text = buf.toString('utf-8');
      const lines = text.split('\\n');
      // L1 versioned events: v = end-of-line byte offset in the append-only jsonl
      // (monotonic per session, identical live vs replay). Accumulate across EVERY line
      // incl. skipped/control so v stays byte-aligned. Keep in sync with daemon-standalone.ts.
      let lineStartV = batchStart;
      for (const line of lines) {
        const v = lineStartV + Buffer.byteLength(line, 'utf-8') + 1;
        lineStartV = v;
        if (!line.trim()) continue;

        // ── Latency instrumentation: time from CLI spawn to first init line ──
        // Pure CLI cold-start (incl. MCP connect) as seen by the daemon,
        // directly comparable to running claude by hand. Logged once per session.
        if (!s.sawInit && line.includes('"type":"system"') && line.includes('"init"')) {
          s.sawInit = true;
          logMsg('info', 'first init line from CLI', {
            sid, spawnToInitMs: s.spawnTs ? Date.now() - s.spawnTs : null,
          });
        }

        // ── L2: materialize daemon-authoritative task state ──
        // Cheap substring pre-filter so we JSON.parse only task_* lines. Served on getState
        // so Walnut reconciles a lost-terminal event without guessing liveness.
        if (line.includes('"task_')) {
          try {
            const parsed = JSON.parse(line);
            if (applyTaskEvent(s.taskState, parsed, v, Date.now())) {
              logMsg('info', 'task transition', {
                sid, bgTaskId: parsed.task_id, status: s.taskState.tasks[parsed.task_id] && s.taskState.tasks[parsed.task_id].status,
                derivedRunning: s.taskState.derivedRunning, v,
              });
            }
          } catch {}
        }

        // ── Permission policy intercept ──
        if (line.includes('"control_request"') || line.includes('"control_response"')) {
          try {
            const parsed = JSON.parse(line);
            if (parsed.type === 'control_request' && parsed.request_id
              && parsed.request && parsed.request.subtype === 'can_use_tool') {
              const toolName = parsed.request.tool_name;
              if (shouldAutoRespond(s.mode, toolName)) {
                const resp = buildControlResponse(parsed.request_id, parsed.request, true);
                writeFifoRaw(s.pipePath, resp);
                s.pendingCtrl = null;
                logMsg('info', 'auto-allowed control_request', { sid, tool: toolName, mode: s.mode });
                continue;
              }
              s.pendingCtrl = { reqId: parsed.request_id, toolName: toolName || 'unknown', request: parsed.request, receivedAt: Date.now() };
            } else if (parsed.type === 'control_response' && s.pendingCtrl) {
              if (parsed.response && parsed.response.request_id === s.pendingCtrl.reqId) {
                s.pendingCtrl = null;
              }
            }
          } catch {}
        }

        for (const ws of s.subscribers) {
          if (ws.readyState === 1) {
            try { sendEvent(ws, 'jsonl', { sid, line, v }); } catch {}
          } else {
            s.subscribers.delete(ws);
          }
        }
      }
    } catch (err) {
      // ENOENT is benign: a fresh session's jsonl doesn't exist until the CLI
      // writes its first line (cold start can take seconds). Not a stall.
      if (err && err.code === 'ENOENT') { consecutiveErrors = 0; return; }
      // NO-SILENT-FAILURES: the old empty catch turned a per-tick error into a
      // permanently frozen tailer with zero log evidence. Log (rate-limited) and
      // self-heal after sustained failure. Keep in sync with daemon-standalone.ts.
      consecutiveErrors++;
      const now = Date.now();
      if (now - lastErrorLogTs > 10000) {
        lastErrorLogTs = now;
        logMsg('error', 'watcher poll tick failed', {
          sid, consecutiveErrors, offset,
          err: err && err.message ? ((err.code || '') + ' ' + err.message) : String(err),
        });
      }
      if (consecutiveErrors >= STALL_ERRORS_BEFORE_HEAL
        && now - (s.lastWatcherHealAt || 0) > HEAL_COOLDOWN_MS) {
        // Generation guard: only heal if WE are still the session's watcher.
        if (!s.watcher || s.watcher.pollTimer !== pollTimer) {
          logMsg('warn', 'stalled watcher is orphaned (session replaced) — clearing self', { sid });
          clearInterval(pollTimer);
          return;
        }
        s.lastWatcherHealAt = now;
        logMsg('error', 'watcher stalled — forcing rebuild', { sid, offset, consecutiveErrors });
        // Persist the frozen offset, tear down, recreate. Rebuilt watcher resumes
        // from session.offset (append-only file, client v-dedup absorbs overlap).
        s.offset = offset;
        stopSessionWatcher(sid);
        ensureWatcher(sid);
      }
    }
  }, 100); // 100ms poll interval — low latency, minimal CPU

  session.watcher = { pollTimer, offset };
}

// Stop the session-bound watcher. Only called from reapSession (session died)
// or daemon shutdown. NEVER called from ws.close.
function stopSessionWatcher(sid) {
  const session = sessions.get(sid);
  if (!session || !session.watcher) return;
  // Save offset back to session so a subsequent ensureWatcher() resumes from
  // here instead of re-streaming the entire jsonl file from byte 0. Matters
  // for cmdRename, where we intentionally tear down + re-create the watcher.
  session.offset = session.watcher.offset;
  try { clearInterval(session.watcher.pollTimer); } catch {}
  session.watcher = null;
}

// Add a ws to a session's subscribers and do a catch-up push from fromOffset
// to the watcher's current offset. Idempotent w.r.t. the subscriber set.
function addSubscriber(ws, sid, fromOffset) {
  const session = sessions.get(sid);
  if (!session) return false;
  session.subscribers.add(ws);
  ensureWatcher(sid); // idempotent

  // Catch-up: replay bytes [fromOffset, currentOffset) to this one ws.
  const currentOffset = session.watcher ? session.watcher.offset : 0;
  const start = typeof fromOffset === 'number' && fromOffset >= 0 ? fromOffset : 0;
  if (start < currentOffset) {
    const bytesToRead = currentOffset - start;
    if (bytesToRead > 256 * 1024) {
      logMsg('warn', 'addSubscriber: large catch-up replay', {
        sid, fromOffset: start, currentOffset, bytesToRead,
      });
    } else {
      logMsg('info', 'addSubscriber: replay', {
        sid, fromOffset: start, currentOffset, bytesToRead,
      });
    }
    try {
      const fd = fs.openSync(session.jsonlPath, 'r');
      const buf = Buffer.alloc(bytesToRead);
      fs.readSync(fd, buf, 0, bytesToRead, start);
      fs.closeSync(fd);
      const text = buf.toString('utf-8');
      // L1: stamp v identically to the live watcher so a replayed line dedupes against the
      // same v the client may already have seen live. Keep in sync with daemon-standalone.ts.
      let lineStartV = start;
      for (const line of text.split('\\n')) {
        const v = lineStartV + Buffer.byteLength(line, 'utf-8') + 1;
        lineStartV = v;
        if (!line.trim() || ws.readyState !== 1) continue;
        // Skip transient permission-protocol lines on replay. control_request/
        // control_response are RPC handshake lines, not session history; replaying
        // them resurrects stale permission prompts in the UI. A genuinely-pending
        // request is recovered out-of-band via pendingCtrl (returned on attach),
        // NOT via replay — so dropping all control lines here loses nothing.
        // Keep in sync with daemon-standalone.ts addSubscriber (CLAUDE.md).
        if (line.includes('"control_request"') || line.includes('"control_response"')) continue;
        try { sendEvent(ws, 'jsonl', { sid, line, v }); } catch {}
      }
    } catch {}
  } else {
    logMsg('info', 'addSubscriber: no replay (future-only)', {
      sid, fromOffset: start, currentOffset,
    });
  }
  return true;
}

// Remove a ws from a session's subscribers. The watcher is NOT touched — it
// keeps reading the JSONL as long as the session process is alive. If the ws
// was the only subscriber, the watcher simply has no one to fan out to (the
// file still gets read and offset advances, which is fine — next attach
// resumes from that offset with no replay needed).
function removeSubscriber(ws, sid) {
  const session = sessions.get(sid);
  if (!session) return;
  session.subscribers.delete(ws);
}

// ── Attach to existing session ──
function cmdAttach(ws, id, cmd) {
  const { sid, fromOffset, mode } = cmd;
  if (!sid) return sendError(ws, id, 'attach: missing sid');

  let session = sessions.get(sid);

  if (!session) {
    // Try to discover from files
    const jsonlPath = path.join(STREAMS_DIR, sid + '.jsonl');
    const pgidPath = path.join(STREAMS_DIR, sid + '.pgid');
    const pipePath = path.join(STREAMS_DIR, sid + '.pipe');

    if (!fs.existsSync(jsonlPath)) {
      return sendError(ws, id, 'attach: session not found: ' + sid);
    }

    let pid = null;
    let alive = false;
    try {
      pid = parseInt(fs.readFileSync(pgidPath, 'utf-8').trim(), 10);
      process.kill(pid, 0); // check alive
      alive = true;
    } catch { pid = null; alive = false; }

    // Watcher starts at the CURRENT end of the stream file — same rule as
    // adopt. Catch-up for [fromOffset, end) is addSubscriber's job. Using the
    // client's fromOffset is wrong both ways: 0 re-fans the whole file;
    // MAX_SAFE_INTEGER (future-only sentinel) freezes the watcher forever.
    // Keep in sync with daemon-standalone.ts (CLAUDE.md).
    let discoveredOffset = 0;
    try { discoveredOffset = fs.statSync(jsonlPath).size; } catch {}

    session = {
      proc: null,
      pipePath,
      jsonlPath,
      pgidPath,
      pid,
      offset: discoveredOffset,
      taskState: rebuildTaskStateFromJsonl(jsonlPath, Date.now()),
      watcher: null,
      subscribers: new Set(),
      exitCode: alive ? null : 0,
      state: alive ? 'running' : 'dead',
      exitReason: alive ? null : 'attach-discovered-dead',
      exitedAt: alive ? null : Date.now(),
      parented: false,
      startTime: pid && alive ? readStartTime(pid) : null,
      cwd: '',
      args: [],
      orphanPollTimer: null,
      mode: mode || 'default',
      pendingCtrl: null,
    };
    sessions.set(sid, session);
    if (alive && pid) startOrphanPoll(sid);
  }

  // Update mode if provided (walnut re-sends mode on reconnect)
  if (mode && session.state === 'running') {
    session.mode = mode;
  }

  const offset = fromOffset || 0;
  let alive = session.state === 'running' && session.pid !== null;
  if (alive && session.pid) {
    try { process.kill(session.pid, 0); } catch {
      reapSession(sid, -1, 'attach-kill-check');
      alive = false;
    }
  }

  if (alive) addSubscriber(ws, sid, offset);

  sendOk(ws, id, {
    pid: session.pid,
    alive,
    state: session.state,
    exitCode: session.exitCode,
    outputFile: session.jsonlPath,
    currentOffset: session.watcher ? session.watcher.offset : 0,
    pendingCtrl: session.pendingCtrl,
  });
}

// ── Send message ──
function cmdSend(ws, id, cmd) {
  const { sid, message } = cmd;
  if (!sid || !message) return sendError(ws, id, 'send: missing sid or message');

  const session = sessions.get(sid);
  if (!session) return sendOk(ws, id, { ok: false, reason: 'not_found' });
  if (session.state === 'dead') {
    return sendOk(ws, id, { ok: false, reason: 'session_dead', exitCode: session.exitCode });
  }

  if (session.pid) {
    try { process.kill(session.pid, 0); } catch {
      reapSession(sid, -1, 'send-precheck-dead');
      return sendOk(ws, id, { ok: false, reason: 'session_dead', exitCode: session.exitCode });
    }
  }

  const payload = JSON.stringify({
    type: 'user',
    message: { role: 'user', content: message },
  });

  try {
    const buf = Buffer.from(payload + '\\n');
    const result = writeFifoFully(session.pipePath, buf);
    if (result === 'ok') {
      sendOk(ws, id, { ok: true });
    } else if (result === 'ENXIO') {
      reapSession(sid, -1, 'send-enxio');
      sendOk(ws, id, { ok: false, reason: 'ENXIO', exitCode: session.exitCode });
    } else if (result === 'EAGAIN') {
      sendOk(ws, id, { ok: false, reason: 'EAGAIN', retriable: true });
    } else {
      // partial — pipe is now corrupted, reap so caller stops trying.
      reapSession(sid, -1, 'send-partial-write');
      sendOk(ws, id, { ok: false, reason: 'session_dead', exitCode: session.exitCode });
    }
  } catch (err) {
    sendError(ws, id, 'send failed: ' + err.message);
  }
}

// Send raw (permission-prompt-tool control_response passthrough)
// Writes 'raw' verbatim to the FIFO, no user-message wrapping.
function cmdSendRaw(ws, id, cmd) {
  const { sid, raw } = cmd;
  if (!sid || !raw) return sendError(ws, id, 'sendRaw: missing sid or raw');

  const session = sessions.get(sid);
  if (!session) return sendOk(ws, id, { ok: false, reason: 'not_found' });
  if (session.state === 'dead') {
    return sendOk(ws, id, { ok: false, reason: 'session_dead', exitCode: session.exitCode });
  }

  if (session.pid) {
    try { process.kill(session.pid, 0); } catch {
      reapSession(sid, -1, 'sendRaw-precheck-dead');
      return sendOk(ws, id, { ok: false, reason: 'session_dead', exitCode: session.exitCode });
    }
  }

  try {
    const buf = Buffer.from(raw.endsWith('\\n') ? raw : raw + '\\n');
    const result = writeFifoFully(session.pipePath, buf);
    if (result === 'ok') {
      sendOk(ws, id, { ok: true });
    } else if (result === 'ENXIO') {
      reapSession(sid, -1, 'sendRaw-enxio');
      sendOk(ws, id, { ok: false, reason: 'ENXIO', exitCode: session.exitCode });
    } else if (result === 'EAGAIN') {
      sendOk(ws, id, { ok: false, reason: 'EAGAIN', retriable: true });
    } else {
      reapSession(sid, -1, 'sendRaw-partial-write');
      sendOk(ws, id, { ok: false, reason: 'session_dead', exitCode: session.exitCode });
    }
  } catch (err) {
    sendError(ws, id, 'sendRaw failed: ' + err.message);
  }
}

// ── Append turn-start user marker to the stream file ──
// The CLI never echoes stdin user messages to stream-json stdout, so the
// stream file records turn ENDs (result) but no turn STARTs. This marker is
// the reconciler's turn anchor. Keep in sync with daemon-core.ts
// handleAppendUserMarker (daemon-standalone.ts).
function cmdAppendUserMarker(ws, id, cmd) {
  const { sid, message, messageId } = cmd;
  if (!sid || !message || !messageId) return sendError(ws, id, 'appendUserMarker: missing sid, message, or messageId');
  const session = sessions.get(sid);
  if (!session) return sendOk(ws, id, { ok: false, reason: 'not_found' });
  try {
    const line = JSON.stringify({
      type: 'user',
      subtype: 'walnut-injected',
      message: { role: 'user', content: message },
      walnutMessageId: messageId,
      timestamp: new Date().toISOString(),
    }) + '\\n';
    fs.appendFileSync(session.jsonlPath, line);
    const size = fs.statSync(session.jsonlPath).size;
    sendOk(ws, id, { ok: true, size });
  } catch (err) {
    sendError(ws, id, 'appendUserMarker failed: ' + err.message);
  }
}

// ── Set session mode ──
function cmdSetMode(ws, id, cmd) {
  const { sid, mode } = cmd;
  if (!sid || !mode) return sendError(ws, id, 'setMode: missing sid or mode');
  const session = sessions.get(sid);
  if (!session) return sendError(ws, id, 'setMode: session not found: ' + sid);
  const oldMode = session.mode;
  session.mode = mode;
  if (session.pendingCtrl && shouldAutoRespond(mode, session.pendingCtrl.toolName)) {
    const resp = buildControlResponse(session.pendingCtrl.reqId, session.pendingCtrl.request, true);
    writeFifoRaw(session.pipePath, resp);
    logMsg('info', 'setMode: auto-allowed pending control_request', { sid, tool: session.pendingCtrl.toolName, mode });
    session.pendingCtrl = null;
  }
  try { persistRegistry(); } catch {}
  sendOk(ws, id, { oldMode, newMode: mode });
}

// ── Stop session ──
function cmdStop(ws, id, cmd) {
  const { sid } = cmd;
  if (!sid) return sendError(ws, id, 'stop: missing sid');

  const session = sessions.get(sid);
  if (!session || !session.pid) {
    logMsg('info', 'cmdStop: session not in registry (nothing to kill)', {
      sid, hasSession: !!session, hasPid: session ? !!session.pid : false,
    });
    return sendOk(ws, id, { stopped: true, noop: true, reason: 'not_in_registry' });
  }

  const pid = session.pid;
  logMsg('info', 'cmdStop: stopping session (process group kill)', { sid, pid });

  // 3-phase process group kill: SIGINT → SIGTERM → SIGKILL
  try {
    killProcessGroup(pid, 'SIGINT');
    let checks = 0;
    const checkExit = () => {
      if (!isProcessGroupAlive(pid)) {
        sendOk(ws, id, { stopped: true });
        return;
      }
      checks++;
      if (checks >= 25) { // 5s elapsed
        killProcessGroup(pid, 'SIGTERM');
        setTimeout(() => {
          if (isProcessGroupAlive(pid)) {
            killProcessGroup(pid, 'SIGKILL');
          }
          sendOk(ws, id, { stopped: true, forced: true });
        }, 2000);
        return;
      }
      setTimeout(checkExit, 200);
    };
    setTimeout(checkExit, 200);
  } catch {
    sendOk(ws, id, { stopped: true });
  }
}

// ── Status ──
function cmdStatus(ws, id, cmd) {
  const { sid } = cmd;
  if (!sid) return sendError(ws, id, 'status: missing sid');

  const session = sessions.get(sid);
  if (!session) return sendOk(ws, id, { exists: false });

  let alive = session.state === 'running';
  if (alive && session.pid) {
    try { process.kill(session.pid, 0); } catch {
      reapSession(sid, -1, 'status-kill-check');
      alive = false;
    }
  }

  let mtime = null, size = 0;
  try {
    const stat = fs.statSync(session.jsonlPath);
    mtime = stat.mtime.toISOString();
    size = stat.size;
  } catch {}

  sendOk(ws, id, {
    exists: true,
    alive,
    pid: session.pid,
    mtime,
    size,
    state: session.state,
    exitCode: session.exitCode,
    exitReason: session.exitReason,
    pendingCtrl: session.pendingCtrl,
  });
}

// ── L2: getState — daemon-authoritative background-task state (the PULL source of truth) ──
// Walnut PULLs this to reconcile a lost-terminal event without guessing liveness. If unknown in
// memory but the jsonl exists, rebuild from disk. Keep in sync with daemon-standalone.ts.
function cmdGetState(ws, id, cmd) {
  const { sid } = cmd;
  if (!sid) return sendError(ws, id, 'getState: missing sid');

  const session = sessions.get(sid);
  if (session) {
    return sendOk(ws, id, {
      exists: true,
      alive: session.state === 'running',
      state: session.state,
      taskState: session.taskState,
    });
  }
  const jsonlPath = path.join(STREAMS_DIR, sid + '.jsonl');
  if (!fs.existsSync(jsonlPath)) return sendOk(ws, id, { exists: false });
  const taskState = rebuildTaskStateFromJsonl(jsonlPath, Date.now());
  return sendOk(ws, id, { exists: true, alive: false, state: 'dead', taskState });
}

// ── Rename session files ──
function cmdRename(ws, id, cmd) {
  const { oldSid, newSid } = cmd;
  if (!oldSid || !newSid) return sendError(ws, id, 'rename: missing oldSid or newSid');
  if (oldSid === newSid) return sendOk(ws, id, { renamed: true });

  const session = sessions.get(oldSid);
  if (!session) return sendError(ws, id, 'rename: session not found: ' + oldSid);

  const oldBase = path.join(STREAMS_DIR, oldSid);
  const newBase = path.join(STREAMS_DIR, newSid);

  try {
    for (const ext of ['.jsonl', '.jsonl.err', '.pipe', '.pgid', '.log']) {
      try { fs.renameSync(oldBase + ext, newBase + ext); } catch {}
    }
    session.jsonlPath = newBase + '.jsonl';
    session.pipePath = newBase + '.pipe';
    session.pgidPath = newBase + '.pgid';

    // The session-bound watcher's pollTimer closure captured the OLD sid and
    // looks up sessions.get(oldSid) each tick. After the re-key below, that
    // lookup returns undefined and the watcher silently stops fanning out
    // jsonl lines — users see the session "go deaf" mid-turn (UI stuck on
    // "Walnut is working…" until the whole session ends). Fix: stop the old
    // watcher before re-keying, then re-create it against the new sid so its
    // closure captures the right key. Subscribers stay put — they only hold
    // ws refs, not sid — so no re-attach is needed from the client side.
    stopSessionWatcher(oldSid);

    sessions.delete(oldSid);
    sessions.set(newSid, session);

    ensureWatcher(newSid);

    sendOk(ws, id, { renamed: true });
    logMsg('info', 'session renamed', { oldSid, newSid });
  } catch (err) {
    sendError(ws, id, 'rename failed: ' + err.message);
  }
}

// ── Read history ──
function cmdReadHistory(ws, id, cmd) {
  const { sid, canonicalPath, tailBytes } = cmd;
  if (!sid) return sendError(ws, id, 'read-history: missing sid');

  try {
    // Read main JSONL. tailBytes > 0 = tail-only read (mobile transcript) —
    // whale sessions must not ride the bridge as one frame. The first
    // (possibly partial) line after the cut is dropped. Keep in sync with
    // daemon-standalone.ts.
    let mainContent = '';
    const jsonlPath = canonicalPath || path.join(STREAMS_DIR, sid + '.jsonl');
    const wantTail = typeof tailBytes === 'number' && tailBytes > 0;
    try {
      if (wantTail) {
        const st = fs.statSync(jsonlPath);
        const start = Math.max(0, st.size - tailBytes);
        const fd = fs.openSync(jsonlPath, 'r');
        try {
          const buf = Buffer.alloc(st.size - start);
          fs.readSync(fd, buf, 0, buf.length, start);
          mainContent = buf.toString('utf-8');
          if (start > 0) {
            // NOTE: template string — '\\n' must stay escaped or the emitted
            // JS gets a literal newline inside the quotes (parse error).
            const nl = mainContent.indexOf('\\n');
            mainContent = nl >= 0 ? mainContent.slice(nl + 1) : '';
          }
        } finally { fs.closeSync(fd); }
      } else {
        mainContent = fs.readFileSync(jsonlPath, 'utf-8');
      }
    } catch {}

    // Read subagents (skipped on tail reads — transcripts are main-lane only)
    const subagents = {};
    if (!wantTail) {
      const subagentDir = path.dirname(jsonlPath) + '/' + sid + '/subagents';
      try {
        const files = fs.readdirSync(subagentDir);
        for (const f of files) {
          if (f.endsWith('.jsonl')) {
            try {
              subagents[f] = fs.readFileSync(path.join(subagentDir, f), 'utf-8');
            } catch {}
          }
        }
      } catch {}
    }

    sendOk(ws, id, { main: mainContent, subagents });
  } catch (err) {
    sendError(ws, id, 'read-history failed: ' + err.message);
  }
}

// ── Subscribe to subagent ──
function cmdSubscribeAgent(ws, id, cmd) {
  const { sid, agent, team, offsets } = cmd;
  if (!sid || !agent) return sendError(ws, id, 'subscribe-agent: missing sid or agent');

  const subKey = sid + ':' + agent;

  // Unsubscribe existing
  const existing = agentSubs.get(subKey);
  if (existing) {
    clearInterval(existing.timer);
    clearInterval(existing.rediscoverTimer);
    agentSubs.delete(subKey);
  }

  const sub = {
    files: new Map(), // filePath → { offset }
    timer: null,
    rediscoverTimer: null,
    ws,
    sid,
    agent,
    team,
  };

  // Discover agent JSONL files
  function discoverFiles() {
    try {
      // Look in session subagents dir
      const sessionDir = path.join(STREAMS_DIR, sid, 'subagents');
      try {
        const files = fs.readdirSync(sessionDir);
        for (const f of files) {
          if (!f.endsWith('.jsonl')) continue;
          // Match by agent name in filename
          if (f.toLowerCase().includes(agent.toLowerCase()) || f.includes(agent)) {
            const fullPath = path.join(sessionDir, f);
            if (!sub.files.has(fullPath)) {
              const startOffset = (offsets && offsets[f]) || 0;
              sub.files.set(fullPath, { offset: startOffset });
            }
          }
        }
      } catch {}

      // Also look in Claude canonical dir for the agent
      const claudeDir = path.join(HOME_DIR, '.claude', 'projects');
      // We'd need the encoded CWD path — this is complex. For now, scan streams dir.
    } catch {}
  }

  // Poll for new data
  function pollData() {
    for (const [filePath, fileState] of sub.files) {
      try {
        const stat = fs.statSync(filePath);
        if (stat.size > fileState.offset) {
          const fd = fs.openSync(filePath, 'r');
          const bytes = stat.size - fileState.offset;
          const buf = Buffer.alloc(bytes);
          fs.readSync(fd, buf, 0, bytes, fileState.offset);
          fs.closeSync(fd);
          fileState.offset = stat.size;

          const lines = buf.toString('utf-8').split('\\n').filter(l => l.trim());
          if (lines.length > 0) {
            sendEvent(ws, 'agent', {
              sid,
              agent,
              file: path.basename(filePath),
              lines,
            });
          }
        }
      } catch {}
    }
  }

  // Initial discovery + data send
  discoverFiles();
  pollData();

  // Start polling
  sub.timer = setInterval(pollData, AGENT_POLL_INTERVAL_MS);
  sub.rediscoverTimer = setInterval(discoverFiles, AGENT_REDISCOVER_INTERVAL_MS);

  agentSubs.set(subKey, sub);
  sendOk(ws, id, { subscribed: true, files: [...sub.files.keys()] });
}

// ── Unsubscribe from subagent ──
function cmdUnsubscribeAgent(ws, id, cmd) {
  const { sid, agent } = cmd;
  const subKey = sid + ':' + agent;
  const sub = agentSubs.get(subKey);
  if (sub) {
    clearInterval(sub.timer);
    clearInterval(sub.rediscoverTimer);
    agentSubs.delete(subKey);
  }
  sendOk(ws, id, { unsubscribed: true });
}

// ── Write to team inbox ──
function cmdWriteInbox(ws, id, cmd) {
  const { team, agent, from, text, summary } = cmd;
  if (!team || !agent || !text) return sendError(ws, id, 'write-inbox: missing fields');

  const inboxPath = path.join(HOME_DIR, '.claude', 'teams', team, 'inboxes', agent + '.json');

  try {
    fs.mkdirSync(path.dirname(inboxPath), { recursive: true });

    let inbox = [];
    try { inbox = JSON.parse(fs.readFileSync(inboxPath, 'utf-8')); } catch {}
    if (!Array.isArray(inbox)) inbox = [];

    inbox.push({
      from: from || 'walnut',
      text,
      summary: summary || text.slice(0, 100),
      timestamp: new Date().toISOString(),
      read: false,
    });

    fs.writeFileSync(inboxPath, JSON.stringify(inbox, null, 2));
    sendOk(ws, id, { written: true });
  } catch (err) {
    sendError(ws, id, 'write-inbox failed: ' + err.message);
  }
}

// ── File system operations ──
// NOTE: use fs.promises.* instead of sync calls — a large file read (e.g. a
// 50MB session JSONL) would otherwise block every queued RPC on this daemon
// until it completes.
async function cmdFsRead(ws, id, cmd) {
  let filePath = cmd.path;
  const encoding = cmd.encoding;
  if (!filePath) return sendError(ws, id, 'fs.read: missing path');

  // Expand ~ to home directory (Node fs doesn't do shell expansion)
  if (filePath === '~' || filePath.startsWith('~/')) {
    filePath = HOME_DIR + filePath.slice(1);
  }

  try {
    const enc = encoding || 'base64';
    const data = await fs.promises.readFile(filePath);
    if (enc === 'base64') {
      sendOk(ws, id, { data: data.toString('base64'), encoding: 'base64' });
    } else {
      sendOk(ws, id, { data: data.toString('utf-8'), encoding: 'utf-8' });
    }
  } catch (err) {
    // Tag ENOENT so the server can distinguish "file not found" from transport failure.
    const code = err.code || '';
    sendError(ws, id, 'fs.read failed: ' + err.message + (code ? ' (' + code + ')' : ''));
  }
}

async function cmdFsWrite(ws, id, cmd) {
  const { path: filePath, data, encoding } = cmd;
  if (!filePath || !data) return sendError(ws, id, 'fs.write: missing path or data');

  try {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    const enc = encoding || 'base64';
    const buf = enc === 'base64' ? Buffer.from(data, 'base64') : Buffer.from(data, 'utf-8');
    await fs.promises.writeFile(filePath, buf);
    sendOk(ws, id, { written: true, size: buf.length });
  } catch (err) {
    sendError(ws, id, 'fs.write failed: ' + err.message);
  }
}

async function cmdFsLs(ws, id, cmd) {
  let dirPath = cmd.path;
  if (!dirPath) return sendError(ws, id, 'fs.ls: missing path');

  // Expand ~ to home directory (Node fs doesn't do shell expansion)
  if (dirPath === '~' || dirPath.startsWith('~/')) {
    dirPath = HOME_DIR + dirPath.slice(1);
  }

  try {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    const result = entries.map(e => ({
      name: e.name,
      type: e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other',
    }));
    sendOk(ws, id, { entries: result, resolvedPath: dirPath });
  } catch (err) {
    sendError(ws, id, 'fs.ls failed: ' + err.message);
  }
}

async function cmdFsFind(ws, id, cmd) {
  let basePath = cmd.path || '~/.claude/projects';
  const name = cmd.name;
  const maxDepth = cmd.maxDepth || 3;
  if (!name) return sendError(ws, id, 'fs.find: missing name');

  // Expand ~ to home directory
  if (basePath === '~' || basePath.startsWith('~/')) {
    basePath = HOME_DIR + basePath.slice(1);
  }

  try {
    const found = [];
    async function walk(dir, depth) {
      if (depth > maxDepth || found.length >= 10) return;
      let entries;
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (found.length >= 10) return;
        const full = path.join(dir, e.name);
        if (e.isFile() && e.name.includes(name)) {
          found.push(full);
          if (found.length >= 10) return;
        } else if (e.isDirectory()) {
          await walk(full, depth + 1);
        }
      }
    }
    await walk(basePath, 0);
    sendOk(ws, id, { files: found });
  } catch (err) {
    sendError(ws, id, 'fs.find failed: ' + err.message);
  }
}

async function cmdFsStat(ws, id, cmd) {
  let filePath = cmd.path;
  if (!filePath) return sendError(ws, id, 'fs.stat: missing path');

  if (filePath === '~' || filePath.startsWith('~/')) {
    filePath = HOME_DIR + filePath.slice(1);
  }

  try {
    const st = await fs.promises.stat(filePath);
    sendOk(ws, id, { exists: true, mtimeMs: st.mtimeMs, size: st.size });
  } catch (err) {
    if (err.code === 'ENOENT') {
      sendOk(ws, id, { exists: false });
      return;
    }
    sendError(ws, id, 'fs.stat failed: ' + err.message);
  }
}

// Byte-range read for LARGE files. A whole-file fs.read of a multi-MB session
// JSONL serializes into ONE giant WS frame; some corporate SSH proxies kill the
// tunnel mid-frame and the read times out forever (inc-1783532915925). Range
// reads keep frames small and double as the incremental turn-delta path.
// base64 (byte-exact; the CLIENT reassembles bytes then decodes UTF-8).
// Keep in sync with daemon-standalone.ts cmdFsReadRange.
async function cmdFsReadRange(ws, id, cmd) {
  let filePath = cmd.path;
  const start = typeof cmd.start === 'number' && cmd.start >= 0 ? cmd.start : 0;
  const length = typeof cmd.length === 'number' && cmd.length > 0
    ? Math.min(cmd.length, 4 * 1024 * 1024) : 1024 * 1024;
  if (!filePath) return sendError(ws, id, 'fs.readRange: missing path');

  if (filePath === '~' || filePath.startsWith('~/')) {
    filePath = HOME_DIR + filePath.slice(1);
  }

  let fh = null;
  try {
    fh = await fs.promises.open(filePath, 'r');
    const st = await fh.stat();
    if (start >= st.size) {
      sendOk(ws, id, { data: '', bytesRead: 0, fileSize: st.size, eof: true });
      return;
    }
    const toRead = Math.min(length, st.size - start);
    const buf = Buffer.alloc(toRead);
    const readResult = await fh.read(buf, 0, toRead, start);
    sendOk(ws, id, {
      data: buf.subarray(0, readResult.bytesRead).toString('base64'),
      bytesRead: readResult.bytesRead,
      fileSize: st.size,
      eof: start + readResult.bytesRead >= st.size,
    });
  } catch (err) {
    const code = err.code || '';
    sendError(ws, id, 'fs.readRange failed: ' + err.message + (code ? ' (' + code + ')' : ''));
  } finally {
    try { if (fh) await fh.close(); } catch { /* already closed */ }
  }
}

// -- Git diff (whole-repo, host-local) --
// Inlined equivalent of git-diff-core.ts (this daemon code is an embedded string
// template, so it can NOT import and must NOT contain backticks). Runs git HERE
// on the host, so no per-file network round trips. Keep in sync with git-diff-core.ts.
async function cmdGitDiff(ws, id, cmd) {
  let cwd = cmd.cwd;
  const base = cmd.base;
  if (!cwd) return sendError(ws, id, 'git.diff: missing cwd');
  if (base !== 'uncommitted' && base !== 'previous' && base !== 'remote') {
    return sendError(ws, id, 'git.diff: invalid base');
  }
  if (cwd === '~' || cwd.startsWith('~/')) cwd = HOME_DIR + cwd.slice(1);

  const cp = require('child_process');
  const exec = (argv, runCwd) => new Promise((resolve) => {
    cp.execFile(argv[0], argv.slice(1), { cwd: runCwd, timeout: 25000, maxBuffer: 64 * 1024 * 1024, encoding: 'utf-8' },
      (err, stdout, stderr) => {
        if (!err) return resolve({ stdout: stdout, stderr: stderr, code: 0 });
        resolve({ stdout: stdout || '', stderr: stderr || err.message, code: typeof err.code === 'number' ? err.code : 1 });
      });
  });
  const readText = async (absPath) => {
    try { return await fs.promises.readFile(absPath, 'utf-8'); } catch (e) { return ''; }
  };
  const joinPosix = (a, b) => !a ? b : (a.endsWith('/') ? a + b : a + '/' + b);

  try {
    const rootRes = await exec(['git', 'rev-parse', '--show-toplevel'], cwd);
    if (rootRes.code !== 0 || !rootRes.stdout.trim()) return sendOk(ws, id, { repoRoot: null, files: [] });
    const repoRoot = rootRes.stdout.trim();

    // Resolve base rev.
    let baseRev;
    if (base === 'uncommitted') baseRev = 'HEAD';
    else if (base === 'previous') baseRev = 'HEAD~1';
    else {
      const up = await exec(['git', 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], repoRoot);
      if (up.code === 0 && up.stdout.trim()) baseRev = up.stdout.trim();
      else {
        const br = await exec(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], repoRoot);
        const branch = br.stdout.trim();
        baseRev = (branch && branch !== 'HEAD') ? ('origin/' + branch) : 'origin/HEAD';
      }
    }

    const ns = await exec(['git', 'diff', '--name-status', '-z', baseRev], repoRoot);
    if (ns.code !== 0) return sendError(ws, id, ns.stderr.trim() || ('git diff against ' + baseRev + ' failed'));

    // Parse name-status -z.
    const entries = [];
    const parts = ns.stdout.split('\0');
    for (let i = 0; i < parts.length;) {
      const code = parts[i];
      if (!code) { i++; continue; }
      const letter = code[0];
      if (letter === 'R' || letter === 'C') {
        const oldRel = parts[i + 1], newRel = parts[i + 2]; i += 3;
        if (newRel) entries.push({ status: 'modified', relPath: newRel, oldRelPath: oldRel });
      } else {
        const rel = parts[i + 1]; i += 2;
        if (rel) entries.push({ status: letter === 'A' ? 'added' : letter === 'D' ? 'deleted' : 'modified', relPath: rel });
      }
    }

    // Untracked (read-only) → 'added'.
    const tracked = new Set(entries.map((e) => e.relPath));
    const others = await exec(['git', 'ls-files', '--others', '--exclude-standard', '-z'], repoRoot);
    if (others.code === 0) {
      for (const rel of others.stdout.split('\0')) {
        if (rel && !tracked.has(rel)) { entries.push({ status: 'added', relPath: rel }); tracked.add(rel); }
      }
    }
    if (entries.length === 0) return sendOk(ws, id, { repoRoot: repoRoot, files: [] });

    const files = [];
    for (const e of entries) {
      const beforePath = e.oldRelPath || e.relPath;
      let before = '';
      if (e.status !== 'added') {
        const show = await exec(['git', 'show', baseRev + ':' + beforePath], repoRoot);
        before = show.code === 0 ? show.stdout : '';
      }
      const after = e.status === 'deleted' ? '' : await readText(joinPosix(repoRoot, e.relPath));
      files.push({ relPath: e.relPath, before: before, after: after, status: e.status });
    }
    files.sort((a, b) => a.relPath.localeCompare(b.relPath));
    sendOk(ws, id, { repoRoot: repoRoot, files: files });
  } catch (err) {
    sendError(ws, id, 'git.diff failed: ' + err.message);
  }
}

// ── List all sessions ──
function cmdList(ws, id) {
  const result = [];

  // Scan streams dir for PGID files
  try {
    const files = fs.readdirSync(STREAMS_DIR);
    for (const f of files) {
      if (!f.endsWith('.pgid')) continue;
      const sid = f.replace('.pgid', '');
      try {
        const pid = parseInt(fs.readFileSync(path.join(STREAMS_DIR, f), 'utf-8').trim(), 10);
        let alive = false;
        try { process.kill(pid, 0); alive = true; } catch {}

        let mtime = null, size = 0;
        try {
          const stat = fs.statSync(path.join(STREAMS_DIR, sid + '.jsonl'));
          mtime = stat.mtime.toISOString();
          size = stat.size;
        } catch {}

        result.push({ sid, pid, alive, mtime, size });
      } catch {}
    }
  } catch {}

  // Also include in-memory sessions not yet persisted. Prefer authoritative
  // state: if reaper has marked session dead, report alive=false without probing.
  for (const [sid, session] of sessions) {
    if (!result.find(r => r.sid === sid)) {
      let alive = false;
      if (session.state === 'running' && session.pid) {
        try { process.kill(session.pid, 0); alive = true; } catch {}
      }
      result.push({
        sid,
        pid: session.pid,
        alive,
        state: session.state || (alive ? 'running' : 'dead'),
        exitCode: session.exitCode,
        mtime: null,
        size: 0,
      });
    }
  }

  sendOk(ws, id, { sessions: result });
}

// ── Protocol helpers ──
// PARITY NOTE (vs daemon-standalone.ts safeSend): the Bun binary needs a
// drain-queue because Bun's ServerWebSocket.send() silently DROPS messages
// (returns 0) under backpressure. This file runs on plain Node where the ws
// package (and the manual socket.write wrapper) buffer internally and never
// drop — so raw send() here is equivalent to safeSend there. Do not "fix"
// this asymmetry by porting the queue; do keep it in mind if the transport
// ever changes.
function sendOk(ws, id, data) {
  try { ws.send(JSON.stringify({ id, ok: true, ...data })); } catch {}
}

function sendError(ws, id, error) {
  logMsg('error', 'command error', { id, error });
  try { ws.send(JSON.stringify({ id, ok: false, error })); } catch {}
}

function sendEvent(ws, ev, data) {
  try { ws.send(JSON.stringify({ ev, ...data })); } catch {}
}

// ── Cloud bridge: daemon dials OUT to the cloud companion ──
// Mirror of daemon-standalone.ts (keep in sync — CLAUDE.md). The outbound
// socket is treated as just another client: inbound frames go through
// handleCommand, jsonl fan-out reaches it via the session subscriber sets.
// Config arrives via bridge.configure (pushed by the Mac) and persists to
// bridge.json so a restarted daemon re-dials without the Mac.

const BRIDGE_FILE = path.join(DAEMON_DIR, 'bridge.json');

let bridgeConfig = null;
let bridgeClient = null;
let bridgeAdapter = null;
let bridgeRedialTimer = null;
let bridgePingTimer = null;
let bridgeBackoffMs = 1000;
let bridgeGeneration = 0;
let bridgeLastInbound = 0;

const BRIDGE_BACKOFF_MAX_MS = 60000;
const BRIDGE_PING_INTERVAL_MS = 30000;
const BRIDGE_SILENCE_MS = 75000;

function getWsClientCtor() {
  // Node 22+ has a global browser-style WebSocket client; older deploys get
  // the ws package installed by deploySource(). Either works for dialing out.
  if (typeof globalThis.WebSocket === 'function') return globalThis.WebSocket;
  try { return require('ws').WebSocket || require('ws'); } catch {}
  try { return require('node:ws').WebSocket; } catch {}
  return null;
}

function loadBridgeConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(BRIDGE_FILE, 'utf-8'));
    if (raw && typeof raw.url === 'string' && typeof raw.token === 'string'
      && typeof raw.hostAlias === 'string') {
      bridgeConfig = raw;
    }
  } catch { /* no bridge configured */ }
}

function cmdBridgeConfigure(ws, id, cmd) {
  const url = cmd.url, token = cmd.token, hostAlias = cmd.hostAlias, enabled = cmd.enabled;
  if (enabled && (typeof url !== 'string' || typeof token !== 'string' || typeof hostAlias !== 'string')) {
    return sendError(ws, id, 'bridge.configure: url, token, hostAlias required when enabled');
  }
  const next = {
    enabled: !!enabled,
    url: url != null ? url : (bridgeConfig ? bridgeConfig.url : ''),
    token: token != null ? token : (bridgeConfig ? bridgeConfig.token : ''),
    hostAlias: hostAlias != null ? hostAlias : (bridgeConfig ? bridgeConfig.hostAlias : ''),
  };
  const changed = JSON.stringify(next) !== JSON.stringify(bridgeConfig);
  bridgeConfig = next;
  try {
    fs.writeFileSync(BRIDGE_FILE, JSON.stringify(next), { mode: 0o600 });
  } catch (err) {
    logMsg('error', 'bridge: failed to persist bridge.json', { err: err.message });
  }
  if (changed) startBridge('configure');
  logMsg('info', 'bridge: configured', { enabled: next.enabled, hostAlias: next.hostAlias, changed });
  sendOk(ws, id, { applied: true, connected: bridgeAdapter != null });
}

function stopBridge() {
  bridgeGeneration++;
  if (bridgeRedialTimer) { clearTimeout(bridgeRedialTimer); bridgeRedialTimer = null; }
  if (bridgePingTimer) { clearInterval(bridgePingTimer); bridgePingTimer = null; }
  if (bridgeAdapter) {
    wsClients.delete(bridgeAdapter);
    for (const [, session] of sessions) session.subscribers.delete(bridgeAdapter);
    for (const [key, sub] of agentSubs) {
      if (sub.ws === bridgeAdapter) {
        clearInterval(sub.timer);
        clearInterval(sub.rediscoverTimer);
        agentSubs.delete(key);
      }
    }
  }
  if (bridgeClient) { try { bridgeClient.close(); } catch {} }
  bridgeClient = null;
  bridgeAdapter = null;
}

function startBridge(reason) {
  stopBridge();
  if (!bridgeConfig || !bridgeConfig.enabled) return;
  bridgeBackoffMs = 1000;
  logMsg('info', 'bridge: starting', { reason, url: bridgeConfig.url, hostAlias: bridgeConfig.hostAlias });
  dialBridge(bridgeGeneration);
}

function scheduleBridgeRedial(gen) {
  if (gen !== bridgeGeneration || !bridgeConfig || !bridgeConfig.enabled) return;
  const jitter = 0.75 + Math.random() * 0.5;
  const delay = Math.round(Math.min(bridgeBackoffMs, BRIDGE_BACKOFF_MAX_MS) * jitter);
  bridgeBackoffMs = Math.min(bridgeBackoffMs * 2, BRIDGE_BACKOFF_MAX_MS);
  bridgeRedialTimer = setTimeout(function() {
    bridgeRedialTimer = null;
    dialBridge(gen);
  }, delay);
}

// Adapter: presents the outbound client socket with the server-side ws shape
// (send/readyState/close) so handleCommand + subscriber fan-out work as-is.
function makeBridgeAdapter(client) {
  return {
    // Marks this socket as the PUBLIC cloud relay so handleCommand restricts it
    // to BRIDGE_ALLOWED_COMMANDS (regular SSH clients have no origin property).
    origin: 'bridge',
    get readyState() { return client.readyState; },
    send(payload) { try { client.send(payload); } catch {} },
    close() { try { client.close(); } catch {} },
  };
}

function dialBridge(gen) {
  if (gen !== bridgeGeneration || !bridgeConfig || !bridgeConfig.enabled) return;
  const cfg = bridgeConfig;
  const WsCtor = getWsClientCtor();
  if (!WsCtor) {
    logMsg('error', 'bridge: no WebSocket client available on this runtime');
    return;
  }
  let dialUrl;
  try {
    // Token rides a query param — browser-style clients can't set headers,
    // and the cloud upgrade handler accepts ?token= already.
    const u = new URL(cfg.url);
    u.searchParams.set('token', cfg.token);
    dialUrl = u.toString();
  } catch {
    logMsg('error', 'bridge: invalid url — disabling until reconfigured', { url: cfg.url });
    return;
  }

  let client;
  try {
    client = new WsCtor(dialUrl);
  } catch (err) {
    logMsg('warn', 'bridge: dial failed', { err: err.message });
    scheduleBridgeRedial(gen);
    return;
  }
  bridgeClient = client;

  const onOpen = function() {
    if (gen !== bridgeGeneration) { try { client.close(); } catch {} return; }
    bridgeBackoffMs = 1000;
    bridgeLastInbound = Date.now();
    const adapter = makeBridgeAdapter(client);
    bridgeAdapter = adapter;
    wsClients.add(adapter);
    adapter.send(JSON.stringify({
      ev: 'hello',
      hostAlias: cfg.hostAlias,
      version: DAEMON_VERSION,
      instanceId: DAEMON_INSTANCE_ID,
      sids: [...sessions.keys()],
    }));
    logMsg('info', 'bridge: connected', { hostAlias: cfg.hostAlias });
    bridgePingTimer = setInterval(function() {
      if (gen !== bridgeGeneration) return;
      if (Date.now() - bridgeLastInbound > BRIDGE_SILENCE_MS) {
        logMsg('warn', 'bridge: inbound silence — tearing down', {
          silentMs: Date.now() - bridgeLastInbound,
        });
        try { client.close(); } catch {}
        return;
      }
      adapter.send(JSON.stringify({ ev: 'bridge-ping', ts: Date.now() }));
    }, BRIDGE_PING_INTERVAL_MS);
  };

  const onMessage = function(data) {
    if (gen !== bridgeGeneration || !bridgeAdapter) return;
    bridgeLastInbound = Date.now();
    handleCommand(bridgeAdapter, typeof data === 'string' ? data : data.toString());
  };

  const onClose = function() {
    if (gen !== bridgeGeneration) return;
    if (bridgePingTimer) { clearInterval(bridgePingTimer); bridgePingTimer = null; }
    if (bridgeAdapter) {
      wsClients.delete(bridgeAdapter);
      for (const [, session] of sessions) session.subscribers.delete(bridgeAdapter);
      bridgeAdapter = null;
    }
    bridgeClient = null;
    logMsg('info', 'bridge: disconnected — redialing', { nextBackoffMs: bridgeBackoffMs });
    scheduleBridgeRedial(gen);
  };

  // Support both the ws-package EventEmitter API and the browser-style
  // on* properties (Node 22 global WebSocket).
  if (typeof client.on === 'function') {
    client.on('open', onOpen);
    client.on('message', onMessage);
    client.on('close', onClose);
    client.on('error', function() { /* close always follows */ });
  } else {
    client.onopen = onOpen;
    client.onmessage = function(e) { onMessage(e.data); };
    client.onclose = onClose;
    client.onerror = function() { /* close always follows */ };
  }
}

// ── Session idle scanner ──
// 5min: long enough for model response delays (up to 120s) and MCP tool execution,
// short enough to detect stuck sessions promptly.
const SESSION_IDLE_WARNING_MS = 5 * 60 * 1000;     // 5 minutes
// 2hr: conservative — gives plenty of time for legitimate background work (builds,
// long MCP ops, await_human_action), but eventually reclaims resources.
const SESSION_IDLE_KILL_MS = 2 * 60 * 60 * 1000;   // 2 hours
const SESSION_SCAN_INTERVAL_MS = 60000;             // every 60s

function scanIdleSessions() {
  const now = Date.now();
  for (const [sid, session] of sessions) {
    const pid = session.pid;
    if (!pid) continue;

    // 1. Process already dead? Clean up process group
    if (session.exitCode !== null) {
      if (isProcessGroupAlive(pid)) {
        logMsg('info', 'idle scan: cleaning dead session process group', { sid, pid });
        killProcessGroup(pid, 'SIGKILL');
      }
      continue;
    }

    // Check if process is actually alive
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch {}
    if (!alive) {
      logMsg('info', 'idle scan: process dead (missed exit)', { sid, pid });
      reapSession(sid, -1, 'idle-scan-missed-exit');
      continue;
    }

    // 2. Has at least one subscribed ws? Skip idle check — someone cares.
    if (session.subscribers.size > 0) continue;

    // 3. Check JSONL file mtime
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(session.jsonlPath).mtimeMs; } catch { continue; }

    const idleMs = now - mtimeMs;
    if (idleMs < SESSION_IDLE_WARNING_MS) {
      continue;
    } else if (idleMs < SESSION_IDLE_KILL_MS) {
      const idleMinutes = Math.round(idleMs / 60000);
      logMsg('warn', 'idle scan: session idle with no subscribers', { sid, pid, idleMinutes, threshold: '2hr' });
    } else {
      const idleMinutes = Math.round(idleMs / 60000);
      logMsg('warn', 'idle scan: killing idle session (no subscribers, no output)', { sid, pid, idleMinutes });
      killSessionProcessGroup(pid, sid);
    }
  }
}

function cleanupOrphanedProcessGroups() {
  // Adopt live sessions from a previous daemon (graceful upgrade).
  // Only kill sessions whose process is dead (truly orphaned).
  let scanned = 0;
  let skippedAdopted = 0;
  let adoptedLegacy = 0;
  let removedStale = 0;
  try {
    const files = fs.readdirSync(STREAMS_DIR);
    for (const f of files) {
      if (!f.endsWith('.pgid')) continue;
      scanned++;
      const sid = f.replace('.pgid', '');
      // Re-entrant guard: reconcileRegistry may have already adopted with
      // authoritative state fields. Do not overwrite.
      if (sessions.has(sid)) { skippedAdopted++; continue; }
      try {
        const pid = parseInt(fs.readFileSync(path.join(STREAMS_DIR, f), 'utf-8').trim(), 10);
        if (isNaN(pid) || pid <= 0) continue;
        if (isProcessGroupAlive(pid)) {
          // Process still alive — adopt it into our sessions map (legacy path,
          // no sessions.json entry).
          logMsg('info', 'startup: adopting live session from previous daemon (legacy pgid-only)', { sid, pid });
          const jsonlPath = path.join(STREAMS_DIR, sid + '.jsonl');
          const pipePath = path.join(STREAMS_DIR, sid + '.pipe');
          const pgidPath = path.join(STREAMS_DIR, f);
          // Watcher starts at the CURRENT end of the jsonl — same rule as
          // registry adopt and attach-discover. 0 would live-fan the whole
          // history and poison the client cursor. Keep in sync with
          // daemon-standalone.ts.
          let adoptOffset = 0;
          try { adoptOffset = fs.statSync(jsonlPath).size; } catch {}
          sessions.set(sid, {
            proc: null,  // no handle — process was started by old daemon.
            pipePath,
            jsonlPath,
            pgidPath,
            pid,
            offset: adoptOffset,
            taskState: rebuildTaskStateFromJsonl(jsonlPath, Date.now()),
            watcher: null,
      subscribers: new Set(),
            exitCode: null,
            state: 'running',
            exitReason: null,
            exitedAt: null,
            parented: false,
            startTime: readStartTime(pid),
            cwd: '',
            args: [],
            orphanPollTimer: null,
            mode: 'default',
            pendingCtrl: null,
          });
          startOrphanPoll(sid);
          adoptedLegacy++;
        } else {
          // Process dead — clean up pgid file
          logMsg('info', 'startup cleanup: removing stale pgid for dead session', { sid, pid });
          try { fs.unlinkSync(path.join(STREAMS_DIR, f)); } catch {}
          removedStale++;
        }
      } catch (err) {
        logMsg('warn', 'startup cleanup: error processing pgid file', { sid, error: err && err.message });
      }
    }
  } catch (err) {
    logMsg('warn', 'startup cleanup: readdir failed', { streamsDir: STREAMS_DIR, error: err && err.message });
  }
  logMsg('info', 'startup cleanup: done', {
    scanned, skippedAdopted, adoptedLegacy, removedStale,
    sessionsAfter: sessions.size,
  });
}

// ── Cleanup ──
function cleanup() {
  // Close the cloud bridge first — a half-dead daemon must not keep looking
  // reachable from the phone. bridge.json survives for the successor.
  try { stopBridge(); } catch {}

  // Graceful shutdown: leave session processes running so the next daemon
  // can adopt them (via sessions.json + .pgid files). Only close watchers
  // and agent subs. Flush registry to disk so the successor daemon's
  // reconcileRegistry() sees the current state.
  logMsg('info', 'cleanup: daemon shutting down, leaving session processes alive for next daemon', {
    activeSessions: [...sessions.entries()].filter(([, s]) => (s.state || 'running') === 'running').length,
  });
  for (const [sid, session] of sessions) {
    // Stop orphan polls so we don't fire reapSession mid-shutdown
    if (session.orphanPollTimer) {
      clearInterval(session.orphanPollTimer);
      session.orphanPollTimer = null;
    }
    // Stop the session-bound watcher.
    stopSessionWatcher(sid);
  }
  try { persistRegistry(); } catch {}
  // Stop all agent subs
  for (const [, sub] of agentSubs) {
    clearInterval(sub.timer);
    clearInterval(sub.rediscoverTimer);
  }
  // Remove port/pid/instance files (so new daemon knows to start fresh).
  // IMPORTANT: Do NOT remove .pgid files here — cleanupOrphanedProcessGroups()
  // on the next daemon needs them to adopt running sessions. See that function above.
  // ONLY if we still own the dir — a zombie exiting via the heartbeat
  // self-check must not delete the successor daemon's live files.
  let ownsFiles = true;
  try {
    const ownerPid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
    if (ownerPid > 0 && ownerPid !== process.pid) ownsFiles = false;
  } catch {}
  if (ownsFiles) {
    try { fs.unlinkSync(PORT_FILE); } catch {}
    try { fs.unlinkSync(PID_FILE); } catch {}
    try { fs.unlinkSync(INSTANCE_ID_FILE); } catch {}
    try { fs.unlinkSync(VERSION_FILE); } catch {}
  }
  logMsg('info', 'daemon cleanup complete', { uptimeSec: Math.floor((Date.now() - DAEMON_START_TS) / 1000) });
}

// ── Main ──
const action = process.argv[2];

if (action === '--stop') {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
    process.kill(pid, 'SIGTERM');
    console.log('daemon stopped (pid=' + pid + ')');
  } catch {
    console.log('daemon not running');
  }
  process.exit(0);
}

if (action === '--status') {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
    process.kill(pid, 0);
    const port = fs.readFileSync(PORT_FILE, 'utf-8').trim();
    let instanceId;
    try { instanceId = fs.readFileSync(INSTANCE_ID_FILE, 'utf-8').trim(); } catch {}
    console.log(JSON.stringify({ running: true, pid, port: parseInt(port, 10), instanceId }));
  } catch {
    console.log(JSON.stringify({ running: false }));
  }
  process.exit(0);
}

if (action === '--start') {
  // Check if already running
  try {
    const existingPid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
    process.kill(existingPid, 0);
    const existingPort = fs.readFileSync(PORT_FILE, 'utf-8').trim();
    console.log(existingPort); // Already running — return port
    process.exit(0);
  } catch {
    // Not running, continue to start
  }

  fs.mkdirSync(DAEMON_DIR, { recursive: true });
  fs.mkdirSync(STREAMS_DIR, { recursive: true });

  // Write-ahead registry reconcile: load sessions.json, probe liveness,
  // adopt or reap. This is source-of-truth for cross-daemon handoff.
  logMsg('info', 'startup: reconcile begin', { registryFile: REGISTRY_FILE, streamsDir: STREAMS_DIR });
  reconcileRegistry();
  logMsg('info', 'startup: reconcile done', {
    adoptedFromRegistry: sessions.size,
    sids: [...sessions.keys()],
  });

  // Legacy fallback: pgid-file-based adoption for pre-registry sessions
  cleanupOrphanedProcessGroups();
  logMsg('info', 'startup: complete — sessions ready', {
    totalSessions: sessions.size,
    sids: [...sessions.keys()],
  });

  const httpServer = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('walnut-daemon ok');
  });

  const wss = createWsServer(httpServer);

  wss.on('connection', (ws) => {
    wsClients.add(ws);
    logMsg('info', 'client connected', { clients: wsClients.size });

    // Ping/pong keepalive
    const pingTimer = setInterval(() => {
      if (ws.readyState === 1) ws.ping();
    }, PING_INTERVAL_MS);

    ws.on('message', (msg) => {
      handleCommand(ws, typeof msg === 'string' ? msg : msg.toString());
    });

    ws.on('close', () => {
      wsClients.delete(ws);
      clearInterval(pingTimer);

      // Remove this ws from every session's subscribers. The watcher (file
      // tailer) stays alive — it's session-bound, not ws-bound. The next ws
      // that attaches for the same session picks up where the file offset is.
      for (const [, session] of sessions) {
        session.subscribers.delete(ws);
      }

      // Clean up agent subs for this client
      for (const [key, sub] of agentSubs) {
        if (sub.ws === ws) {
          clearInterval(sub.timer);
          clearInterval(sub.rediscoverTimer);
          agentSubs.delete(key);
        }
      }

      logMsg('info', 'client disconnected', { clients: wsClients.size });
    });

    ws.on('error', (err) => {
      logMsg('error', 'ws error', { error: err.message });
    });
  });

  // Listen on random port (localhost only)
  httpServer.listen(0, '127.0.0.1', () => {
    const port = httpServer.address().port;
    fs.writeFileSync(PORT_FILE, String(port));
    fs.writeFileSync(PID_FILE, String(process.pid));
    fs.writeFileSync(INSTANCE_ID_FILE, DAEMON_INSTANCE_ID);
    fs.writeFileSync(VERSION_FILE, DAEMON_VERSION);
    console.log(port); // Print port for parent to capture
    logMsg('info', 'daemon started', { port, pid: process.pid, startedAt: DAEMON_START_TS });

    // Start session idle scanner (every 60s)
    setInterval(scanIdleSessions, SESSION_SCAN_INTERVAL_MS);

    // Cloud bridge self-heal: a persisted bridge.json re-dials without the Mac.
    loadBridgeConfig();
    startBridge('startup');

    // Heartbeat: 30s vitals log. Absence = wedged daemon.
    setInterval(function() {
      const mem = process.memoryUsage();
      logMsg('info', 'heartbeat', {
        sessions: sessions.size,
        wsClients: wsClients.size,
        agentSubs: agentSubs.size,
        uptimeSec: Math.floor((Date.now() - DAEMON_START_TS) / 1000),
        rssMb: Math.round(mem.rss / 1024 / 1024),
        heapMb: Math.round(mem.heapUsed / 1024 / 1024),
      });
      // Single-instance self-check — if daemon.pid names a different live pid,
      // a newer daemon owns this dir and we are a zombie; exit gracefully.
      // Keep in sync with daemon-standalone.ts heartbeat (CLAUDE.md).
      try {
        const ownerPid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
        if (ownerPid > 0 && ownerPid !== process.pid) {
          logMsg('warn', 'self-check: daemon.pid taken over by another instance — exiting', {
            ourPid: process.pid, ownerPid,
          });
          cleanup();
          process.exit(0);
        }
      } catch {}
    }, HEARTBEAT_INTERVAL_MS);
  });

  // Handle signals
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
  process.on('SIGINT', () => { cleanup(); process.exit(0); });

  // Prevent daemon from exiting when SSH disconnects (stdin EOF would otherwise cause exit)
  if (process.stdin.isTTY === false) {
    process.stdin.resume();
    process.stdin.on('end', () => {}); // Don't exit on stdin close
  }
} else {
  console.error('Usage: node daemon.js --start | --stop | --status');
  process.exit(1);
}
`;
