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
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ADVERTISED_DAEMON_CAPABILITIES } from './daemon-capabilities.js'
import { computeExpectedDaemonVersion } from './daemon-version-check.js'
import { foldLine, initialFoldState, assembleSnapshot, snapshotDiffers } from './daemon-fold.js'

/**
 * Version stamped into a source-deployed daemon, resolved at string-build time
 * on the local machine.
 *
 * INVARIANT: the version must describe the TEMPLATE BYTES THIS MODULE CARRIES,
 * never the worktree. A long-running server whose bundle predates a source
 * edit still holds the OLD template; hashing the worktree would label those
 * stale bytes with the NEW version, and every later server then sees "version
 * match" and skips the upgrade forever (clouddev ran a mislabeled stale daemon
 * exactly this way, 2026-08-22). So:
 *   1. Bundled run (this module lives under dist/): the .version sidecar
 *      written by the SAME build as this bundle — build-daemon.sh and tsup run
 *      back-to-back, so sidecar and baked template share one tree.
 *   2. Source run (tsx/vitest — the template IS the worktree): sha256 of the
 *      daemon source tree, same algorithm the binaries bake in.
 *   3. DAEMON_VERSION env (compile-time define passthrough)
 *   4. `walnut-daemon-pkg-<version>` from the installed package.json — the
 *      published-npm-package case, where src/ doesn't ship so (2) is null.
 *      Package version identifies the shipped code exactly, so the local
 *      fallback daemon and its .version sidecar agree, and a package upgrade
 *      changes the version → daemon auto-restarts with the new code.
 *   5. 'dev-source' — nothing else resolvable (should not happen in practice).
 */
export function resolveDaemonSourceVersion(): string {
  const here = fileURLToPath(import.meta.url)
  const bundled = here.split(path.sep).includes('dist')
  if (bundled) {
    const sidecar = readSidecarDaemonVersion(here)
    if (sidecar) return sidecar
  }
  const computed = computeExpectedDaemonVersion()
  if (computed) return computed
  if (process.env.DAEMON_VERSION) return process.env.DAEMON_VERSION
  // Walk up from this bundle (dist/cli.js or dist/providers/...) to the
  // open-walnut package.json.
  let dir = path.dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 10; i++) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8')) as {
        name?: string
        version?: string
      }
      if (pkg.name === 'open-walnut' && pkg.version) return `walnut-daemon-pkg-${pkg.version}`
    } catch { /* keep walking */ }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return 'dev-source'
}

/**
 * Read the daemon .version sidecar that sits next to this bundle
 * (dist/daemon-binaries/*.version). Pure path-walk from the module location so
 * a unit test can pin it; returns null when no sidecar is readable (e.g. the
 * binaries were never built) — callers fall back to the worktree hash.
 */
export function readSidecarDaemonVersion(fromPath: string): string | null {
  let dir = path.dirname(fromPath)
  for (let i = 0; i < 5; i++) {
    // Any *.version sidecar works — build-daemon.sh writes the same version
    // string for every platform in one build, so no platform-specific name.
    const binDir = path.join(dir, 'daemon-binaries')
    try {
      for (const name of fs.readdirSync(binDir)) {
        if (!name.endsWith('.version')) continue
        const v = fs.readFileSync(path.join(binDir, name), 'utf-8').trim()
        if (v) return v
      }
    } catch { /* keep walking */ }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

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
  // Sidecar-gated capabilities are EXCLUDED from the static list: their host-
  // local pipelines can't be inlined into this string template, so deploySource
  // ships each as a separate CJS bundle (changes-core.cjs,
  // external-scan-core.cjs, path-resolve-core.cjs) and daemonCapabilities() in
  // the template adds the capability back at runtime only when that sidecar
  // actually loads.
  const SIDECAR_GATED_CAPABILITIES = new Set(['changes-v1', 'external-scan-v1', 'path-resolve-v1', 'vscode-v1', 'rewind-probe-v1'])
  const capsLiteral = JSON.stringify(
    [...ADVERTISED_DAEMON_CAPABILITIES].filter((c) => !SIDECAR_GATED_CAPABILITIES.has(c)),
  )
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
  // feeding the shouldUpgradeDaemon stop/redeploy loop. The version comes from
  // resolveDaemonSourceVersion(), which describes the template bytes this
  // bundle actually carries (see its doc comment) — a source deploy and a
  // binary from the same build report the SAME version.
  const versionPlaceholder = '__DAEMON_VERSION__'
  const versionMatches = DAEMON_SOURCE.split(versionPlaceholder).length - 1
  if (versionMatches !== 1) {
    throw new Error(
      `daemon-source: expected exactly 1 '${versionPlaceholder}' placeholder in DAEMON_SOURCE, found ${versionMatches}`,
    )
  }
  const version = resolveDaemonSourceVersion()

  // ── C1: fold-function injection (contract §3) ──
  // The pure fold functions from daemon-fold.ts are inlined TEXTUALLY
  // (fn.toString(), same mechanism as __DAEMON_VERSION__) because the template
  // runs on a plain remote Node with no imports. Each placeholder must appear
  // exactly once. snapshotDiffers joined the set 2026-08-06 (it was
  // hand-duplicated in both twins, where a one-sided edit — dropping a field
  // from the compare, i.e. a silently suppressed push — had no byte guard).
  const foldInjections: Array<[string, string]> = [
    ['__FOLD_LINE__', foldLine.toString()],
    ['__INITIAL_FOLD_STATE__', initialFoldState.toString()],
    ['__ASSEMBLE_SNAPSHOT__', assembleSnapshot.toString()],
    ['__SNAPSHOT_DIFFERS__', snapshotDiffers.toString()],
  ]
  for (const [ph] of foldInjections) {
    const n = DAEMON_SOURCE.split(ph).length - 1
    if (n !== 1) {
      throw new Error(
        `daemon-source: expected exactly 1 '${ph}' placeholder in DAEMON_SOURCE, found ${n}`,
      )
    }
  }

  // Deploy-time validation: reconstruct each injected function under strict
  // mode and run a smoke fold (user line → result → idle ⇒ assembled cliState
  // 'idle'). A bundler-mangled toString (captured import, __name helper) would
  // otherwise only ReferenceError at runtime on the REMOTE host. On ANY
  // failure, THROW — never deploy a corrupt daemon.
  validateFoldInjection(foldInjections)

  let out = DAEMON_SOURCE
    .replaceAll(placeholder, capsLiteral)
    .replaceAll(versionPlaceholder, version)
  for (const [ph, body] of foldInjections) {
    // Function replacer: a literal replacement string would reinterpret any
    // `$&`/`$'` sequences inside the function source.
    out = out.replace(ph, () => body)
  }
  return out
}

/**
 * Throws unless every injected fold function survives a strict-mode
 * `new Function` round-trip AND the trio agrees on a smoke fold. Exported for
 * the corrupt-injection test (which feeds it a broken toString on purpose).
 */
export function validateFoldInjection(injections: Array<[string, string]>): void {
  const reconstructed: Record<string, unknown> = {}
  for (const [ph, body] of injections) {
    let fn: unknown
    try {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      fn = new Function('"use strict"; return ' + body)()
    } catch (err) {
      throw new Error(
        `daemon-source: injected function for ${ph} failed strict-mode reconstruction `
        + `(bundler helper capture? module-scope reference?): ${(err as Error).message}`,
      )
    }
    if (typeof fn !== 'function') {
      throw new Error(`daemon-source: injected ${ph} did not evaluate to a function`)
    }
    reconstructed[ph] = fn
  }
  type FoldStateT = ReturnType<typeof initialFoldState>
  const init = reconstructed['__INITIAL_FOLD_STATE__'] as (v?: number) => FoldStateT
  const fold = reconstructed['__FOLD_LINE__'] as (s: FoldStateT, l: string, v: number) => FoldStateT
  const assemble = reconstructed['__ASSEMBLE_SNAPSHOT__'] as typeof assembleSnapshot
  const differs = reconstructed['__SNAPSHOT_DIFFERS__'] as typeof snapshotDiffers | undefined
  try {
    const lines = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'smoke turn' } }),
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1 }),
      JSON.stringify({ type: 'system', subtype: 'session_state_changed', state: 'idle' }),
    ]
    let state = init(0)
    let v = 0
    const perLine: FoldStateT[] = []
    for (const l of lines) {
      v += Buffer.byteLength(l, 'utf8') + 1
      state = fold(state, l, v)
      perLine.push(state)
    }
    const snap = assemble({ foldState: state, pendingCtrl: null, dead: false, pid: 1, exitCode: null })
    if (snap.cliState !== 'idle' || snap.turnActive !== false || snap.v !== v) {
      throw new Error(
        `smoke fold produced wrong snapshot: cliState=${snap.cliState} turnActive=${snap.turnActive} v=${snap.v} (expected idle/false/${v})`,
      )
    }
    // snapshotDiffers smoke: must ignore a bare v advance (else every streamed
    // line pushes = event storm) but SEE the running → idle flip (else a real
    // state change is silently suppressed). Both directions matter.
    if (differs) {
      const running = assemble({ foldState: perLine[0], pendingCtrl: null, dead: false, pid: 1, exitCode: null })
      if (differs(snap, { ...snap, v: snap.v + 4096 })) {
        throw new Error('snapshotDiffers reported a bare v advance as a change (push storm)')
      }
      if (!differs(running, snap)) {
        throw new Error('snapshotDiffers missed the running → idle flip (suppressed push)')
      }
    }
  } catch (err) {
    throw new Error(
      'daemon-source: fold-injection smoke test FAILED — refusing to deploy a corrupt daemon: '
      + (err as Error).message,
    )
  }
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
const os = require('os');
const http = require('http');
const net = require('net');
const { spawn, execSync } = require('child_process');
const crypto = require('crypto');

process.umask(0o077);

// ── walnut: the minimal on-host walnut CLI (agent gateway) ──
// Source-deploy twin of src/providers/wn-cli.ts — hand-inlined MINIMAL subset
// (this template cannot import). Invoked from the argv dispatch in Main below
// (async: the socket handlers call process.exit). Keep exit codes + command
// surface in sync with wn-cli.ts and daemon-standalone.ts.
function runWnMinimal(argv, stdinText) {
  // 'walnut guide | head' closes the pipe early: EPIPE on stdout is the reader
  // saying "enough", not an error — exit clean instead of an uncaught stack.
  process.stdout.on('error', function (e) { if (e && e.code === 'EPIPE') process.exit(0); });
  // Buffer stdout and FLUSH BEFORE EXITING. process.exit() discards whatever is
  // still queued for a pipe (pipes are async on macOS), so the old
  // out(...) then process.exit(0) shape cut "walnut ... --json | jq" at exactly the
  // 64KB pipe buffer — invalid JSON for the agent that piped it. Mirror of
  // wn-cli.ts writeStdout(); exitWn is ASYNC, so every call site returns.
  var outBuf = '';
  var out = function (s) { outBuf += s + '\\n'; };
  var errOut = function (s) { process.stderr.write(s + '\\n'); };
  var exitWn = function (code) {
    // Only OUR stdin spill is removed; a path the user passed with @ is theirs.
    if (wnSpilledArgsFile) { try { fs.unlinkSync(wnSpilledArgsFile); } catch (e) { /* already gone */ } }
    if (!outBuf) return process.exit(code);
    var text = outBuf;
    outBuf = '';
    var done = false;
    var finishExit = function () { if (done) return; done = true; process.exit(code); };
    // 5s cap so a runtime that never calls back cannot hang walnut.
    var flushTimer = setTimeout(finishExit, 5000);
    if (flushTimer.unref) flushTimer.unref();
    try { process.stdout.write(text, finishExit); } catch (e) { finishExit(); }
  };
  // ── where tools.call reads its JSON arguments from ──
  // Twin of src/providers/tool-args-source.ts (this template cannot import).
  // Not a convenience: Linux caps ONE argv entry at MAX_ARG_STRLEN (128KB) no
  // matter how much room ARG_MAX leaves, and that failure happens inside execve
  // before this process exists ("Argument list too long", which looks nothing
  // like a size limit). A letter carrying an inline base64 audio digest is
  // megabytes, so @file and stdin are the ONLY ways it can reach the gateway.
  // Keep the four spellings identical across all three CLI faces.
  var wnArgsSource = function (raw) {
    if (raw === undefined) return process.stdin.isTTY === true ? { kind: 'none' } : { kind: 'stdin' };
    var value = String(raw).trim();
    if (value === '-') return { kind: 'stdin' };
    if (value.charAt(0) === '@') {
      var p = value.slice(1);
      if (!p) return { kind: 'usage-error', message: '@ needs a file path, e.g. @/tmp/letter.json' };
      return { kind: 'file', path: p };
    }
    if (!value) return { kind: 'none' };
    return { kind: 'inline', json: raw };
  };
  var wnParseToolArgs = function (text) {
    if (!String(text).trim()) return { ok: true, args: {} };
    var parsedValue;
    try { parsedValue = JSON.parse(text); } catch (e) { return { ok: false, message: 'invalid JSON arguments: ' + e.message }; }
    if (parsedValue === null || typeof parsedValue !== 'object' || Array.isArray(parsedValue)) {
      return { ok: false, message: 'arguments must be a JSON object' };
    }
    return { ok: true, args: parsedValue };
  };
  // Locate the tools.call payload slot the same way the parse below does (flags
  // count only before positionals) so a piped payload can be drained BEFORE the
  // parse: the tail of this function is callback-based and cannot await. On the
  // re-entry the text rides an in-memory array, so no execve limit applies.
  var wnCallSlot = function (a) {
    if (a[0] !== 'tools') return null;
    var r = a.slice(1);
    while (r.length && r[0] === '--json') r.shift();
    var s = r.shift();
    while (r.length && r[0] === '--json') r.shift();
    if (s !== 'call' || r.length < 1) return null;
    return { name: r[0], raw: r[1] };
  };
  // Payloads over this do not travel INSIDE the request — the hub range-reads
  // the file instead. Twin of GATEWAY_INLINE_ARGS_MAX_BYTES in tool-args-source.ts.
  var GATEWAY_INLINE_ARGS_MAX_BYTES = 1024 * 1024;
  var wnSpilledArgsFile;
  var wnSlot = wnCallSlot(argv);
  var wnSrc = wnSlot ? wnArgsSource(wnSlot.raw) : null;
  if (stdinText === undefined && wnSrc && wnSrc.kind === 'stdin') {
    var stdinBuf = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', function (c) { stdinBuf += c; });
    process.stdin.on('end', function () { runWnMinimal(argv, stdinBuf); });
    return;
  }
  var usage = 'usage: walnut guide | walnut wait <id> [--timeout secs] | walnut tools list | walnut tools help <op> | walnut tools call <op> [json|@file|-|--help]';
  // Twin of SKILL_POINTER in src/ops/op-help.ts.
  var wnSkillPointer = 'Model (task vs session) + recipes: walnut tools call skill_read \\'{"dirName":"walnut"}\\'';
  if (argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') { out(usage); out(wnSkillPointer); return exitWn(0); }
  if (argv[0] === 'peers') {
    errOut('walnut: peers was replaced — list sessions with: walnut tools call session_list, message one with: walnut tools call session_send (args: to, text)');
    return exitWn(2);
  }
  if (argv[0] !== 'wait' && argv[0] !== 'tools' && argv[0] !== 'guide') { errOut('walnut: unknown command; ' + usage); return exitWn(2); }
  // Mirror wn-cli.ts: --json is recognized only BEFORE positional args, so
  // message text can legitimately contain the token '--json'.
  var json = false;
  var wnWait = null;
  var head = argv[0];
  var rest = argv.slice(1);
  while (rest.length && rest[0] === '--json') { json = true; rest.shift(); }
  var sub = rest.shift();
  while (rest.length && rest[0] === '--json') { json = true; rest.shift(); }
  var op, args;
  var guide = false;
  // Set when this tools.list request is really "show me ONE op's schema".
  var wnHelpOp = null;
  if (head === 'guide') {
    // Sugar over tools.call skill_read {dirName:'walnut'} — mirrors wn-cli.ts.
    if (sub !== undefined) { errOut('walnut: guide takes no arguments'); return exitWn(2); }
    guide = true;
    op = 'tools.call';
    args = { name: 'skill_read', args: { dirName: 'walnut' } };
  }
  else if (head === 'tools') {
    // Minimal tools twin: list + call (+ help via a one-op list). Same hub
    // capabilities as the full wn-cli.ts; keep in sync.
    if (sub === 'list' && rest.length === 0) { op = 'tools.list'; args = {}; }
    else if ((sub === 'call' || sub === 'help') && rest.length >= 1) {
      // 'tools help <op>' and 'tools call <op> --help' both ask for ONE op's
      // schema. Asking the hub for the whole catalog and printing it (what this
      // twin used to do for help) answered "what are this op's parameters?"
      // with the op LIST, and --help reached the JSON parser as arguments.
      var wantsHelp = sub === 'help';
      var helpName = rest[0];
      if (sub === 'help') {
        for (var hj = 0; hj < rest.length; hj++) {
          if (rest[hj].charAt(0) !== '-') { helpName = rest[hj]; break; }
        }
      } else {
        for (var hi = 1; hi < rest.length; hi++) {
          if (rest[hi] === '--help' || rest[hi] === '-h') wantsHelp = true;
        }
      }
      if (wantsHelp) {
        if (!helpName || helpName.charAt(0) === '-') { errOut('walnut: tools help requires <op>'); return exitWn(2); }
        op = 'tools.list';
        wnHelpOp = helpName;
        args = { name: helpName };
      }
      else {
        var src = wnSrc || wnArgsSource(rest[1]);
        if (src.kind === 'usage-error') { errOut('walnut: ' + src.message); return exitWn(2); }
        var rawText = '';
        var wnArgsFile;
        if (src.kind === 'inline') rawText = src.json;
        else if (src.kind === 'stdin') {
          rawText = stdinText || '';
          if (Buffer.byteLength(rawText, 'utf-8') > GATEWAY_INLINE_ARGS_MAX_BYTES) {
            // stdin is not a file the hub can range-read, so give it one.
            wnArgsFile = require('path').join(
              require('os').tmpdir(), 'walnut-args-' + process.pid + '-' + Date.now().toString(36) + '.json');
            try { fs.writeFileSync(wnArgsFile, rawText, { encoding: 'utf-8', mode: 0o600 }); }
            catch (e) { errOut('walnut: cannot stage a large payload at ' + wnArgsFile + ': ' + e.message); return exitWn(2); }
            wnSpilledArgsFile = wnArgsFile;
          }
        }
        else if (src.kind === 'file') {
          var wnAbs = require('path').resolve(src.path);
          var wnSize = -1;
          try { wnSize = fs.statSync(wnAbs).size; }
          catch (e) { errOut('walnut: cannot read arguments from ' + src.path + ': ' + e.message); return exitWn(2); }
          if (wnSize > GATEWAY_INLINE_ARGS_MAX_BYTES) wnArgsFile = wnAbs;
          else {
            try { rawText = fs.readFileSync(wnAbs, 'utf-8'); }
            catch (e) { errOut('walnut: cannot read arguments from ' + src.path + ': ' + e.message); return exitWn(2); }
          }
        }
        op = 'tools.call';
        if (wnArgsFile !== undefined) {
          // Over the inline threshold the request carries only the PATH; the hub
          // pulls the file back from this host's daemon in bounded byte ranges
          // (core/peers/gateway-args-file.ts). Keeps a 100MB letter body off the
          // one NDJSON line + one WS frame this request would otherwise be.
          args = { name: rest[0], argsFile: wnArgsFile };
        } else {
          var parsedCall = wnParseToolArgs(rawText);
          if (!parsedCall.ok) { errOut('walnut: ' + parsedCall.message); return exitWn(2); }
          args = { name: rest[0], args: parsedCall.args };
        }
      }
    } else { errOut('walnut: ' + usage); return exitWn(2); }
  }
  else if (head === 'wait') {
    // Mirror of wn-cli.ts runWait: client-side poll (the hub never holds a
    // request open), one readonly tools.call per 5s tick, exit 7 on timeout.
    var waitId = sub;
    var waitTimeoutSecs = 1800;
    while (rest.length) {
      var wa = rest.shift();
      if (wa === '--timeout') { waitTimeoutSecs = Number(rest.shift()); }
      else if (wa === '--json') { json = true; }
      else { errOut('walnut: unexpected argument: ' + wa); return exitWn(2); }
    }
    if (!waitId) { errOut('walnut: wait requires <task-id | rq-id>'); return exitWn(2); }
    if (!(waitTimeoutSecs > 0)) { errOut('walnut: --timeout needs seconds > 0'); return exitWn(2); }
    op = 'tools.call';
    args = {
      name: waitId.indexOf('rq-') === 0 ? 'request_get' : 'task_get',
      args: { id: waitId },
    };
    wnWait = { id: waitId, deadline: Date.now() + waitTimeoutSecs * 1000 };
  } else { errOut('walnut: ' + usage); return exitWn(2); }
  // Env-less fallback — mirror of wn-cli.ts resolveWalnutCliEndpoint. Inside a session
  // Walnut launched, both vars are injected. Started by hand (plain terminal,
  // self-launched agent), fall back to this host's well-known daemon socket and
  // identify as 'external'. Trusted ONLY when it is a socket owned by this user
  // with no group/other bits: the 0600 mode IS the gateway credential and the
  // daemon dir sits under a world-writable /tmp.
  var sockPath = (process.env.WALNUT_AGENT_SOCKET || '').trim();
  var sid = (process.env.WALNUT_SESSION_ID || '').trim() || 'external';
  if (!sockPath) {
    var wellKnown = path.join(DAEMON_DIR, 'agent-gateway.sock');
    var sockStat = null;
    try { sockStat = fs.statSync(wellKnown); } catch (e) { sockStat = null; }
    if (!sockStat) {
      errOut('walnut: no Walnut daemon on this host (WALNUT_AGENT_SOCKET is unset and ' + wellKnown + ' does not exist)');
      return exitWn(6);
    }
    var myUid = typeof process.getuid === 'function' ? process.getuid() : -1;
    if (!sockStat.isSocket() || (myUid >= 0 && sockStat.uid !== myUid) || (sockStat.mode & 0o077) !== 0) {
      errOut('walnut: refusing ' + wellKnown + ': not an owner-only socket belonging to this user');
      return exitWn(6);
    }
    sockPath = wellKnown;
  }
  // Exit-code table mirrors wn-cli.ts errorToExitCode (plan §4).
  var exitFor = function (code) {
    if (code === 'unknown_peer' || code === 'ambiguous_peer' || code === 'self_send') return 3;
    if (code === 'throttled' || code === 'queue_full') return 4;
    if (code === 'hub_unreachable' || code === 'hub_timeout') return 5;
    if (code === 'unknown_caller') return 6;
    return 1;
  };
  // walnut wait: poll loop twin of wn-cli.ts runWait — one request per 5s tick,
  // re-dialing the socket each time; exit 0 when settled, 7 on timeout.
  if (wnWait) {
    var waitTick = function () {
      var wsock = net.connect(sockPath);
      var wbuf = '';
      var wdone = false;
      var wfinish = function (fn) { if (wdone) return; wdone = true; clearTimeout(wtimer); wsock.destroy(); fn(); };
      var wtimer = setTimeout(function () { wfinish(retryOrTimeout); }, 30000);
      var retryOrTimeout = function () {
        if (Date.now() >= wnWait.deadline) {
          out(JSON.stringify({ done: false, timeout: true, id: wnWait.id }));
          return exitWn(7);
        }
        setTimeout(waitTick, 5000);
      };
      wsock.on('connect', function () { wsock.write(JSON.stringify({ v: 1, op: op, sid: sid, args: args }) + '\\n'); });
      wsock.on('error', function () { wfinish(retryOrTimeout); });
      wsock.on('close', function () { wfinish(retryOrTimeout); });
      wsock.on('data', function (chunk) {
        wbuf += chunk.toString('utf-8');
        var wnl = wbuf.indexOf('\\n');
        if (wnl === -1) return;
        var wline = wbuf.slice(0, wnl);
        wfinish(function () {
          var wresp;
          try { wresp = JSON.parse(wline); } catch (e) { return retryOrTimeout(); }
          if (!wresp.ok) {
            var werr = wresp.error || {};
            errOut('walnut: ' + (werr.code || 'internal') + ': ' + (werr.message || 'gateway request failed'));
            return exitWn(exitFor(werr.code));
          }
          var wres = wresp.result || {};
          var settled, wsummary;
          if (wnWait.id.indexOf('rq-') === 0) {
            var wreq = wres.request || wres;
            settled = wreq.status && wreq.status !== 'pending';
            wsummary = { request: wnWait.id, status: wreq.status, outcome: wreq.outcome };
          } else {
            var wtask = wres.task || wres;
            settled = wtask.phase === 'AGENT_COMPLETE' || wtask.phase === 'COMPLETE';
            wsummary = { task: wtask.id || wnWait.id, title: wtask.title, phase: wtask.phase };
          }
          if (settled) { out(JSON.stringify(Object.assign({ done: true }, wsummary))); return exitWn(0); }
          retryOrTimeout();
        });
      });
    };
    waitTick();
    return;
  }
  var sock = net.connect(sockPath);
  var buf = '';
  var finished = false;
  var finish = function (fn) { if (finished) return; finished = true; clearTimeout(timer); sock.destroy(); fn(); };
  var timer = setTimeout(function () {
    finish(function () { errOut('walnut: hub_timeout: no reply from the Walnut daemon within 30s'); exitWn(5); });
  }, 30000);
  sock.on('connect', function () { sock.write(JSON.stringify({ v: 1, op: op, sid: sid, args: args }) + '\\n'); });
  sock.on('error', function (e) {
    finish(function () { errOut('walnut: Walnut daemon socket unreachable at ' + sockPath + ': ' + e.message); exitWn(6); });
  });
  sock.on('close', function () {
    finish(function () { errOut('walnut: agent socket closed without a response'); exitWn(6); });
  });
  sock.on('data', function (chunk) {
    buf += chunk.toString('utf-8');
    var nl = buf.indexOf('\\n');
    if (nl === -1) return;
    var line = buf.slice(0, nl);
    finish(function () {
      var resp;
      try { resp = JSON.parse(line); } catch (e) { errOut('walnut: malformed response from agent socket'); return exitWn(1); }
      if (json) { out(JSON.stringify(resp)); return exitWn(resp.ok ? 0 : exitFor(resp.error && resp.error.code)); }
      if (!resp.ok) {
        var err = resp.error || {};
        errOut('walnut: ' + (err.code || 'internal') + ': ' + (err.message || 'gateway request failed'));
        return exitWn(exitFor(err.code));
      }
      if (op === 'tools.list') {
        var ops = (resp.result && resp.result.ops) || [];
        if (wnHelpOp) {
          var helpRow = null;
          for (var k = 0; k < ops.length; k++) { if (ops[k].name === wnHelpOp) helpRow = ops[k]; }
          if (!helpRow) { errOut('walnut: unknown op: ' + wnHelpOp + ' (run: walnut tools list)'); return exitWn(1); }
          out(helpRow.name);
          out('');
          if (helpRow.description) { out('  ' + helpRow.description); out(''); }
          var ps = helpRow.params;
          if (!ps) out('Parameters: not reported by this Walnut server (upgrade it to see them)');
          else if (ps.length === 0) out('Parameters: none');
          else {
            out('Parameters:');
            for (var pi = 0; pi < ps.length; pi++) {
              out('  ' + ps[pi].name + ' (' + ps[pi].type + ', ' + (ps[pi].required ? 'required' : 'optional') + ')');
              if (ps[pi].description) out('    ' + ps[pi].description);
            }
          }
          out('');
          out('Usage:');
          out("  walnut tools call " + helpRow.name + " '{...}'");
          out("  walnut tools call " + helpRow.name + " @/tmp/args.json   # payloads over ~128KB must not go in argv");
          out('');
          out(wnSkillPointer);
        } else {
          for (var j = 0; j < ops.length; j++) {
            out('  ' + ops[j].name + '  ' + (ops[j].title || '') + (ops[j].readonly ? ' (read)' : ' (write)'));
            // The signature is what stops an agent guessing argument names.
            if (ops[j].signature) out('      args: ' + ops[j].signature);
          }
          out('');
          // A half-answer is exactly when the skill stops being read: name it here.
          out(wnSkillPointer);
        }
      } else {
        // tools.call — guide prints the manual as markdown, else pretty JSON.
        if (guide) {
          var sk = resp.result && resp.result.skill;
          if (!sk || !sk.content) { errOut('walnut: internal: the hub returned no manual content'); return exitWn(1); }
          out(String(sk.content).replace(/\\n$/, ''));
        } else out(JSON.stringify(resp.result, null, 2));
      }
      return exitWn(0);
    });
  });
}

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
// PROD_DAEMON_DIR is duplicated from local-daemon.ts (this template is deployed
// standalone and cannot import it); any OTHER dir is "isolated" — sandbox, test,
// ephemeral demo — which decides CLI-reap-on-exit. Mirror daemon-standalone.ts.
const PROD_DAEMON_DIR = '/tmp/open-walnut';
const DAEMON_DIR = process.env.WALNUT_DAEMON_DIR || PROD_DAEMON_DIR;
// Home for ~/... expansion. WALNUT_HOME_OVERRIDE lets tests align the daemon's ~/.claude
// with their mocked CLAUDE_HOME. Mirrors daemon-standalone.ts.
const HOME_DIR = process.env.WALNUT_HOME_OVERRIDE || process.env.HOME || '/root';
// Streams live under HOME so they survive reboots (/tmp is wiped — incident
// 019a7fe5: stale watermark vetoed every snapshot of the recreated file).
// Isolated daemons keep the sibling-dir derivation. Mirror daemon-standalone.ts.
// NOTE: string concat (not template literal) because this code lives inside a
// template literal string in the outer TypeScript file.
const PROD_STREAMS_DIR = path.join(HOME_DIR, '.open-walnut', 'tmp', 'streams');
// Env override is for TESTS ONLY (never set in prod) — without it a spawned
// test daemon would migrate the REAL production /tmp/open-walnut-streams.
const LEGACY_STREAMS_DIR = process.env.WALNUT_LEGACY_STREAMS_DIR || '/tmp/open-walnut-streams';
const STREAMS_DIR = process.env.WALNUT_STREAMS_DIR
  || (DAEMON_DIR === PROD_DAEMON_DIR ? PROD_STREAMS_DIR : (DAEMON_DIR + '-streams'));
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
// Env override exists so tests can exercise heartbeat-driven behavior (the
// parent-liveness watchdog) without waiting 30s. Production leaves it unset.
const HEARTBEAT_INTERVAL_MS = (function() {
  const ms = parseInt(process.env.WALNUT_DAEMON_HEARTBEAT_MS || '', 10);
  return Number.isFinite(ms) && ms > 0 ? ms : 30000;
})();
// Parent-liveness watchdog (isolated-dir daemons only — see the heartbeat).
// 0 / unset / garbage → disabled, which is always the case for production.
const WATCHDOG_PARENT_PID = (function() {
  const pid = parseInt(process.env.WALNUT_DAEMON_PARENT_PID || '', 10);
  return Number.isFinite(pid) && pid > 0 ? pid : 0;
})();

function ensureOwnerOnlyStorage() {
  function repair(entryPath) {
    let stat;
    try { stat = fs.lstatSync(entryPath); } catch { return; }
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      fs.chmodSync(entryPath, 0o700);
      let names = [];
      try { names = fs.readdirSync(entryPath); } catch { return; }
      for (const name of names) repair(path.join(entryPath, name));
      return;
    }
    fs.chmodSync(entryPath, stat.mode & 0o111 ? 0o700 : 0o600);
  }

  fs.mkdirSync(DAEMON_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(STREAMS_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(DAEMON_DIR, 0o700);
  fs.chmodSync(STREAMS_DIR, 0o700);
  for (const root of [DAEMON_DIR, STREAMS_DIR]) {
    for (const name of fs.readdirSync(root)) repair(path.join(root, name));
  }
}

// ── Legacy streams migration (/tmp → HOME) ──
// One-way, loss-averse, idempotent. Live-pgid sids are skipped whole (the CLI
// holds an O_APPEND fd on the old inode; registry absolute paths keep them
// working). Never overwrites; rename → copy+verify+unlink fallback; dead FIFOs
// dropped. Mirror daemon-standalone.ts.
function migrateLegacyStreams() {
  // Force flag is TEST-ONLY: prod triggers via the dir identity; isolated test
  // daemons opt in explicitly with their own temp legacy/streams dirs.
  if (STREAMS_DIR !== PROD_STREAMS_DIR && !process.env.WALNUT_FORCE_STREAMS_MIGRATION) return;
  let names = [];
  try { names = fs.readdirSync(LEGACY_STREAMS_DIR); } catch { return; }
  if (names.length === 0) return;
  const liveSids = new Set();
  for (const f of names) {
    if (!f.endsWith('.pgid')) continue;
    try {
      const pid = parseInt(fs.readFileSync(path.join(LEGACY_STREAMS_DIR, f), 'utf-8').trim(), 10);
      if (Number.isInteger(pid) && pid > 1 && isProcessGroupAlive(pid)) liveSids.add(f.slice(0, -5));
    } catch {}
  }
  let migrated = 0, skippedLive = 0, skippedExists = 0, dropped = 0, failed = 0;
  for (const f of names) {
    const src = path.join(LEGACY_STREAMS_DIR, f);
    const sid = f.replace(/\.(jsonl\.err|jsonl|pgid|pipe|log)$/, '');
    if (liveSids.has(sid)) { skippedLive++; continue; }
    let st;
    try { st = fs.lstatSync(src); } catch { continue; }
    if (st.isFIFO()) { try { fs.unlinkSync(src); } catch {}; dropped++; continue; }
    if (!st.isFile()) continue;
    const dst = path.join(STREAMS_DIR, f);
    if (fs.existsSync(dst)) { skippedExists++; continue; }
    try {
      fs.renameSync(src, dst);
      migrated++;
    } catch {
      try {
        fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL);
        if (fs.statSync(dst).size !== st.size) throw new Error('size mismatch after copy');
        fs.unlinkSync(src);
        migrated++;
      } catch (err) {
        failed++;
        try { fs.unlinkSync(dst); } catch {}
        logMsg('warn', 'legacy streams migration: file failed (kept in place)', { file: f, error: err.message });
      }
    }
  }
  logMsg('info', 'legacy streams migration: done', {
    from: LEGACY_STREAMS_DIR, to: STREAMS_DIR,
    migrated, skippedLive, skippedExists, droppedPipes: dropped, failed,
    liveSids: [...liveSids],
  });
}

// ── Dead-stream retention (3 months) ──
// Hourly: reap the file family of sids with no live session/process whose
// jsonl is idle past the window. Conversation truth lives in ~/.claude —
// stream files are status/replay plumbing. Mirror daemon-standalone.ts.
// Env overrides are TEST-ONLY (drive the sweep inside a test's timeframe).
const STREAM_RETENTION_MS = parseInt(process.env.WALNUT_STREAM_RETENTION_MS || '', 10)
  || 90 * 24 * 60 * 60 * 1000;
const STREAM_RETENTION_SWEEP_MS = parseInt(process.env.WALNUT_STREAM_SWEEP_MS || '', 10)
  || 60 * 60 * 1000;
function sweepDeadStreams() {
  let names = [];
  try { names = fs.readdirSync(STREAMS_DIR); } catch { return; }
  const now = Date.now();
  const reaped = new Set();
  for (const f of names) {
    if (!f.endsWith('.jsonl')) continue;
    const sid = f.slice(0, -6);
    if (sessions.has(sid)) continue;
    let st;
    try { st = fs.statSync(path.join(STREAMS_DIR, f)); } catch { continue; }
    if (now - st.mtimeMs < STREAM_RETENTION_MS) continue;
    try {
      const pid = parseInt(fs.readFileSync(path.join(STREAMS_DIR, sid + '.pgid'), 'utf-8').trim(), 10);
      if (Number.isInteger(pid) && pid > 1 && isProcessGroupAlive(pid)) continue;
    } catch {}
    for (const ext of ['.jsonl', '.jsonl.err', '.pgid', '.pipe', '.log']) {
      try { fs.unlinkSync(path.join(STREAMS_DIR, sid + ext)); } catch {}
    }
    reaped.add(sid);
  }
  if (reaped.size > 0) {
    logMsg('info', 'dead-stream retention sweep: reaped', { count: reaped.size, sids: [...reaped] });
  }
}

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
  // debug lines (cmd_recv per status poll) are each a SYNCHRONOUS append —
  // 60k+ writes/day of polling noise. Env opt-in only; info/warn/error always
  // land. Keep in sync with daemon-standalone.ts.
  if (level === 'debug' && process.env.WALNUT_DAEMON_DEBUG !== '1') return;
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

// ── Exit breadcrumb + last-resort crash guards ──
// The daemon died SILENTLY ≥7 times over 2026-08-11..13 (mid phone-bridge
// sends): no log line, no exit trace, stderr discarded by the spawner. This
// mirrors the server's exit-log pattern: every JS-visible death appends one
// line to daemon-exit-<instanceId>.log in the daemon dir. A crash with NO
// breadcrumb but a stderr tail = a runtime-level death (OOM / native abort)
// that JS can never see. Keep in sync with daemon-standalone.ts.
const EXIT_BREADCRUMB_FILE = path.join(DAEMON_DIR, 'daemon-exit-' + DAEMON_INSTANCE_ID + '.log');
function writeExitBreadcrumb(kind, err) {
  try {
    const mem = process.memoryUsage();
    let sessionCount = -1;
    try { sessionCount = sessions.size; } catch { /* module-init crash: map not born yet */ }
    fs.appendFileSync(EXIT_BREADCRUMB_FILE, JSON.stringify({
      ts: new Date().toISOString(),
      kind,
      pid: process.pid,
      instanceId: DAEMON_INSTANCE_ID,
      uptimeSec: Math.floor((Date.now() - DAEMON_START_TS) / 1000),
      rssMb: Math.round(mem.rss / 1024 / 1024),
      heapMb: Math.round(mem.heapUsed / 1024 / 1024),
      sessions: sessionCount,
      error: err instanceof Error ? err.message : (err === undefined ? undefined : String(err)),
      stack: err instanceof Error ? err.stack : undefined,
    }) + '\\n');
  } catch { /* the breadcrumb must never be the thing that crashes */ }
}

/** Fatal-path funnel: structured log + breadcrumb, then exit(1) so the
 *  supervisor (next Mac reconnect / LocalDaemon.ensureRunning) respawns a
 *  clean process instead of us limping on with unknown state. */
function daemonCrash(kind, err) {
  try {
    logMsg('error', 'FATAL: ' + kind + ' — daemon exiting', {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
  } catch {}
  writeExitBreadcrumb(kind, err);
  process.exit(1);
}

// Registered at module scope so even a startup-phase crash (reconcile,
// migration) leaves a breadcrumb. exit(1), never limp on: after an arbitrary
// throw the in-memory session state is unknowable, and a clean respawn
// re-adopts every live CLI from the registry (Phase C reconcile).
process.on('uncaughtException', function (err) { daemonCrash('uncaughtException', err); });
process.on('unhandledRejection', function (reason) { daemonCrash('unhandledRejection', reason); });

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
  // An INTENTIONAL daemon-initiated reclamation is not a failure, and the JSONL
  // tail cannot tell us it happened. The idle scanner stamps idleReclaimAt
  // before it signals; the death then lands here through whichever path notices
  // it (usually orphan-poll ESRCH → code -1). Verified production case: the last
  // line was a control_response (the reply to a Walnut-issued control request —
  // a routine shape), so isTurnCompleteExit said false, exitCode stayed -1, and
  // the projection painted a red "Error" over a healthy, fully resumable session
  // we reclaimed on purpose. Checked FIRST and unconditionally: the flag carries
  // information the tail does not contain, which is why isTurnCompleteExit is
  // left alone. Keep in sync with daemon-core.ts reapSession.
  const intentionalReclaim = session.idleReclaimAt != null;
  if (intentionalReclaim && code !== 0) {
    logMsg('info', 'reapSession: intentional idle reclamation, normalizing exit code', {
      sid, pid: session.pid, originalCode: code, originalReason: reason,
      jsonlAgeMs, cleanExit, idleReclaimAt: session.idleReclaimAt,
    });
    code = 0;
    reason = reason + '+intentional-idle-reclaim';
  } else if (code !== 0 && cleanExit) {
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

  // ── INVARIANT enforcement point 3: no adoptable durable crons ──
  // Mirrors daemon-core.ts reapSession + stripDurableTasksForSession (parity
  // test locks the sync). A durable task whose creator just died is the
  // 2026-08-09 incident in waiting — the next lock holder in this directory
  // would run it as a bare user message. Strip our own rows only, never a live
  // sibling's. This is the one enforcement point the model cannot decline
  // (point 2's injected correction was verifiably refused on 2026-08-11).
  // Gated by hook rules (session.reap → strip-own-rows), not a hardcoded env.
  if (session.cwd && hookActions('session.reap', { sid: sid, cwd: session.cwd }).indexOf('strip-own-rows') !== -1) {
    try {
      const tasksPath = path.join(session.cwd, '.claude', 'scheduled_tasks.json');
      let raw = null;
      try { raw = fs.readFileSync(tasksPath, 'utf-8'); } catch {}
      const strip = stripDurableTasksForSession(raw, sid);
      if (strip.changed && strip.text != null) {
        const tmp = tasksPath + '.walnut-' + String(session.pid || 0) + '.tmp';
        fs.writeFileSync(tmp, strip.text, { mode: 0o600 });
        fs.renameSync(tmp, tasksPath);
        logMsg('warn', 'stripped dead session durable crons (Walnut policy: session-scoped only)', {
          sid: sid, removed: strip.removed, tasksPath: tasksPath,
        });
      }
    } catch (err) {
      logMsg('warn', 'durable-cron strip failed', { sid: sid, error: err.message });
    }
  }

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

  // C18: DRAIN the tailer before assembling the death snapshot. The tailer's
  // poll returns early once state !== 'running' (set above), so the final
  // result/idle lines the CLI wrote microseconds before exiting would never be
  // folded — the death push and every later getState pull would serve a frozen
  // fold stuck at turnActive=true. Must run BEFORE pushSnapshot.
  // Keep in sync with daemon-core.ts reapSession (drainFoldFn).
  try { drainSessionFold(session); } catch {}

  // C1: death snapshots push IMMEDIATELY (skip the 50ms coalesce), BEFORE the
  // exit fan-out clears the subscriber set. exitCode is already normalized.
  // Keep in sync with daemon-standalone.ts / daemon-core.ts.
  try { pushSnapshot(sid, true); } catch {}

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
const BG_TERMINAL_STATUSES = new Set(['completed', 'failed', 'stopped', 'cancelled', 'killed']);
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

// STREAMED, never readFileSync: the old whole-file read materialized a whale
// jsonl (156MB observed) as one string + a split() array on every
// attach/resume/adopt — RSS 104MB→789MB in ~30s before a silent daemon death
// (the 2026-08-13 phone-send data-loss family). Same 1MB-chunk + byte-carry
// shape as rebuildFoldStateFromJsonl; the '"task_' substring pre-filter means
// almost no line is ever decoded. Keep in sync with daemon-standalone.ts.
const TASK_LINE_MARKER = Buffer.from('"task_');
function rebuildTaskStateFromJsonl(jsonlPath, now) {
  const ts = emptyTaskState();
  let fd;
  try { fd = fs.openSync(jsonlPath, 'r'); } catch { return ts; }
  try {
    const buf = Buffer.alloc(FOLD_REBUILD_CHUNK);
    let filePos = 0;
    let v = 0;
    let carry = Buffer.alloc(0);
    let discardThroughNextNewline = false;
    for (;;) {
      const n = fs.readSync(fd, buf, 0, FOLD_REBUILD_CHUNK, filePos);
      if (n <= 0) break;
      filePos += n;
      const chunk = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
      let start = 0;
      for (;;) {
        const nl = chunk.indexOf(10, start); // newline byte
        if (nl === -1) break;
        v += (nl - start) + 1;
        if (discardThroughNextNewline) discardThroughNextNewline = false;
        // Byte-level pre-filter on JUST this line's slice (no copy): only
        // task_* lines are ever decoded to a string.
        else if (chunk.subarray(start, nl).includes(TASK_LINE_MARKER)) {
          const line = chunk.subarray(start, nl).toString('utf-8');
          if (line.trim() && line.includes('"task_')) {
            try { applyTaskEvent(ts, JSON.parse(line), v, now); } catch {}
          }
        }
        start = nl + 1;
      }
      carry = Buffer.from(chunk.subarray(start));
      if (carry.length > TAILER_CARRY_MAX) {
        logMsg('error', 'task rebuild carry overflow — dropping oversized partial line', {
          jsonlPath, carryBytes: carry.length, cap: TAILER_CARRY_MAX, filePos,
        });
        v = filePos;
        carry = Buffer.alloc(0);
        discardThroughNextNewline = true;
      }
    }
  } catch { /* partial rebuild is still safe — recent state wins on the live stream */ } finally {
    try { fs.closeSync(fd); } catch {}
  }
  return ts;
}

// ── C1: session-snapshot fold (docs/plan/session-snapshot-source-of-truth.md §4) ──
// The pure fold functions are injected TEXTUALLY at deploy time by
// getDaemonSource() from daemon-fold.ts (fn.toString(), same substitution
// mechanism as the version stamp) — never hand-edit the placeholders. The
// wiring below must mirror daemon-standalone.ts (parity test locks it).
const foldLine = __FOLD_LINE__;
const initialFoldState = __INITIAL_FOLD_STATE__;
const assembleSnapshot = __ASSEMBLE_SNAPSHOT__;
// Field compare ignoring bare v advance — injected too (was hand-duplicated in
// both twins, so a one-sided edit could silently suppress a push).
const snapshotDiffers = __SNAPSHOT_DIFFERS__;

const SNAPSHOT_COALESCE_MS = 50;

// Upper bound on the tailer's in-memory torn-tail carry (see ensureWatcher).
// A single stream line larger than this cannot be assembled, so we log and
// realign rather than growing the buffer without limit.
const TAILER_CARRY_MAX = 32 * 1024 * 1024;

// Stream the whole jsonl through foldLine, from byte 0. Used by every rebuild
// site (daemon start / adopt / attach-discover / resume / unknown-sid getState).
// Chunked (1MB) with the torn tail carried as BYTES so whale files never
// materialize as one string. Returns { state, boundary } where boundary is the
// offset after the last COMPLETE (newline-terminated) line.
//
// A final unterminated segment (the CLI was mid-write when we read) is NOT
// folded and NOT counted in boundary — same rule as the live tailer's carry.
// Folding it would (a) parse a fragment as a whole line and (b) advance v past
// the real line end, so when the newline finally arrives the tailer's
// v > foldState.v guard skips the COMPLETE line forever. Reporting boundary
// (rather than stat().size) is what lets the caller start the watcher on a line
// boundary so the torn region is simply re-read.
//
// Carry cap: identical to the tailer's — an over-cap line is dropped and we
// realign on the next newline instead of re-concatenating without limit.
// Keep in sync with daemon-standalone.ts.
const FOLD_REBUILD_CHUNK = 1024 * 1024;
function rebuildFoldStateFromJsonl(jsonlPath) {
  let state = initialFoldState(0);
  let fd;
  // Running end-of-line byte offset — same coordinate as the tailer's v. Only
  // ever advanced past COMPLETE lines, so it doubles as the boundary.
  let v = 0;
  try { fd = fs.openSync(jsonlPath, 'r'); } catch { return { state: state, boundary: 0 }; }
  try {
    const buf = Buffer.alloc(FOLD_REBUILD_CHUNK);
    let filePos = 0;
    let carry = Buffer.alloc(0);
    let discardThroughNextNewline = false;
    for (;;) {
      const n = fs.readSync(fd, buf, 0, FOLD_REBUILD_CHUNK, filePos);
      if (n <= 0) break;
      filePos += n;
      const chunk = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
      let start = 0;
      for (;;) {
        const nl = chunk.indexOf(10, start); // newline byte
        if (nl === -1) break;
        v += (nl - start) + 1;
        if (discardThroughNextNewline) discardThroughNextNewline = false;
        else {
          const line = chunk.subarray(start, nl).toString('utf-8');
          if (line.trim()) state = foldLine(state, line, v);
        }
        start = nl + 1;
      }
      carry = Buffer.from(chunk.subarray(start)); // buf is reused next read
      if (carry.length > TAILER_CARRY_MAX) {
        logMsg('error', 'fold rebuild carry overflow — dropping oversized partial line', {
          jsonlPath, carryBytes: carry.length, cap: TAILER_CARRY_MAX, filePos,
        });
        v = filePos;
        carry = Buffer.alloc(0);
        discardThroughNextNewline = true;
      }
    }
    // A trailing unterminated fragment is deliberately left unfolded — see above.
  } catch { /* partial fold is still monotone-safe */ } finally {
    try { fs.closeSync(fd); } catch {}
  }
  return { state: state, boundary: v };
}

// ── C18: synchronous pre-death fold drain ──
// The CLI writes its final result + companion idle lines microseconds before
// exiting, and the tailer's 100ms poll does nothing once state !== 'running'
// (reapSession flips that first). Without this drain the death snapshot — and
// every later getState pull, which just re-assembles the same frozen fold —
// reports turnActive=true for a turn that provably ended on disk.
//
// Reads from the last complete-line boundary the watcher published (its in-memory
// carry died with it, so the torn region is simply re-read) to EOF, folds every
// COMPLETE line, and re-publishes the boundary. Bounded by the same carry cap.
// Keep in sync with daemon-standalone.ts drainSessionFold.
function drainSessionFold(session) {
  const from = session.watcher ? session.watcher.offset : (session.offset || 0);
  let size = 0;
  try { size = fs.statSync(session.jsonlPath).size; } catch { return; }
  if (size <= from) return;
  const boundary = drainFoldRange(session, from, size);
  session.offset = boundary;
  if (session.watcher) session.watcher.offset = boundary;
}

// Fold [from, to) into session.foldState, honoring the v > foldState.v guard
// (bytes already folded out-of-band must not fold twice). Returns the new
// complete-line boundary. Keep in sync with daemon-standalone.ts.
function drainFoldRange(session, from, to) {
  let boundary = from;
  let fd;
  try { fd = fs.openSync(session.jsonlPath, 'r'); } catch { return boundary; }
  try {
    const buf = Buffer.alloc(FOLD_REBUILD_CHUNK);
    let filePos = from;
    let carry = Buffer.alloc(0);
    let discardThroughNextNewline = false;
    while (filePos < to) {
      const want = Math.min(FOLD_REBUILD_CHUNK, to - filePos);
      const n = fs.readSync(fd, buf, 0, want, filePos);
      if (n <= 0) break;
      filePos += n;
      const chunk = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
      let start = 0;
      for (;;) {
        const nl = chunk.indexOf(10, start);
        if (nl === -1) break;
        boundary += (nl - start) + 1;
        if (discardThroughNextNewline) discardThroughNextNewline = false;
        else {
          const line = chunk.subarray(start, nl).toString('utf-8');
          if (line.trim() && boundary > session.foldState.v) {
            session.foldState = foldLine(session.foldState, line, boundary);
          }
        }
        start = nl + 1;
      }
      carry = Buffer.from(chunk.subarray(start));
      if (carry.length > TAILER_CARRY_MAX) {
        logMsg('error', 'fold drain carry overflow — dropping oversized partial line', {
          jsonlPath: session.jsonlPath, carryBytes: carry.length, cap: TAILER_CARRY_MAX, filePos,
        });
        boundary = filePos;
        carry = Buffer.alloc(0);
        discardThroughNextNewline = true;
      }
    }
  } catch { /* partial drain is still monotone-safe */ } finally {
    try { fs.closeSync(fd); } catch {}
  }
  return boundary;
}

// Combine the pure fold with imperatively-tracked daemon facts. exitCode is
// already normalized by reapSession (isTurnCompleteExit) when state='dead'.
// NOTE: streamEpochOf is declared BELOW (hoisted) — it must live INSIDE the
// assembleSessionSnapshot…"Startup reconcile" region because the snapshot-push
// unit harness (daemon-snapshot-wiring.test.ts scenario 10) evals exactly that
// text block; a reference to a function outside the block throws at eval time.
function assembleSessionSnapshot(session) {
  const ctrl = session.pendingCtrl;
  const snap = assembleSnapshot({
    foldState: session.foldState,
    pendingCtrl: ctrl
      ? { requestId: ctrl.reqId, toolName: ctrl.toolName, sinceTs: ctrl.receivedAt }
      : null,
    dead: session.state === 'dead',
    pid: session.pid,
    exitCode: session.exitCode,
    streamEpoch: streamEpochOf(session),
  });
  // Disk-side durable crons arm cronActive too — one-way OR, arm-only on the
  // walnut side, so a stale cache never unarms. Keep in sync with
  // daemon-standalone.ts.
  if (!snap.cronActive && session.diskCronCache && session.diskCronCache.armed) snap.cronActive = true;
  return snap;
}

// Stream-file identity: dev:ino:birthtimeMs — changes exactly when the file is
// recreated, which resets v to 0 and invalidates consumer watermarks (incident
// 019a7fe5). Cached; failed stat leaves null. Mirror daemon-standalone.ts.
function streamEpochOf(session) {
  if (session.streamEpoch) return session.streamEpoch;
  try {
    const st = fs.statSync(session.jsonlPath);
    session.streamEpoch = st.dev + ':' + st.ino + ':' + Math.floor(st.birthtimeMs);
  } catch {
    session.streamEpoch = null;
  }
  return session.streamEpoch;
}

function emitSnapshot(sid, session) {
  const snapshot = assembleSessionSnapshot(session);
  const prev = session.lastPushedSnapshot;
  if (prev && !snapshotDiffers(prev, snapshot)) return;
  session.lastPushedSnapshot = snapshot;
  for (const ws of session.subscribers) {
    if (ws.readyState === 1) {
      try { sendEvent(ws, 'snapshot', { sid, snapshot }); } catch {}
    }
  }
}

// Push entry point: coalesce within a 50ms window; death snapshots skip the
// coalesce (immediate=true) so a dead session is never reported late.
function pushSnapshot(sid, immediate) {
  const session = sessions.get(sid);
  if (!session) return;
  if (immediate) {
    if (session.snapshotTimer) { clearTimeout(session.snapshotTimer); session.snapshotTimer = null; }
    emitSnapshot(sid, session);
    return;
  }
  if (session.snapshotTimer) return; // window already open — coalesce
  session.snapshotTimer = setTimeout(() => {
    session.snapshotTimer = null;
    // Generation guard: cmdStart may have replaced the session under this sid.
    if (sessions.get(sid) !== session) return;
    emitSnapshot(sid, session);
  }, SNAPSHOT_COALESCE_MS);
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
    // generation must never replay history it didn't stream itself. The offset
    // is the fold rebuild's COMPLETE-line boundary, NOT a raw stat().size: if
    // the CLI was mid-write during adopt, a raw size starts the watcher MID-LINE
    // and the completed line is never folded whole (contract §4 boundary rule).
    // Keep in sync with daemon-standalone.ts createAdoptedSession (CLAUDE.md).
    const adoptFold = rebuildFoldStateFromJsonl(entry.jsonlPath); // C1: streamed, whale-safe
    const session = {
      proc: null,
      pipePath: entry.pipePath,
      jsonlPath: entry.jsonlPath,
      pgidPath: entry.pgidPath,
      pid,
      offset: adoptFold.boundary,
      taskState: rebuildTaskStateFromJsonl(entry.jsonlPath, Date.now()),
      foldState: adoptFold.state,
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
  // pid ≤ 1 = corrupted bookkeeping. kill(-1, sig) does NOT throw — POSIX
  // broadcasts to every process the user can signal (2026-08-09 incident).
  if (!Number.isInteger(pid) || pid <= 1) return false;
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

// Block the thread without spinning the event loop (cleanup() has no timers).
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Is this an isolated-dir daemon (sandbox / test / ephemeral demo) whose CLI
// children must die with it? Derived from DAEMON_DIR — the same definition
// local-daemon.ts uses for parentWatchdogEnv/stopIfIsolated — NOT from
// WALNUT_DAEMON_PARENT_PID, so direct-spawn test launchers get the fix without
// opting in and a stale inherited PARENT_PID can never make the PRODUCTION
// daemon kill live sessions. Keep in sync with daemon-standalone.ts.
function shouldReapOnExit() {
  try {
    return path.resolve(DAEMON_DIR) !== path.resolve(PROD_DAEMON_DIR);
  } catch {
    return false; // unresolvable → treat as prod (never kill)
  }
}

// Synchronous kill-all for isolated-dir daemon exit (cleanup() runs right
// before process.exit, so the async ladder in killSessionProcessGroup would
// never fire). Mirrors that ladder — SIGINT (on-stop hooks) → SIGTERM →
// SIGKILL — with a budget above the CLI's ~3.5-5s graceful-shutdown window.
// Production daemons never call this — see cleanup(). Keep in sync with
// daemon-standalone.ts.
function reapAllSessionGroupsSync() {
  const pids = [];
  for (const [sid, session] of sessions) {
    // Only LIVE sessions — a dead session's pid is never nulled and macOS
    // recycles pids, so signalling a stale one can hit an unrelated group.
    if ((session.state || 'running') !== 'running' || session.exitCode !== null) continue;
    if (!session.pid || !isProcessGroupAlive(session.pid)) continue;
    logMsg('info', 'isolated-dir exit: SIGINT session group', { sid, pid: session.pid });
    killProcessGroup(session.pid, 'SIGINT');
    pids.push(session.pid);
  }
  if (pids.length === 0) return;

  const sigintDeadline = Date.now() + 5000;
  while (Date.now() < sigintDeadline && pids.some(isProcessGroupAlive)) sleepSync(200);

  const stillAlive = pids.filter(isProcessGroupAlive);
  if (stillAlive.length === 0) return;
  for (const pid of stillAlive) {
    logMsg('info', 'isolated-dir exit: SIGTERM session group', { pid });
    killProcessGroup(pid, 'SIGTERM');
  }
  const termDeadline = Date.now() + 2000;
  while (Date.now() < termDeadline && stillAlive.some(isProcessGroupAlive)) sleepSync(200);

  for (const pid of stillAlive) {
    if (isProcessGroupAlive(pid)) {
      logMsg('warn', 'isolated-dir exit: SIGKILL session group', { pid });
      killProcessGroup(pid, 'SIGKILL');
    }
  }
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
  'status', 'appendUserMarker', 'send', 'attach', 'read-history', 'ping', 'bridgeResume', 'stt',
  // Narrow image fetch (extension allowlist + size cap) — lets the cloud box
  // proxy session-referenced pictures to phones. NOT fs.read: a compromised
  // cloud box must never get arbitrary file reads on exec hosts.
  'fs.readImage',
  // Narrow image save (mediaType allowlist + decoded-size cap + magic-byte
  // check, fixed daemon-owned directory, generated filename) — lets a phone
  // attach pictures to a session over the cloud box. NOT fs.write: a
  // compromised cloud box must never get arbitrary file writes on exec hosts.
  'image.save',
  // Narrow bounded file read (2MB cap + host-side path sandbox: traversal
  // rejection, realpath resolution, secret-path denylist) — lets the cloud
  // box serve phone file previews (HTML/text) for files on this host. NOT
  // fs.read: a compromised cloud box must never get unbounded arbitrary
  // reads (keys, configs) off exec hosts.
  'fs.readBounded',
  // Narrow launch relay: forwarded UP to the connected walnut server (same
  // relay shape as stt), which runs its full quick-start validation chain —
  // the daemon spawns NOTHING from this command. NOT the raw spawn command:
  // a compromised cloud box must never hand this daemon arbitrary argv.
  'session.launch',
  // Narrow control relay (model/effort/fork/model-options): same forward-to-
  // walnut-server shape as session.launch — the daemon executes NOTHING
  // itself, the primary re-validates everything.
  'session.control',
  // Narrow message relay: forwarded UP to the connected walnut server, which
  // enqueues into the DURABLE session message queue (same store + reconnect
  // redelivery as web sends). The asymmetry fix for the 2026-08-13 phone-send
  // data-loss family — a daemon death mid-sequence becomes delayed delivery,
  // not loss. The daemon writes NOTHING itself from this command.
  'session.message',
  // DELIBERATELY ABSENT: the fs.rename / fs.rm / fs.copy mutation family (and
  // fs.write / fs.mkdir). A compromised cloud box must never be able to move or
  // delete files on an exec host — mutation is reachable only over the trusted
  // SSH-tunneled walnut client.
]);

function handleCommand(ws, msg) {
  let cmd;
  try { cmd = JSON.parse(msg); } catch { return sendError(ws, null, 'invalid JSON'); }
  // Valid JSON ≠ a command frame: "null"/"42"/"\\"x\\"" parse fine but the
  // destructure below would THROW on null (a poison frame that predates the
  // dispatch guard — one bad client frame killed the whole daemon).
  if (!cmd || typeof cmd !== 'object') return sendError(ws, null, 'invalid JSON');
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

  // One command must never kill the daemon: a throw anywhere in a handler
  // (the pre-guard era: a whale-file rebuild OOM inside cmdAttach took the
  // whole process down MID phone-send — marker written, message lost) becomes
  // an error reply to the caller. Async handlers (fs.*) return promises — a
  // rejection there would otherwise surface as unhandledRejection and trip
  // the fatal guard. Keep in sync with daemon-standalone.ts.
  const replyError = function (err) {
    logMsg('error', 'handleCommand: handler threw — replying with error instead of dying', {
      cmd: cmd.cmd, id,
      sid: typeof cmd.sid === 'string' ? cmd.sid : undefined,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    sendError(ws, id, 'internal daemon error handling ' + cmd.cmd + ': '
      + (err instanceof Error ? err.message : String(err)));
  };
  try {
    const out = dispatchCommand(ws, id, cmd);
    if (out && typeof out.then === 'function') out.catch(replyError);
    return;
  } catch (err) {
    return replyError(err);
  }
}

// Unified agent.* command family (agent-commands-v1) — inlined twin of
// resolveAgentCommand. Keep in sync with src/providers/agent-command-map.ts.
// This template runs on a plain remote Node with no imports, so the routing
// table is inlined here verbatim instead of being required.
// Engines on the ACP worker family — mirrors engine-registry runtimeKind==='acp'.
var AGENT_ACP_ENGINES = { codex: 1, gemini: 1, opencode: 1, goose: 1, custom: 1 };
var AGENT_ACP_ROUTES = {
  start: 'acpStart', send: 'acpSend', steer: 'acpSteer', cancel: 'acpCancel',
  respond: 'acpRespond', setOption: 'acpSetConfigOption', state: 'acpState',
  newSession: 'acpNewSession', stop: 'acpStop', subscribe: 'acpSubscribe',
};
// steer → send: a FIFO write IS the native mid-turn path.
var AGENT_NATIVE_ROUTES = {
  start: 'start', send: 'send', steer: 'send', cancel: null, respond: null,
  setOption: 'setMode', state: 'getState', newSession: null, stop: 'stop',
  subscribe: null,
};
var AGENT_NATIVE_UNSUPPORTED = {
  cancel: 'native interrupts ride sendRaw control frames',
  respond: 'native permission resolution happens over the CLI control protocol, not a daemon command',
  newSession: 'native sessions are created via start',
  subscribe: 'native subscription is implicit in start/attach',
};

function resolveAgentCommand(engine, op) {
  if (typeof op !== 'string' || !Object.prototype.hasOwnProperty.call(AGENT_NATIVE_ROUTES, op)) {
    return { ok: false, error: 'unknown agent op: ' + String(op), errorKind: 'agent_op_unknown' };
  }
  if (typeof engine === 'string' && Object.prototype.hasOwnProperty.call(AGENT_ACP_ENGINES, engine)) {
    return { ok: true, cmd: AGENT_ACP_ROUTES[op] };
  }
  var nativeCmd = AGENT_NATIVE_ROUTES[op];
  if (!nativeCmd) {
    return {
      ok: false,
      error: 'agent.' + op + ' is not supported for the native engine (' + AGENT_NATIVE_UNSUPPORTED[op] + ')',
      errorKind: 'agent_op_unsupported',
    };
  }
  return { ok: true, cmd: nativeCmd };
}

function dispatchCommand(ws, id, cmd) {
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
    case 'fs.readImage': return cmdFsReadImage(ws, id, cmd);
    case 'fs.readBounded': return cmdFsReadBounded(ws, id, cmd);
    case 'image.save': return cmdImageSave(ws, id, cmd);
    case 'fs.write': return cmdFsWrite(ws, id, cmd);
    case 'fs.mkdir': return cmdFsMkdir(ws, id, cmd);
    // Mutation family ('fs-mutate-v1'). NOT in BRIDGE_ALLOWED_COMMANDS — see
    // the note there: a compromised cloud box must never move/delete host files.
    case 'fs.rename': return cmdFsRename(ws, id, cmd);
    case 'fs.rm': return cmdFsRm(ws, id, cmd);
    case 'fs.copy': return cmdFsCopy(ws, id, cmd);
    case 'fs.ls': return cmdFsLs(ws, id, cmd);
    case 'fs.find': return cmdFsFind(ws, id, cmd);
    case 'fs.stat': return cmdFsStat(ws, id, cmd);
    case 'fs.resolvePath': return cmdFsResolvePath(ws, id, cmd);
    case 'fs.grep': return cmdFsGrep(ws, id, cmd);
    // NOT in BRIDGE_ALLOWED_COMMANDS: starts a process — only the trusted
    // SSH-tunneled walnut socket may ask, never the public cloud bridge.
    case 'vscode.ensure': return cmdVscodeEnsure(ws, id, cmd);
    case 'vscode.status':
      if (!vscodeServerCore) return sendOk(ws, id, { running: false });
      return vscodeServerCore.codeServerStatus().then(
        function (s) { sendOk(ws, id, s); },
        function (err) { sendError(ws, id, 'vscode.status failed: ' + err.message); },
      );
    case 'fs.readRange': return cmdFsReadRange(ws, id, cmd);
    case 'git.diff': return cmdGitDiff(ws, id, cmd);
    // File-history family ('git-file-history-v1'). NOT in BRIDGE_ALLOWED_COMMANDS:
    // it reads arbitrary host paths, which the cloud bridge must never reach.
    case 'git.fileLog': return cmdGitFileLog(ws, id, cmd);
    case 'git.fileShow': return cmdGitFileShow(ws, id, cmd);
    case 'changes.compute': return cmdChangesCompute(ws, id, cmd);
    case 'changes.file': return cmdChangesFile(ws, id, cmd);
    case 'transcript.rewindProbe': return cmdTranscriptRewindProbe(ws, id, cmd);
    case 'list': return cmdList(ws, id);
    case 'sessions.discoverExternal': return cmdDiscoverExternalSessions(ws, id, cmd);
    case 'bridge.configure': return cmdBridgeConfigure(ws, id, cmd);
    // NOT in BRIDGE_ALLOWED_COMMANDS: rule content may only arrive over the
    // trusted SSH-tunneled walnut socket, never from the cloud bridge.
    case 'hooks.configure': return cmdHooksConfigure(ws, id, cmd);
    case 'skills.sync': return cmdSkillsSync(ws, id, cmd);
    case 'bridgeResume': return cmdBridgeResume(ws, id, cmd);
    case 'stt': return cmdSttRelay(ws, id, cmd);
    case 'stt-result': return cmdSttResult(ws, id, cmd);
    case 'session.launch': return cmdLaunchRelay(ws, id, cmd);
    case 'launch-result': return cmdLaunchResult(ws, id, cmd);
    case 'session.control': return cmdControlRelay(ws, id, cmd);
    case 'control-result': return cmdControlResult(ws, id, cmd);
    case 'session.message': return cmdMessageRelay(ws, id, cmd);
    // NOT in BRIDGE_ALLOWED_COMMANDS: only the trusted SSH-tunneled walnut
    // client may answer message relays (same rule as control-result).
    case 'message-result': return cmdMessageResult(ws, id, cmd);
    // NOT in BRIDGE_ALLOWED_COMMANDS: only the trusted SSH-tunneled walnut
    // client may answer agent-gateway relays (see the gateway section).
    case 'gateway-result': return cmdGatewayResult(ws, id, cmd);
    // NOT in BRIDGE_ALLOWED_COMMANDS: reverse direction — the trusted walnut
    // server pushes slim mobile feed events DOWN, the daemon relays them to
    // the cloud bridge (see cmdMobileEvent).
    case 'mobile-event': return cmdMobileEvent(ws, id, cmd);
    // ACP worker commands: not implemented in the source-template daemon yet
    // (MVP = local Mac binary daemon only). Answer with a structured errorKind
    // so walnut can distinguish "host can't do ACP" from a transient failure.
    // Keep this case list in sync with daemon-standalone.ts + daemon-capabilities.ts.
    case 'acpStart':
    case 'acpSend':
    case 'acpSteer':
    case 'acpCancel':
    case 'acpRespond':
    case 'acpSetConfigOption':
    case 'acpState':
    case 'acpNewSession':
    case 'acpStop':
    case 'acpSubscribe': {
      try { ws.send(JSON.stringify({ id, ok: false, error: 'ACP sessions are not supported on this host yet', errorKind: 'acp_unsupported' })); } catch {}
      return;
    }
    // Unified agent.* family (agent-commands-v1): one namespace, engine-routed
    // onto the legacy per-engine handlers (see resolveAgentCommand above).
    // Codex-routed ops land on the acp* cases above and get the structured
    // acp_unsupported reply — the desired degradation on a source daemon.
    // SECURITY: the re-dispatch bypasses the bridge allowlist check (it runs
    // BEFORE dispatch), so no 'agent.*' name may ever join
    // BRIDGE_ALLOWED_COMMANDS. Pinned by test.
    case 'agent.start':
    case 'agent.send':
    case 'agent.steer':
    case 'agent.cancel':
    case 'agent.respond':
    case 'agent.setOption':
    case 'agent.state':
    case 'agent.newSession':
    case 'agent.stop':
    case 'agent.subscribe': {
      var agentRoute = resolveAgentCommand(cmd.engine, String(cmd.cmd).slice('agent.'.length));
      if (!agentRoute.ok) {
        try { ws.send(JSON.stringify({ id, ok: false, error: agentRoute.error, errorKind: agentRoute.errorKind })); } catch {}
        return;
      }
      return dispatchCommand(ws, id, Object.assign({}, cmd, { cmd: agentRoute.cmd }));
    }
    case 'ping': return sendOk(ws, id, { pong: true });
    case 'hello': return sendOk(ws, id, {
      version: DAEMON_VERSION,
      capabilities: daemonCapabilities(),
      instanceId: DAEMON_INSTANCE_ID,
      startedAt: DAEMON_START_TS,
      uptimeSec: Math.floor((Date.now() - DAEMON_START_TS) / 1000),
    });
    default: return sendError(ws, id, 'unknown command: ' + cmd.cmd);
  }
}

// ── Bridge-safe resume: respawn a dead session with --resume <sid> ──
// Only {sid, message, cwd?, model?} accepted; argv is built HERE (stored args
// patched to --resume this sid, or a fixed default claude command when the
// record was lost to a daemon restart). Gated on the session's jsonl existing
// in STREAMS_DIR — proof it genuinely lived on this host. Keep in sync with
// daemon-standalone.ts.
function cmdBridgeResume(ws, id, cmd) {
  var sid = cmd.sid, message = cmd.message, cwdHint = cmd.cwd, model = cmd.model;
  if (!sid || !message) {
    return sendError(ws, id, 'bridgeResume: missing sid or message');
  }

  var session = sessions.get(sid);

  if (session && session.state === 'running') {
    return cmdSend(ws, id, { cmd: 'send', sid: sid, message: message });
  }

  var jsonlPath = path.join(STREAMS_DIR, sid + '.jsonl');
  if (!fs.existsSync(jsonlPath)) {
    return sendError(ws, id, 'bridgeResume: session not found: ' + sid);
  }

  var cwd = (session && session.cwd && session.cwd !== '') ? session.cwd : cwdHint;
  if (!cwd) {
    return sendError(ws, id, 'bridgeResume: no cwd known for session (record lost, no hint)');
  }

  var args;
  if (session && session.args && session.args.length > 0) {
    args = session.args.slice();
    // Bypass CAPABILITY only. The bare --dangerously-skip-permissions also
    // SELECTS bypass and outranks --permission-mode, so injecting it here would
    // silently resume a plan/accept/default session in full-trust bypass.
    if (!args.includes('--allow-dangerously-skip-permissions')) {
      args.splice(1, 0, '--allow-dangerously-skip-permissions');
    }
    var bare = args.indexOf('--dangerously-skip-permissions');
    if (bare >= 0) { args.splice(bare, 1); }
    var ri = args.indexOf('--resume');
    if (ri >= 0 && ri + 1 < args.length) {
      args[ri + 1] = sid;
    } else {
      args.push('--resume', sid);
    }
  } else {
    args = [
      'claude', '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--debug',
      '--allow-dangerously-skip-permissions',
      '--permission-mode', (session && session.mode && MODE_CLI[session.mode]) || 'default',
    ];
    if (model) { args.push('--model', model); }
    args.push('--resume', sid, '--input-format', 'stream-json', '--permission-prompt-tool', 'stdio');
  }

  logMsg('info', 'bridgeResume: respawning dead session', {
    sid: sid, cwd: cwd, recordLost: !session || !session.args || session.args.length === 0,
  });
  // cmdStart is async (FIFO write continuation) — return the promise so the
  // dispatcher's rejection handler owns any throw.
  return cmdStart(ws, id, {
    cmd: 'start',
    sid: sid,
    args: args,
    cwd: cwd,
    message: message,
    resume: true,
    mode: (session && session.mode) || 'default',
  });
}

// ── STT relay: bridge audio → the connected walnut server's local engine ──
// Keep in sync with daemon-standalone.ts. A bridge stt request is relayed as
// an stt-request event to a TRUSTED (non-bridge) client, which transcribes
// and answers with an stt-result command carrying the same relayId. No
// trusted client (Mac down) → fail fast so the cloud falls back to OpenAI.
var STT_RELAY_TIMEOUT_MS = 90000;
var sttRelayCounter = 0;
var sttRelayPending = new Map();

function cmdSttRelay(ws, id, cmd) {
  var audio = cmd.audio, format = cmd.format, language = cmd.language;
  if (!audio || !format) {
    return sendError(ws, id, 'stt: missing audio or format');
  }
  var target = null;
  for (const client of wsClients) {
    if (client.origin !== 'bridge') { target = client; break; }
  }
  if (!target) {
    return sendError(ws, id, 'stt: no transcription host connected');
  }
  sttRelayCounter += 1;
  var relayId = sttRelayCounter;
  var timer = setTimeout(function () {
    sttRelayPending.delete(relayId);
    sendError(ws, id, 'stt: transcription timed out');
  }, STT_RELAY_TIMEOUT_MS);
  sttRelayPending.set(relayId, { ws: ws, id: id, timer: timer });
  logMsg('info', 'stt: relaying to transcription host', { relayId: relayId, format: format, audioB64Len: audio.length });
  sendEvent(target, 'stt-request', { relayId: relayId, audio: audio, format: format, language: language });
}

function cmdSttResult(ws, id, cmd) {
  var relayId = cmd.relayId, text = cmd.text, durationMs = cmd.durationMs, error = cmd.error;
  var pending = typeof relayId === 'number' ? sttRelayPending.get(relayId) : undefined;
  if (!pending) {
    return sendOk(ws, id, { stale: true });
  }
  sttRelayPending.delete(relayId);
  clearTimeout(pending.timer);
  if (typeof text === 'string' && !error) {
    logMsg('info', 'stt: relay complete', { relayId: relayId, chars: text.length, durationMs: durationMs });
    sendOk(pending.ws, pending.id, { text: text, durationMs: durationMs || 0 });
  } else {
    sendError(pending.ws, pending.id, 'stt: ' + (error || 'transcription failed'));
  }
  sendOk(ws, id, {});
}

// ── Launch relay: bridge session-create request → the connected walnut server ──
// Keep in sync with daemon-standalone.ts. The daemon has no session-record
// store — records live on the walnut server (session-tracker), and
// quickStartSession is the only correct creation core. A bridge session.launch
// request is relayed as a launch-request event to a TRUSTED (non-bridge)
// client, which validates + creates and answers with a launch-result command
// carrying the same relayId. The daemon spawns NOTHING here; a compromised
// cloud box gets exactly one verb: ask the primary to run its own launch
// validation. No trusted client (walnut server down) → fail fast.

var LAUNCH_RELAY_TIMEOUT_MS = 45000;
var launchRelayCounter = 0;
var launchRelayPending = new Map();

function cmdLaunchRelay(ws, id, cmd) {
  var action = cmd.action, params = cmd.params;
  if (!action) {
    return sendError(ws, id, 'session.launch: missing action');
  }
  var target = null;
  for (const client of wsClients) {
    if (client.origin !== 'bridge') { target = client; break; }
  }
  if (!target) {
    return sendError(ws, id, 'session.launch: no primary server connected');
  }
  launchRelayCounter += 1;
  var relayId = launchRelayCounter;
  var timer = setTimeout(function () {
    launchRelayPending.delete(relayId);
    sendError(ws, id, 'session.launch: primary server timed out');
  }, LAUNCH_RELAY_TIMEOUT_MS);
  launchRelayPending.set(relayId, { ws: ws, id: id, timer: timer });
  logMsg('info', 'session.launch: relaying to primary server', { relayId: relayId, action: action });
  sendEvent(target, 'launch-request', { relayId: relayId, action: action, params: params || {} });
}

function cmdLaunchResult(ws, id, cmd) {
  var relayId = cmd.relayId, result = cmd.result, error = cmd.error, errorKind = cmd.errorKind;
  var pending = typeof relayId === 'number' ? launchRelayPending.get(relayId) : undefined;
  if (!pending) {
    // Late result after timeout — ack and drop.
    return sendOk(ws, id, { stale: true });
  }
  launchRelayPending.delete(relayId);
  clearTimeout(pending.timer);
  if (result && !error) {
    logMsg('info', 'session.launch: relay complete', { relayId: relayId });
    sendOk(pending.ws, pending.id, { result: result });
  } else {
    // Carry errorKind through so the cloud route maps the precise 4xx.
    try {
      pending.ws.send(JSON.stringify({
        id: pending.id, ok: false,
        error: error || 'launch failed',
        errorKind: errorKind || 'internal',
      }));
    } catch {}
  }
  sendOk(ws, id, {});
}

// ── Control relay: bridge session-control request → the connected walnut server ──
// Mirror of the launch relay above (same trusted-client pick, same timeout
// map, same errorKind passthrough) for model/effort/fork/model-options. The
// daemon executes NOTHING here — the walnut server re-validates and runs the
// shared session-controls core, answering with a control-result command
// carrying the same relayId. Keep in sync with daemon-standalone.ts.

var CONTROL_RELAY_TIMEOUT_MS = 45000;
var controlRelayCounter = 0;
var controlRelayPending = new Map();

function cmdControlRelay(ws, id, cmd) {
  var action = cmd.action, params = cmd.params;
  var targetSid = cmd.sessionId || cmd.sid;
  if (!action) {
    return sendError(ws, id, 'session.control: missing action');
  }
  if (!targetSid) {
    return sendError(ws, id, 'session.control: missing sessionId');
  }
  var target = null;
  for (const client of wsClients) {
    if (client.origin !== 'bridge') { target = client; break; }
  }
  if (!target) {
    return sendError(ws, id, 'session.control: no primary server connected');
  }
  controlRelayCounter += 1;
  var relayId = controlRelayCounter;
  var timer = setTimeout(function () {
    controlRelayPending.delete(relayId);
    sendError(ws, id, 'session.control: primary server timed out');
  }, CONTROL_RELAY_TIMEOUT_MS);
  controlRelayPending.set(relayId, { ws: ws, id: id, timer: timer });
  logMsg('info', 'session.control: relaying to primary server', { relayId: relayId, action: action, sid: targetSid });
  sendEvent(target, 'control-request', { relayId: relayId, action: action, sessionId: targetSid, params: params || {} });
}

function cmdControlResult(ws, id, cmd) {
  var relayId = cmd.relayId, result = cmd.result, error = cmd.error, errorKind = cmd.errorKind, errorCode = cmd.errorCode;
  var pending = typeof relayId === 'number' ? controlRelayPending.get(relayId) : undefined;
  if (!pending) {
    // Late result after timeout — ack and drop.
    return sendOk(ws, id, { stale: true });
  }
  controlRelayPending.delete(relayId);
  clearTimeout(pending.timer);
  if (result && !error) {
    logMsg('info', 'session.control: relay complete', { relayId: relayId });
    sendOk(pending.ws, pending.id, { result: result });
  } else {
    // Carry errorKind/errorCode through so the cloud route maps the precise 4xx.
    var failPayload = {
      id: pending.id, ok: false,
      error: error || 'control failed',
      errorKind: errorKind || 'internal',
    };
    if (errorCode) failPayload.errorCode = errorCode;
    try {
      pending.ws.send(JSON.stringify(failPayload));
    } catch {}
  }
  sendOk(ws, id, {});
}

// ── Message relay: bridge phone send → the connected walnut server's durable queue ──
// Mirror of the control relay above (same trusted-client pick, same timeout
// map, same errorKind passthrough). The daemon writes NOTHING itself — the
// walnut server enqueues the message into the SAME durable queue web sends
// use (sendMessageToSession), so a daemon/CLI death anywhere after the
// enqueue converts to delayed redelivery instead of loss (the 2026-08-13
// phone-send data-loss family). messageId (qm-mobile-*) rides through for
// end-to-end idempotence. Keep in sync with daemon-standalone.ts.

var MESSAGE_RELAY_TIMEOUT_MS = 45000;
var messageRelayCounter = 0;
var messageRelayPending = new Map();

function cmdMessageRelay(ws, id, cmd) {
  var message = cmd.message, messageId = cmd.messageId;
  var targetSid = cmd.sessionId || cmd.sid;
  if (!targetSid || typeof message !== 'string' || message === '' || !messageId) {
    return sendError(ws, id, 'session.message: missing sessionId, message, or messageId');
  }
  var target = null;
  for (const client of wsClients) {
    if (client.origin !== 'bridge') { target = client; break; }
  }
  if (!target) {
    return sendError(ws, id, 'session.message: no primary server connected');
  }
  messageRelayCounter += 1;
  var relayId = messageRelayCounter;
  var timer = setTimeout(function () {
    messageRelayPending.delete(relayId);
    sendError(ws, id, 'session.message: primary server timed out');
  }, MESSAGE_RELAY_TIMEOUT_MS);
  messageRelayPending.set(relayId, { ws: ws, id: id, timer: timer });
  logMsg('info', 'session.message: relaying to primary server', { relayId: relayId, sid: targetSid, messageId: messageId });
  sendEvent(target, 'message-request', { relayId: relayId, sessionId: targetSid, message: message, messageId: messageId });
}

function cmdMessageResult(ws, id, cmd) {
  var relayId = cmd.relayId, result = cmd.result, error = cmd.error, errorKind = cmd.errorKind;
  var pending = typeof relayId === 'number' ? messageRelayPending.get(relayId) : undefined;
  if (!pending) {
    // Late result after timeout — ack and drop.
    return sendOk(ws, id, { stale: true });
  }
  messageRelayPending.delete(relayId);
  clearTimeout(pending.timer);
  if (result && !error) {
    logMsg('info', 'session.message: relay complete', { relayId: relayId });
    sendOk(pending.ws, pending.id, { result: result });
  } else {
    // Carry errorKind through so the cloud route maps the precise 4xx/503.
    try {
      pending.ws.send(JSON.stringify({
        id: pending.id, ok: false,
        error: error || 'message enqueue failed',
        errorKind: errorKind || 'internal',
      }));
    } catch {}
  }
  sendOk(ws, id, {});
}

// ── Agent gateway: on-host unix socket → Mac hub relay ──
// Keep in sync with daemon-standalone.ts gateway section. The pure protocol
// logic (parse/validate/alias resolution) from gateway-core.ts is hand-inlined
// here — this template cannot import. A walnut CLI writes one NDJSON request line
// to the daemon dir's agent-gateway.sock; the daemon resolves the caller's
// CURRENT sid via gatewaySidAliases and relays to the Mac hub with the same
// reverse-RPC shape as cmdLaunchRelay/cmdLaunchResult (relayId + pending map +
// gateway-request event / gateway-result command).

var GATEWAY_SOCK_PATH = path.join(DAEMON_DIR, 'agent-gateway.sock');
var GATEWAY_SHIM_DIR = path.join(DAEMON_DIR, 'bin');
var GATEWAY_SHIM_PATH = path.join(GATEWAY_SHIM_DIR, 'walnut');
// 28MB (keep in sync with gateway-core.ts): one human_inbox_send is ONE line,
// and a digest letter that embeds base64 audio or video is megabytes. Bounds the
// INLINE lane only — a payload over GATEWAY_INLINE_ARGS_MAX_BYTES (1MB) rides a
// path the hub range-reads in batches, so a 100MB letter never touches this line.
// Must stay below the 32MB WS frame an inline request also crosses on a remote host.
var GATEWAY_MAX_LINE_BYTES = 28 * 1024 * 1024;
var GATEWAY_OPS = ['peers.list', 'peers.send', 'tools.list', 'tools.call'];
// 20s default (shorter than the 45s launch relay — peers ops have no long
// validation chain); WALNUT_GATEWAY_TIMEOUT_MS overrides (tests only).
var GATEWAY_HUB_TIMEOUT_MS = (function () {
  var n = Number(process.env.WALNUT_GATEWAY_TIMEOUT_MS || '');
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 20000;
})();

// oldSid → newSid, maintained by cmdRename (a CLI's WALNUT_SESSION_ID env is
// frozen at spawn; fresh spawns use a tmp sid that rename re-keys).
var gatewaySidAliases = new Map();

var gatewayRelayCounter = 0;
var gatewayRelayPending = new Map();

function gatewayError(code, message) {
  return { ok: false, error: { code: code, message: message } };
}

// Mirror of gateway-core.ts parseGatewayLine — same checks, same error codes.
function parseGatewayLine(line) {
  if (Buffer.byteLength(line, 'utf8') > GATEWAY_MAX_LINE_BYTES) {
    return gatewayError('bad_request', 'request line exceeds ' + GATEWAY_MAX_LINE_BYTES + ' bytes');
  }
  var parsed;
  try { parsed = JSON.parse(line); } catch (e) {
    return gatewayError('bad_request', 'request is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return gatewayError('bad_request', 'request must be a JSON object');
  }
  if (parsed.v !== 1) {
    return gatewayError('unsupported_version', 'unsupported protocol version: ' + JSON.stringify(parsed.v));
  }
  if (typeof parsed.op !== 'string' || GATEWAY_OPS.indexOf(parsed.op) === -1) {
    return gatewayError('bad_request', 'unsupported op: ' + JSON.stringify(parsed.op));
  }
  if (typeof parsed.sid !== 'string' || parsed.sid.length === 0) {
    return gatewayError('bad_request', 'missing sid');
  }
  var args = {};
  if (parsed.args !== undefined) {
    if (typeof parsed.args !== 'object' || parsed.args === null || Array.isArray(parsed.args)) {
      return gatewayError('bad_request', 'args must be an object');
    }
    args = parsed.args;
  }
  return { ok: true, request: { v: 1, op: parsed.op, sid: parsed.sid, args: args } };
}

// Mirror of gateway-core.ts EXTERNAL_CALLER_SID: an env-less walnut (hand-started
// agent or the user's own terminal on this host) identifies as 'external'. It
// is a PROVENANCE label, never authorization — the owner-only socket already
// vouched for the caller, and the hub grants 'external' nothing a tracked
// session lacks.
var EXTERNAL_CALLER_SID = 'external';

// Mirror of gateway-core.ts resolveGatewayCallerSid — 'external' passes through
// (never a tracked session), everything else chases the alias chain (max 5 hops
// so a corrupt/cyclic table terminates); null = unknown_caller.
function resolveCallerSid(sid) {
  if (sid === EXTERNAL_CALLER_SID) return EXTERNAL_CALLER_SID;
  var cur = sid;
  for (var hop = 0; hop <= 5; hop++) {
    if (sessions.has(cur)) return cur;
    var next = gatewaySidAliases.get(cur);
    if (next === undefined || next === cur) return null;
    cur = next;
  }
  return null;
}

function sendGatewayRequest(capability, callerSid, payload, respond) {
  // Pick any trusted client (never the bridge adapter) — same rule as
  // cmdLaunchRelay.
  var target = null;
  for (const client of wsClients) {
    if (client.origin !== 'bridge') { target = client; break; }
  }
  if (!target) {
    return respond(gatewayError('hub_unreachable', 'no primary server connected'));
  }
  gatewayRelayCounter += 1;
  var relayId = gatewayRelayCounter;
  var timer = setTimeout(function () {
    gatewayRelayPending.delete(relayId);
    respond(gatewayError('hub_timeout', 'primary server timed out'));
  }, GATEWAY_HUB_TIMEOUT_MS);
  gatewayRelayPending.set(relayId, { respond: respond, timer: timer });
  logMsg('info', 'gateway: relaying to primary server', { relayId: relayId, capability: capability, callerSid: callerSid });
  sendEvent(target, 'gateway-request', { relayId: relayId, capability: capability, callerSid: callerSid, payload: payload });
}

// gateway-result is deliberately NOT in BRIDGE_ALLOWED_COMMANDS — only a
// trusted (SSH-tunneled) walnut client may answer a gateway relay.
function cmdGatewayResult(ws, id, cmd) {
  var relayId = cmd.relayId, result = cmd.result, error = cmd.error, errorCode = cmd.errorCode, detail = cmd.detail;
  var pending = typeof relayId === 'number' ? gatewayRelayPending.get(relayId) : undefined;
  if (!pending) {
    // Late result after timeout — ack and drop (same as cmdLaunchResult).
    return sendOk(ws, id, { stale: true });
  }
  gatewayRelayPending.delete(relayId);
  clearTimeout(pending.timer);
  if (result && !error) {
    pending.respond({ ok: true, result: result });
  } else {
    var errObj = gatewayError(errorCode || 'internal', error || 'gateway request failed');
    if (detail !== undefined) {
      errObj.error.detail = detail;
      if (detail && typeof detail.retryAfterMs === 'number') errObj.error.retryAfterMs = detail.retryAfterMs;
    }
    pending.respond(errObj);
  }
  sendOk(ws, id, {});
}

// One parsed NDJSON line from the agent socket → local reject or hub relay.
function handleGatewayLine(line, respond) {
  var parsed = parseGatewayLine(line);
  if (parsed.ok !== true) return respond(parsed);
  var req = parsed.request;
  var callerSid = resolveCallerSid(req.sid);
  if (!callerSid) {
    // Unknown sid (CLI adopted from before a daemon restart) — refuse locally,
    // the request never leaves this host. A respawn self-heals.
    return respond(gatewayError('unknown_caller', 'session is not tracked by this daemon (a respawn self-heals)'));
  }
  if (callerSid === EXTERNAL_CALLER_SID) {
    logMsg('info', 'gateway: external caller (no session env)', { op: req.op });
  }
  sendGatewayRequest(req.op, callerSid, req.args, respond);
}

// Second listener: owner-only unix socket, raw NDJSON, one request per conn.
function startGatewayListener() {
  // Unlink a stale socket from a crashed predecessor — bind fails EADDRINUSE
  // otherwise (the file outlives the process).
  try { fs.unlinkSync(GATEWAY_SOCK_PATH); } catch {}
  try {
    var server = net.createServer(function (socket) {
      // Raw chunks, decoded once (mirrors daemon-standalone.ts): per-chunk
      // decoding corrupts a multi-byte character split across a chunk boundary,
      // and re-measuring the accumulated string per chunk is O(line²) — both
      // only bite now that a line can be 10MB of base64 audio.
      var chunks = [];
      var bytes = 0;
      var done = false;
      var reply = function (resp) {
        if (done) return;
        done = true;
        chunks = [];
        try { socket.end(JSON.stringify(resp) + '\\n'); } catch {}
      };
      socket.on('data', function (chunk) {
        if (done) return;
        bytes += chunk.length;
        if (bytes > GATEWAY_MAX_LINE_BYTES) {
          return reply(gatewayError('bad_request', 'request line too large'));
        }
        // 0x0A can never be a UTF-8 continuation byte, so a raw scan is exact.
        var nl = chunk.indexOf(0x0a);
        chunks.push(nl === -1 ? chunk : chunk.subarray(0, nl));
        if (nl === -1) return;
        var line = Buffer.concat(chunks).toString('utf-8');
        chunks = [];
        handleGatewayLine(line, reply);
      });
      socket.on('error', function () { /* client went away — pending timer self-cleans */ });
    });
    server.on('error', function (err) {
      logMsg('warn', 'agent gateway listener error', { error: err.message });
    });
    server.listen(GATEWAY_SOCK_PATH, function () {
      // Owner-only IS the credential: don't rely on umask, chmod explicitly.
      try { fs.chmodSync(GATEWAY_SOCK_PATH, 0o600); } catch {}
      logMsg('info', 'agent gateway listening', { sock: GATEWAY_SOCK_PATH });
    });
  } catch (err) {
    // The gateway is additive — never fail daemon startup over it.
    logMsg('warn', 'agent gateway listener failed', { error: err.message });
  }
}

// The retired 'wn' name (fully removed 2026-08-24): shims we previously wrote
// under it are deleted at startup, recognized by their markers. Keep in sync
// with daemon-standalone.ts.
var LEGACY_WN_SHIM_MARKERS = ['walnut-wn-shim v1'];

// A 'walnut' on the user's PATH (one name everywhere). A real walnut CLI
// anywhere else on PATH always wins; otherwise the daemon gateway shim
// answers. Keep in sync with daemon-standalone.ts userWalnutShimText.
var USER_WALNUT_SHIM_MARKER = 'walnut-user-shim v1';

function userWalnutShimText() {
  return '#!/bin/sh\\n'
    + '# ' + USER_WALNUT_SHIM_MARKER + ' — installed by the Walnut session daemon. Safe to delete.\\n'
    + '# A real walnut CLI anywhere else on PATH always wins; otherwise the\\n'
    + '# daemon gateway shim answers (guide / peers / tools work on any host).\\n'
    + 'self_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\\n'
    + 'old_ifs=$IFS; IFS=:\\n'
    + 'for d in $PATH; do\\n'
    + '  [ "$d" = "$self_dir" ] && continue\\n'
    + '  [ -x "$d/walnut" ] || continue\\n'
    + '  # skip sibling copies of this shim (two installs must not exec each other)\\n'
    + '  grep -q "walnut-user-shim" "$d/walnut" 2>/dev/null && continue\\n'
    + '  IFS=$old_ifs && exec "$d/walnut" "$@"\\n'
    + 'done\\n'
    + 'IFS=$old_ifs\\n'
    + 'dir="\${WALNUT_DAEMON_DIR:-' + PROD_DAEMON_DIR + '}"\\n'
    + '[ -x "$dir/bin/walnut" ] && exec "$dir/bin/walnut" "$@"\\n'
    + 'echo "walnut: no Walnut daemon on this host ($dir/bin/walnut is missing)." >&2\\n'
    + 'exit 6\\n';
}

// PRODUCTION dir only (a test/sandbox daemon must not write the user's bin dir)
// and never clobber a foreign walnut (only an absent path or one carrying our
// marker). ~/bin is used only when it already exists. Retired 'wn' shims we
// wrote in the alias era are deleted here (marker-guarded — a foreign wn is
// left alone).
function installUserWalnutShim() {
  if (path.resolve(DAEMON_DIR) !== path.resolve(PROD_DAEMON_DIR)) return;
  var text = userWalnutShimText();
  var installed = [];
  var candidates = [
    [path.join(HOME_DIR, '.local', 'bin'), true],
    [path.join(HOME_DIR, 'bin'), false],
  ];
  for (var i = 0; i < candidates.length; i++) {
    var dir = candidates[i][0];
    var createDir = candidates[i][1];
    try {
      var legacy = path.join(dir, 'wn');
      if (fs.existsSync(legacy)) {
        var legacyBody = fs.readFileSync(legacy, 'utf-8');
        for (var m = 0; m < LEGACY_WN_SHIM_MARKERS.length; m++) {
          if (legacyBody.indexOf(LEGACY_WN_SHIM_MARKERS[m]) !== -1) { fs.unlinkSync(legacy); break; }
        }
      }
    } catch (e) { /* removal is hygiene — never fail startup over it */ }
    try {
      if (!fs.existsSync(dir)) {
        if (!createDir) continue;
        fs.mkdirSync(dir, { recursive: true });
      }
      var marker = USER_WALNUT_SHIM_MARKER;
      var target = path.join(dir, 'walnut');
      if (fs.existsSync(target)) {
        var existing = fs.readFileSync(target, 'utf-8');
        if (existing.indexOf(marker) === -1) continue;
        if (existing === text) { installed.push(target); continue; }
      }
      fs.writeFileSync(target, text, { mode: 0o755 });
      fs.chmodSync(target, 0o755);
      installed.push(target);
    } catch (e) { /* additive convenience — never fail startup over it */ }
  }
  if (installed.length > 0) logMsg('info', 'walnut on user PATH', { paths: installed });
}

// Does the stable copy at GATEWAY_SHIM_DIR need a refresh? Hand-inlined twin of
// shimCoreNeedsCopy in gateway-core.ts (this template cannot import). Size plus
// a version stamp only: the artifact is big, /tmp is not fast, and the daemon
// version is a content hash of the daemon sources.
function shimCoreNeedsCopy(srcSize, dstSize, stampedVersion, version) {
  if (srcSize === null || srcSize <= 0) return false;
  if (dstSize === null) return true;
  if (dstSize !== srcSize) return true;
  if (!stampedVersion || stampedVersion !== version) return true;
  return false;
}

// Copy the launched script next to the shim and return that path (null = could
// not). Twin of ensureShimCoreCopy in daemon-standalone.ts. The shim must exec a
// path that OUTLIVES this process: an artifact launched from a stage temp dir is
// deleted by the next deploy, and the shim then execs a path that is gone (exit
// 126 on every 'walnut' call inside a live session). DAEMON_DIR is stable, so
// the copy lives there. Temp name in the SAME dir + rename = atomic, never EXDEV.
// Cheap by construction: an artifact ALREADY inside the stable daemon dir (the
// normal source deploy: DAEMON_DIR/daemon.cjs) is used as-is and never copied,
// a matching size + version stamp skips the copy on an ordinary restart, and
// COPYFILE_FICLONE makes a same-volume copy a COW clone (a clone stays valid
// after the source is deleted, which is the whole point).
function ensureShimCoreCopy(srcPath) {
  // Already stable: the daemon dir is exactly the place the copy would go.
  if (path.resolve(path.dirname(srcPath)) === path.resolve(DAEMON_DIR)) return srcPath;
  var dst = path.join(GATEWAY_SHIM_DIR, 'walnut-core.cjs');
  var stampPath = dst + '.version';
  var tmp = dst + '.tmp-' + process.pid;
  var statSize = function (p) { try { return fs.statSync(p).size; } catch (e) { return null; } };
  try {
    var stamped = null;
    try { stamped = fs.readFileSync(stampPath, 'utf-8').trim(); } catch (e) { /* absent */ }
    if (!shimCoreNeedsCopy(statSize(srcPath), statSize(dst), stamped, DAEMON_VERSION)) {
      return fs.existsSync(dst) ? dst : null;
    }
    var startedAt = Date.now();
    fs.copyFileSync(srcPath, tmp, fs.constants.COPYFILE_FICLONE);
    fs.chmodSync(tmp, 0o700);
    fs.renameSync(tmp, dst);
    fs.writeFileSync(stampPath, DAEMON_VERSION);
    logMsg('info', 'walnut shim core copied', { path: dst, version: DAEMON_VERSION, ms: Date.now() - startedAt });
    return dst;
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (e) { /* nothing to clean */ }
    // A shim that works until the next deploy beats no shim at all — fall back
    // to the running script instead of skipping the shim.
    logMsg('warn', 'walnut shim core copy failed — shim will point at the running script', { error: err.message });
    return null;
  }
}

// Sweep GATEWAY_SHIM_DIR of core copies the freshly written shim does NOT name.
// Twin of reapShimCoreArtifacts in daemon-standalone.ts. Two kinds of debris, each
// artifact-sized and both permanent until this ran: a 'walnut-core.cjs.tmp-<pid>'
// left behind when a SIGKILL/OOM/power loss lands between copyFileSync and
// renameSync (the catch only covers a THROWN copy, and every attempt picks a fresh
// pid-suffixed name, so they accumulate), and a stable copy from an earlier deploy
// this daemon no longer execs (an artifact already in DAEMON_DIR takes the no-copy
// path forever) sitting there with its orphaned '.version' stamp. Hosts here have
// run out of disk before. Called only AFTER the shim is rewritten: nothing names
// these files then, and unlink never disturbs a process already exec'ing the inode.
function reapShimCoreArtifacts(referenced) {
  try {
    var keep = referenced.map(function (p) { return path.resolve(p); });
    var ownTmp = 'walnut-core.cjs.tmp-' + process.pid;
    var names = fs.readdirSync(GATEWAY_SHIM_DIR);
    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      if (name.indexOf('walnut-core') !== 0 || name === ownTmp) continue;
      var full = path.join(GATEWAY_SHIM_DIR, name);
      // A '.version' stamp lives and dies with the copy it stamps.
      var stamps = name.slice(-8) === '.version' ? full.slice(0, -8) : full;
      if (keep.indexOf(path.resolve(stamps)) !== -1) continue;
      try { fs.unlinkSync(full); } catch (e) { /* already gone */ }
    }
  } catch (e) { /* hygiene — never fail startup over it */ }
}

// PATH shim so walnut inside spawned sessions reaches this daemon's dispatch.
// Source-deploy branch: exec node <this daemon.cjs> walnut "$@" — the shim always
// passes the CANONICAL 'walnut' keyword now ('wn' still dispatches, for shims
// written by daemons already deployed in the field).
function writeWalnutShim() {
  try {
    fs.mkdirSync(GATEWAY_SHIM_DIR, { recursive: true, mode: 0o700 });
    var q = function (s) { return "'" + String(s).replace(/'/g, "'\\\\''") + "'"; };
    // The deployed script normally sits IN DAEMON_DIR (daemon.cjs /
    // daemon-fallback.cjs), which is stable — then ensureShimCoreCopy returns it
    // unchanged and this keeps its previous shape. Launched from anywhere else it
    // can vanish while sessions still hold the shim, so it is copied in first.
    var entry = process.argv[1] || '';
    var target = entry ? (ensureShimCoreCopy(entry) || entry) : entry;
    var shim = '#!/bin/sh\\nexec ' + q(process.execPath) + ' ' + q(target) + ' walnut "$@"\\n';
    // One name: walnut. The retired wn file is removed, not rewritten.
    var sp = path.join(GATEWAY_SHIM_DIR, 'walnut');
    fs.writeFileSync(sp, shim, { mode: 0o755 });
    fs.chmodSync(sp, 0o755);
    try { fs.unlinkSync(path.join(GATEWAY_SHIM_DIR, 'wn')); } catch (e) {}
    // The shim now names its final target — anything else in here is debris.
    reapShimCoreArtifacts([target]);
  } catch (err) {
    logMsg('warn', 'walnut shim write failed', { error: err.message });
  }
  installUserWalnutShim();
}

// ── Mobile events relay: walnut server → cloud bridge (reverse direction) ──
// The primary's mobile events feed (src/web/routes/events-v1.ts) pushes slim
// {kind, data} frames here; the daemon forwards them verbatim to the cloud
// bridge as {ev:'mobile-event', ...} so phones connected to the cloud box
// get the same live feed. Fire-and-forget: no bridge = ack-and-drop (the
// phone's snapshot frame on reconnect heals the gap). Trusted clients only —
// this case is deliberately NOT in BRIDGE_ALLOWED_COMMANDS (a compromised
// cloud box must not be able to inject fake feed events back at itself, and
// the direction is walnut → daemon → bridge, never bridge → daemon).
// Keep in sync with daemon-standalone.ts.

function cmdMobileEvent(ws, id, cmd) {
  var kind = cmd.kind, data = cmd.data;
  if (typeof kind !== 'string' || !kind) {
    return sendError(ws, id, 'mobile-event: missing kind');
  }
  if (!bridgeAdapter) {
    return sendOk(ws, id, { relayed: false });
  }
  try {
    bridgeAdapter.send(JSON.stringify({ ev: 'mobile-event', kind: kind, data: data == null ? null : data }));
  } catch {}
  sendOk(ws, id, { relayed: true });
}

// ── Start a Claude session ──
async function cmdStart(ws, id, cmd) {
  const { sid, args, cwd, message, resume, mode } = cmd;
  // message is OPTIONAL: empty/absent spawns the CLI without writing a user turn
  // to the FIFO — the process emits its init event (+ SessionStart hook, fresh
  // settings/skills/MCP load) then blocks on stdin, idle. Restart-to-reinitialize
  // path. Keep in sync with daemon-standalone.ts.
  if (!sid || !args || !cwd) {
    return sendError(ws, id, 'start: missing required fields (sid, args, cwd)');
  }

  // Replace-existing cleanup: prevents stale orphanPollTimer from the old
  // session mis-firing pid-recycled against the newborn pid.
  const existing = sessions.get(sid);
  if (existing) {
    // Live-adopt guard: resume-with-message against a STILL-RUNNING CLI means the
    // caller lost track of the process (walnut restart race, stale hasPipe) — do
    // NOT kill it mid-turn. Deliver via the live FIFO and adopt instead. Explicit
    // restart (reinitialize) sends message='' and still respawns below.
    // Keep in sync with daemon-standalone.ts.
    if (resume && message && existing.state === 'running' && existing.pid) {
      let oldAlive = false;
      try { process.kill(existing.pid, 0); oldAlive = true; } catch {}
      if (oldAlive) {
        const payload = JSON.stringify({ type: 'user', message: { role: 'user', content: message } });
        let wrote = 'fail';
        try { wrote = await chainFifoWrite(sid, existing, Buffer.from(payload + '\\n')); } catch {}
        if (wrote === 'ok') {
          if (mode) existing.mode = mode;
          // Hand out a COMPLETE-line boundary, never a raw stat().size: this
          // value becomes the client's cursor AND addSubscriber's replay start,
          // and a mid-line start fans a JSON fragment to the client (contract §4
          // boundary rule). The live watcher already publishes the boundary.
          // Keep in sync with daemon-standalone.ts.
          let curSize = 0;
          if (existing.watcher) curSize = existing.watcher.offset;
          else { try { curSize = fs.statSync(existing.jsonlPath).size; } catch {} }
          logMsg('info', 'cmdStart: adopted live session — message delivered via FIFO, respawn skipped', {
            sid, pid: existing.pid, offset: curSize,
          });
          addSubscriber(ws, sid, curSize);
          return sendOk(ws, id, { pid: existing.pid, outputFile: existing.jsonlPath, offset: curSize, adopted: true });
        }
        // EAGAIN = pipe full but process alive — refusing respawn (killing a
        // live CLI over a transient full pipe is exactly the bug this guards).
        // ENXIO/partial = reader gone / pipe corrupt → respawn is correct.
        if (wrote === 'EAGAIN') {
          logMsg('warn', 'cmdStart: live-adopt delivery failed but process alive — refusing respawn', { sid, pid: existing.pid, wrote });
          return sendError(ws, id, 'start: session ' + sid + ' is alive but FIFO delivery failed (EAGAIN); retry send');
        }
        logMsg('warn', 'cmdStart: live-adopt delivery failed — falling back to respawn', { sid, wrote });
      }
    }
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
        killProcessGroup(existing.pid, 'SIGTERM');
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

  // Record offset before spawn (for resume — only stream new data).
  // C1: on resume the fold is rebuilt from the surviving jsonl, and the watcher
  // offset comes from THAT rebuild's complete-line boundary — never a raw
  // stat().size, which can sit mid-line if the previous CLI died mid-write
  // (contract §4 "Rebuild boundary rule"). Keep in sync with daemon-standalone.ts.
  let offset = 0;
  let resumeFold = null;
  if (resume) {
    resumeFold = rebuildFoldStateFromJsonl(jsonlPath);
    offset = resumeFold.boundary;
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
  // Fresh spawn: unlink+recreate (NOT truncate) → new inode → new streamEpoch,
  // so consumers know v restarted at 0. Mirror daemon-standalone.ts.
  if (!resume) {
    try { fs.unlinkSync(jsonlPath); } catch {}
    try { fs.writeFileSync(jsonlPath, ''); } catch {}
  }
  const outputFd = fs.openSync(jsonlPath, 'a');
  const stderrFd = fs.openSync(stderrPath, resume ? 'a' : 'w');

  // Touch output file on resume so health checks see fresh mtime
  if (resume) {
    try { const now = new Date(); fs.utimesSync(jsonlPath, now, now); } catch {}
  }

  // Spawn Claude
  // CLAUDE_CODE_MAX_RETRIES: harden against upstream Bedrock degradation windows.
  // Forensics found degradation windows of 10-103 min; the CLI's default 10 API
  // retries only cover a ~3min budget, so a turn dies with "Request timed out"
  // mid-outage. The persistent-retry env (CLAUDE_CODE_UNATTENDED_RETRY) is compiled
  // OUT of external CLI builds, so we raise the finite retry ceiling instead.
  // Retries past 10 back off ~35s each, so 60 covers roughly a 30-min outage.
  // Precedence: respect an explicit process-env override; else WALNUT_CLI_MAX_RETRIES;
  // else default '60'. Keep in sync with daemon-standalone.ts.
  const cliMaxRetries =
    process.env.CLAUDE_CODE_MAX_RETRIES ?? process.env.WALNUT_CLI_MAX_RETRIES ?? '60';
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
    // CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=1: per-user-message file checkpoints,
    // which in non-interactive (print) mode exist ONLY behind this env var. Rewind's
    // file half (rewind_files control_request) is dead without it. Bounded cost:
    // hardlinked backups, 100 snapshots per session. WALNUT_DISABLE_FILE_CHECKPOINTS=1
    // opts a host out. Keep in sync with daemon-standalone.ts.
    env: {
      ...process.env,
      MCP_CONNECTION_NONBLOCKING: '1',
      CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1',
      CLAUDE_CODE_MAX_RETRIES: cliMaxRetries,
      ...(process.env.WALNUT_DISABLE_FILE_CHECKPOINTS === '1'
        ? {}
        : { CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: '1' }),
      // Agent gateway (peer sessions): the walnut CLI inside this session reads
      // these two to reach the on-host gateway socket. The sid may be a fresh
      // spawn's tmp id — gatewaySidAliases (cmdRename) resolves it to the
      // current sid on every request. PATH append puts the walnut shim on the
      // session's PATH (this twin spawns claude directly, no shell preamble).
      // Keep in sync with daemon-standalone.ts.
      WALNUT_AGENT_SOCKET: GATEWAY_SOCK_PATH,
      WALNUT_SESSION_ID: sid,
      PATH: (process.env.PATH || '') + ':' + GATEWAY_SHIM_DIR,
      // Never let OUR watchdog pid leak into the CLI's env — a CLI session that
      // runs a dev:prod deploy would hand this stale pid to the PRODUCTION
      // daemon, whose watchdog would trip and (with the isolated-dir reap) kill
      // live prod sessions. Keep in sync with daemon-standalone.ts.
      WALNUT_DAEMON_PARENT_PID: undefined,
    },
  });

  // Write initial message to FIFO — only when one was provided. Empty message =
  // "spawn idle" (restart-to-reinitialize): CLI emits init but runs no turn.
  // Keep in sync with daemon-standalone.ts.
  if (message) {
    const payload = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: message },
    });
    fs.writeSync(pipeFd, Buffer.from(payload + '\\n'));
  }
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
    // C1: fresh spawn starts an empty fold; resume streams the surviving jsonl.
    foldState: resumeFold ? resumeFold.state : initialFoldState(0),
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

/** Walnut mode id → claude --permission-mode value. Mirrors daemon-core MODE_CLI. */
var MODE_CLI = {
  bypass: 'bypassPermissions',
  accept: 'acceptEdits',
  plan: 'plan',
  default: 'default',
  auto: 'auto',
  dontAsk: 'dontAsk',
};

function shouldAutoRespond(mode, toolName) {
  // AskUserQuestion is a requiresUserInteraction tool: the CLI emits its
  // control_request even in bypassPermissions (checkPermissions always returns
  // 'ask'), and the tool echoes its 'answers' field back out of the permission
  // response's updatedInput. Auto-allowing therefore replies with NO answers, and
  // the CLI reports a fabricated "user answered your questions" (empty) result
  // to the model. Forward it to walnut so the human actually answers.
  if (toolName === 'AskUserQuestion') return false;
  if (mode === 'bypass') return true;
  if (mode === 'plan') return toolName !== 'ExitPlanMode';
  // 'auto'/'dontAsk' intentionally fall through: the CLI decides internally and
  // emits no control_request. Never auto-allow them — see daemon-core.ts.
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
    return writeFifoQuick(pipePath, buf) === 'ok';
  } catch { return false; }
}

// SYNC FIFO write for fire-and-forget callers (auto-allow control_responses,
// cron provenance injection). Those fire only when the CLI is ALIVE and
// draining stdin (it just emitted a control_request / turn line), so a short
// 500ms busy-wait budget is safe and keeps the write atomic from the caller's
// perspective. The boot-race path (user sends) uses writeFifoFullyAsync.
function writeFifoQuick(pipePath, buf) {
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

// Write a full buffer to a FIFO with O_NONBLOCK + ASYNC retry. PIPE_BUF on
// macOS is 512 bytes; a single non-blocking writeSync of a larger buffer may
// return a partial count, and stopping there leaves the pipe corrupted (CLI's
// stdin line parser will splice the truncated fragment with whatever bytes
// follow, causing JSON.parse to fail and the CLI to exit).
//
// BOOT RACE (2026-08-13 incident): a freshly-spawned CLI takes 2-7s before it
// reads stdin at all; a first-turn prompt easily exceeds the kernel pipe
// buffer, so the write stalls until the CLI starts draining. The old sync
// writer busy-blocked (Atomics.wait) for a 500ms budget then gave up mid-line,
// and the caller reaped a healthy booting process. This version awaits between
// retries and keeps the fd open across the whole attempt (closing mid-payload
// is what makes a partial unrecoverable). Keep in sync with daemon-core.ts.
//
// Returns: 'ok' (full write), 'ENXIO' (no reader / reader closed), 'EAGAIN'
// (ZERO bytes accepted within deadline — pipe intact, retriable), or 'partial'
// (prefix written but unfinished at deadline — caller MUST reap: the pipe now
// holds half a JSON line).
const FIFO_WRITE_DEADLINE_MS = 20000;
async function writeFifoFullyAsync(pipePath, buf, deadline, isAbandoned) {
  const RETRY_INTERVAL_MS = 25;
  let fd;
  try {
    fd = fs.openSync(pipePath, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
  } catch (err) {
    if (err && err.code === 'ENXIO') return 'ENXIO';
    throw err;
  }
  try {
    let offset = 0;
    while (offset < buf.length) {
      try {
        const n = fs.writeSync(fd, buf, offset, buf.length - offset);
        if (n > 0) { offset += n; continue; }
      } catch (err) {
        if (err && err.code === 'EPIPE') return 'ENXIO';
        if (!err || err.code !== 'EAGAIN') throw err;
      }
      if (Date.now() >= deadline || (isAbandoned && isAbandoned())) {
        return offset === 0 ? 'EAGAIN' : 'partial';
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_INTERVAL_MS));
    }
    return 'ok';
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
}

// Serialize FIFO writes per session — async writes yield between retries, so
// two concurrent sends could interleave partial writes and splice two half
// lines into one corrupted line. Chain each write behind the previous one.
// Returns the write outcome, or 'dead' if the session was reaped while queued.
// Keep in sync with daemon-core.ts chainFifoWrite.
async function chainFifoWrite(sid, session, buf) {
  const deadline = Date.now() + FIFO_WRITE_DEADLINE_MS;
  const prev = session.fifoWriteChain || Promise.resolve();
  const run = prev.catch(() => {}).then(async () => {
    if (session.state === 'dead' || sessions.get(sid) !== session) return 'dead';
    return writeFifoFullyAsync(session.pipePath, buf, deadline, () => session.state === 'dead');
  });
  session.fifoWriteChain = run;
  const result = await run;
  if (session.fifoWriteChain === run) session.fifoWriteChain = undefined;
  return result;
}

// ── File watching for JSONL streaming ──
//
// Watcher lifecycle is bound to the session, not to any WebSocket. A single
// poll timer per session reads the JSONL file and fans out new lines to all
// currently-subscribed ws clients. ws connects/disconnects do not affect the
// watcher.

// Idempotent: if the session already has a watcher, does nothing.
// ── Scheduled-task (CLI cron) fire detection ──
// Mirrors daemon-core.ts detectCronFires/cronFireMarkerText/stripCronTaskById
// + daemon-standalone.ts checkCronFires (template can't import; parity test
// locks the sync). A cron fire in headless mode delivers its prompt STRAIGHT
// to the model — the stream shows only a bare turn start — and the CLI's
// directory-scoped scheduler lock lets the current holder ADOPT a task whose
// creating session looks dead (upstream #50300/#66509). Detect via the
// on-disk scheduled_tasks.json: lastFiredAt recent + we hold the lock. For
// FOREIGN fires (createdBySessionId !== sid): append a scheduled_task_fire
// marker to the stream file AND inject a model-visible provenance warning
// into the FIFO. Same-session fires get only the marker.
var CRON_FIRE_RECENT_MS = 10 * 60 * 1000;
var CRON_CHECK_THROTTLE_MS = 30000;
function detectCronFires(args) {
  if (!args.tasksJson) return [];
  var lockSid;
  if (args.lockJson) {
    try { lockSid = JSON.parse(args.lockJson).sessionId; } catch {}
  }
  if (lockSid !== args.sid) return [];
  var tasks;
  try {
    var parsed = JSON.parse(args.tasksJson);
    tasks = Array.isArray(parsed && parsed.tasks) ? parsed.tasks : [];
  } catch { return []; }
  var recentMs = args.recentMs || CRON_FIRE_RECENT_MS;
  var out = [];
  for (var i = 0; i < tasks.length; i++) {
    var t = tasks[i];
    var tid = t && typeof t.id === 'string' ? t.id : null;
    var fired = t && typeof t.lastFiredAt === 'number' ? t.lastFiredAt : null;
    if (!tid || !fired) continue;
    if (args.nowMs - fired > recentMs || fired > args.nowMs + 60000) continue;
    var key = tid + ':' + fired;
    if (args.warned[key]) continue;
    args.warned[key] = args.nowMs;
    var creator = t && typeof t.createdBySessionId === 'string' ? t.createdBySessionId : undefined;
    out.push({
      taskId: tid,
      lastFiredAt: fired,
      createdBySessionId: creator,
      foreign: creator !== undefined && creator !== args.sid,
      promptPreview: t && typeof t.prompt === 'string' ? t.prompt.slice(0, 160) : '',
    });
  }
  return out;
}
// Disk-side cron interest for the idle reaper — mirrors daemon-core.ts
// hasDiskCronInterest (template can't import; parity test locks the sync).
// armed when: 'creator' (created a live task; schedules its own tasks with or
// without the lock) or 'lock_holder' (will execute/adopt the next fire).
// Live = createdAt/lastFiredAt within the CLI's 7-day cron auto-expiry.
var CRON_TASK_LIVE_MS = 7 * 24 * 60 * 60 * 1000;
function hasDiskCronInterest(args) {
  if (!args.tasksJson) return { armed: false, reason: null, liveTasks: 0 };
  var tasks;
  try {
    var parsed = JSON.parse(args.tasksJson);
    tasks = Array.isArray(parsed && parsed.tasks) ? parsed.tasks : [];
  } catch { return { armed: false, reason: null, liveTasks: 0 }; }
  var liveMs = args.liveMs || CRON_TASK_LIVE_MS;
  var live = 0;
  var createdByMe = false;
  for (var i = 0; i < tasks.length; i++) {
    var t = tasks[i];
    var createdAt = t && typeof t.createdAt === 'number' ? t.createdAt : 0;
    var lastFiredAt = t && typeof t.lastFiredAt === 'number' ? t.lastFiredAt : 0;
    var freshest = Math.max(createdAt, lastFiredAt);
    if (!freshest || args.nowMs - freshest > liveMs) continue;
    live++;
    if (t && t.createdBySessionId === args.sid) createdByMe = true;
  }
  if (live === 0) return { armed: false, reason: null, liveTasks: 0 };
  if (createdByMe) return { armed: true, reason: 'creator', liveTasks: live };
  var lockSid;
  if (args.lockJson) {
    try { lockSid = JSON.parse(args.lockJson).sessionId; } catch {}
  }
  if (lockSid === args.sid) return { armed: true, reason: 'lock_holder', liveTasks: live };
  return { armed: false, reason: null, liveTasks: live };
}

function cronFireMarkerText(f, opts) {
  if (!f.foreign) return 'Scheduled task ' + f.taskId + ' fired (created by this session).';
  // The removal claim must track what ACTUALLY happened: eviction is
  // hook-gated (cron.fire -> evict), so in the zero-hook default posture the
  // row stays on disk and WILL fire again — saying "removed" there would tell
  // the human the loop is handled when it is not.
  var base = 'Orphaned scheduled task ' + f.taskId + ' fired here — created by another session (' + f.createdBySessionId + ') that shares this directory.';
  return (opts && opts.evicted)
    ? base + ' Walnut removed it so it cannot fire again.'
    : base + ' It is still scheduled and may fire here again (enable the session-only-cron hook to auto-remove orphans, or CronDelete it).';
}
// Enforcement point 4: evict ONE orphaned cron by id. Mirrors daemon-core.ts
// stripCronTaskById (parity test locks the sync). A foreign fire proves the row
// is orphaned relative to this process — no CronDelete will ever come from here,
// so removing it is the only thing that ends the hourly hijack. Costs the
// session no turn and no context, unlike the injected warning it replaces.
function stripCronTaskById(tasksJson, taskId) {
  if (!tasksJson || !taskId) return { changed: false, text: null };
  var parsed;
  try { parsed = JSON.parse(tasksJson); } catch { return { changed: false, text: null }; }
  if (!parsed || !Array.isArray(parsed.tasks)) return { changed: false, text: null };
  var kept = parsed.tasks.filter(function (t) { return !t || t.id !== taskId; });
  if (kept.length === parsed.tasks.length) return { changed: false, text: null };
  var next = Object.assign({}, parsed, { tasks: kept });
  return { changed: true, text: JSON.stringify(next, null, 2) + '\\n' };
}
function checkCronFires(sid, session) {
  var now = Date.now();
  if (session.lastCronCheckTs && now - session.lastCronCheckTs < CRON_CHECK_THROTTLE_MS) return;
  session.lastCronCheckTs = now;
  if (!session.cwd) return;
  var base = path.join(session.cwd, '.claude');
  var tasksJson = null, lockJson = null;
  try { tasksJson = fs.readFileSync(path.join(base, 'scheduled_tasks.json'), 'utf-8'); } catch { return; }
  try { lockJson = fs.readFileSync(path.join(base, 'scheduled_tasks.lock'), 'utf-8'); } catch {}
  if (!session.cronWarned) session.cronWarned = {};
  var fires = detectCronFires({ sid: sid, tasksJson: tasksJson, lockJson: lockJson, nowMs: now, warned: session.cronWarned });
  for (var i = 0; i < fires.length; i++) {
    var fire = fires[i];
    logMsg(fire.foreign ? 'warn' : 'info', 'scheduled-task fire detected', {
      sid: sid, taskId: fire.taskId, foreign: fire.foreign,
      createdBySessionId: fire.createdBySessionId, lastFiredAt: fire.lastFiredAt,
    });
    // 1. Hook point cron.fire — evaluated BEFORE the marker so the marker can
    // report what actually happened. The interesting action is evict on a
    // FOREIGN fire: an orphaned durable cron just hijacked this session, and
    // nobody in this process will ever CronDelete it — removing the row is
    // the only thing that ends the loop. Deliberately NO model-visible
    // message here: the injected warning this replaced cost a turn + context
    // every hour and could not stop anything (a model verifiably ignored one,
    // 2026-08-11). The stream marker below tells the HUMAN.
    var evicted = false;
    var fireActions = hookActions('cron.fire', {
      foreign: fire.foreign, taskId: fire.taskId,
      createdBySessionId: fire.createdBySessionId || null, sid: sid,
    });
    if (fireActions.indexOf('log') !== -1) {
      logMsg('info', 'hook log: cron.fire', { sid: sid, taskId: fire.taskId, foreign: fire.foreign });
    }
    if (fireActions.indexOf('evict') !== -1) {
      try {
        var tasksPath = path.join(base, 'scheduled_tasks.json');
        var strip = stripCronTaskById(tasksJson, fire.taskId);
        if (strip.changed && strip.text != null) {
          var tmp = tasksPath + '.walnut-' + String(process.pid) + '.tmp';
          fs.writeFileSync(tmp, strip.text, { mode: 0o600 });
          fs.renameSync(tmp, tasksPath);
          evicted = true;
          logMsg('warn', 'hook evict: removed orphaned foreign cron', {
            sid: sid, taskId: fire.taskId, createdBySessionId: fire.createdBySessionId, tasksPath: tasksPath,
          });
        }
      } catch (err) {
        logMsg('warn', 'hook evict failed', { sid: sid, taskId: fire.taskId, error: err.message });
      }
    }
    // 2. Stream-file marker (never the canonical JSONL) — unknown system
    // subtype folds v-only (safe); session-history renders scheduled_task_fire.
    try {
      var marker = JSON.stringify({
        type: 'system',
        subtype: 'scheduled_task_fire',
        content: cronFireMarkerText(fire, { evicted: evicted }),
        cron_task_id: fire.taskId,
        cron_created_by: fire.createdBySessionId || null,
        cron_foreign: fire.foreign,
        uuid: crypto.randomUUID(),
        session_id: sid,
        timestamp: new Date(now).toISOString(),
      }) + '\\n';
      fs.appendFileSync(session.jsonlPath, marker);
    } catch (err) {
      logMsg('warn', 'scheduled-task fire: marker append failed', { sid: sid, error: err.message });
    }
  }
}

// ── Daemon hooks (declarative rules pushed from walnut) ──
// Mirrors daemon-core.ts evalDaemonHookRules/builtinSessionOnlyCronHook +
// daemon-standalone.ts hooks machinery (template can't import; parity test
// locks the sync). The daemon holds ONE compiled rules JSON received via the
// hooks.configure command and persisted to hooks.json; it is the ONLY source
// of interventions — no pushed hooks means the daemon denies nothing, evicts
// nothing, rewrites nothing. Points: cron.create (deny) / cron.created
// (inject fixed corrective text) / cron.fire (evict orphan) / session.reap
// (strip-own-rows). durable:true background: the CLI persists such a job to
// {cwd}/.claude/scheduled_tasks.json under a DIRECTORY-scoped lock, so it
// outlives its session and fires inside a stranger (2026-08-09 incident).
// Back-compat: a legacy server sets WALNUT_ENFORCE_SESSION_CRON=1 at spawn →
// synthesize the built-in rule set; WALNUT_ALLOW_DURABLE_CRON=1 kills all.
var HOOKS_FILE = path.join(DAEMON_DIR, 'hooks.json');
var daemonHooks = null;
function loadDaemonHooksAtBoot() {
  if (process.env.WALNUT_ALLOW_DURABLE_CRON === '1') return;
  try {
    var loaded = JSON.parse(fs.readFileSync(HOOKS_FILE, 'utf-8'));
    // Same shape gate as cmdHooksConfigure: a wrong-version/shape file (e.g.
    // left by a future daemon) falls through to the env fallback, not silence.
    if (loaded && loaded.version === 1 && Array.isArray(loaded.hooks)) {
      daemonHooks = loaded;
      logMsg('info', 'daemon hooks loaded from disk', { hash: loaded.hash, hooks: loaded.hooks.length });
      return;
    }
  } catch {}
  if (process.env.WALNUT_ENFORCE_SESSION_CRON === '1') {
    daemonHooks = { version: 1, hash: 'env-compat', hooks: [builtinSessionOnlyCronHook()] };
    logMsg('info', 'daemon hooks synthesized from WALNUT_ENFORCE_SESSION_CRON (legacy server)');
  }
}
function builtinSessionOnlyCronHook() {
  return {
    id: 'session-only-cron',
    enabled: true,
    rules: [
      { on: 'cron.create', when: { 'input.durable': true }, action: 'deny' },
      { on: 'cron.created', when: { 'input.durable': true }, action: 'inject' },
      { on: 'cron.fire', when: { foreign: true }, action: 'evict' },
      { on: 'session.reap', action: 'strip-own-rows' },
    ],
  };
}
function dotGet(obj, dotPath) {
  var cur = obj;
  var keys = dotPath.split('.');
  for (var i = 0; i < keys.length; i++) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[keys[i]];
  }
  return cur;
}
function evalDaemonHookRules(config, point, ctx) {
  if (!config || !Array.isArray(config.hooks)) return [];
  var out = [];
  for (var h = 0; h < config.hooks.length; h++) {
    var hook = config.hooks[h];
    if (!hook || hook.enabled === false || !Array.isArray(hook.rules)) continue;
    for (var r = 0; r < hook.rules.length; r++) {
      var rule = hook.rules[r];
      if (!rule || rule.on !== point || typeof rule.action !== 'string') continue;
      if (rule.when && typeof rule.when === 'object') {
        var matched = true;
        var entries = Object.entries(rule.when);
        for (var e = 0; e < entries.length; e++) {
          if (dotGet(ctx, entries[e][0]) !== entries[e][1]) { matched = false; break; }
        }
        if (!matched) continue;
      }
      if (out.indexOf(rule.action) === -1) out.push(rule.action);
    }
  }
  return out;
}
function hookActions(point, ctx) {
  if (process.env.WALNUT_ALLOW_DURABLE_CRON === '1') return [];
  try { return evalDaemonHookRules(daemonHooks, point, ctx); } catch { return []; }
}
function cmdHooksConfigure(ws, id, cmd) {
  var next = cmd.config;
  if (!next || next.version !== 1 || !Array.isArray(next.hooks) || typeof next.hash !== 'string') {
    return sendError(ws, id, 'hooks.configure: invalid config');
  }
  var changed = !daemonHooks || next.hash !== daemonHooks.hash;
  daemonHooks = next;
  // The kill switch gates EVALUATION (hookActions), not storage — accepting
  // the push keeps the daemon current for when the switch is lifted, but an
  // operator debugging "why is nothing enforced" needs to see the switch.
  if (process.env.WALNUT_ALLOW_DURABLE_CRON === '1') {
    logMsg('warn', 'daemon hooks stored but INERT: WALNUT_ALLOW_DURABLE_CRON=1 disables all hook evaluation', { hash: next.hash });
  }
  if (changed) {
    // Persist failure is non-fatal (rules ARE applied in memory; the next
    // connect re-pushes) but must be visible: an unwritable DAEMON_DIR means
    // enforcement silently reverts to zero-hook on the next daemon restart.
    try { fs.writeFileSync(HOOKS_FILE, JSON.stringify(next), { mode: 0o600 }); }
    catch (err) { logMsg('warn', 'daemon hooks persist failed (in-memory only)', { error: err.message }); }
    logMsg('info', 'daemon hooks configured', { hash: next.hash, hooks: next.hooks.length });
  }
  return sendOk(ws, id, { applied: true, changed: changed, hash: next.hash });
}

// skills.sync: distribute the walnut skill into this host's engine stores.
// ONE real copy in ~/.open-walnut/distributed-skills/walnut/SKILL.md
// (deliberately NOT the user's skill store ~/.open-walnut/skills/, where a
// flat SKILL.md shadows category sub-skills); ~/.claude/skills,
// ~/.agents/skills (codex + goose) and ~/.gemini/skills get walnut symlinks
// at it, each gated on that engine's home existing.
// Marker-guarded, production-dir only; migrates the v1 layout (real claude
// file + fenced codex AGENTS.md section) and the short-lived v2.0 canonical.
// Keep in sync with daemon-standalone.ts cmdSkillsSync.
var SKILL_SYNC_MARKER = 'walnut-managed v1';

function cmdSkillsSync(ws, id, cmd) {
  var NL = String.fromCharCode(10);
  var skill = typeof cmd.skill === 'string' ? cmd.skill : '';
  if (skill.indexOf(SKILL_SYNC_MARKER) === -1) {
    return sendError(ws, id, 'skills.sync: payload missing the managed marker');
  }
  if (path.resolve(DAEMON_DIR) !== path.resolve(PROD_DAEMON_DIR)) {
    return sendOk(ws, id, { applied: true, changed: false, skipped: 'non-prod' });
  }
  var wrote = [];
  var canonicalDir = path.join(HOME_DIR, '.open-walnut', 'distributed-skills', 'walnut');
  // 1. the one real copy (marker-guarded: never clobber a foreign file)
  try {
    var target = path.join(canonicalDir, 'SKILL.md');
    var existing = null;
    try { existing = fs.readFileSync(target, 'utf-8'); } catch (e) {}
    if (existing === null || existing.indexOf(SKILL_SYNC_MARKER) !== -1) {
      if (existing !== skill) {
        fs.mkdirSync(canonicalDir, { recursive: true });
        fs.writeFileSync(target, skill, { mode: 0o644 });
        wrote.push(target);
      }
    }
  } catch (err) {
    logMsg('warn', 'skills.sync: canonical write failed', { error: err.message });
  }
  // 2. engine links, by ownership: symlink already at canonical = no-op;
  // owned symlink (marker'd or dangling) = retarget; dir with our marker'd
  // SKILL.md and NOTHING else = pure v1 copy, becomes the symlink. A dir
  // holding any other entry is never deleted (user sub-skill dirs lived next
  // to the v1 file); only our SKILL.md inside it is refreshed.
  function ensureLink(skillsDir) {
    var link = path.join(skillsDir, 'walnut');
    try {
      var st = null;
      try { st = fs.lstatSync(link); } catch (e) {}
      if (st) {
        try { if (fs.realpathSync(link) === fs.realpathSync(canonicalDir)) return; } catch (e) {}
        var skillFile = path.join(link, 'SKILL.md');
        var owned = false;
        try { owned = fs.readFileSync(skillFile, 'utf-8').indexOf(SKILL_SYNC_MARKER) !== -1; } catch (e) { owned = st.isSymbolicLink(); }
        if (!owned) return;
        if (st.isDirectory()) {
          var extras = fs.readdirSync(link).filter(function (e) { return e !== 'SKILL.md'; });
          if (extras.length > 0) {
            var curSkill = fs.readFileSync(skillFile, 'utf-8');
            if (curSkill !== skill) { fs.writeFileSync(skillFile, skill, { mode: 0o644 }); wrote.push(skillFile); }
            return;
          }
        }
        fs.rmSync(link, { recursive: true, force: true });
      }
      fs.mkdirSync(skillsDir, { recursive: true });
      fs.symlinkSync(canonicalDir, link);
      wrote.push(link);
    } catch (err) {
      logMsg('warn', 'skills.sync: engine link failed', { link: link, error: err.message });
    }
  }
  ensureLink(path.join(HOME_DIR, '.claude', 'skills'));
  if (fs.existsSync(path.join(HOME_DIR, '.codex'))) ensureLink(path.join(HOME_DIR, '.agents', 'skills'));
  // goose reads ~/.agents/skills natively too, so a goose-only host gets the
  // same link. Separate guarded call, not one OR: ensureLink is idempotent.
  // opencode needs nothing (it scans ~/.claude/skills + ~/.agents/skills).
  if (fs.existsSync(path.join(HOME_DIR, '.config', 'goose')) || fs.existsSync(path.join(HOME_DIR, '.local', 'share', 'goose'))) {
    ensureLink(path.join(HOME_DIR, '.agents', 'skills'));
  }
  // gemini discovers ONLY ~/.gemini/skills (never ~/.agents or ~/.claude).
  if (fs.existsSync(path.join(HOME_DIR, '.gemini'))) ensureLink(path.join(HOME_DIR, '.gemini', 'skills'));
  // 2b. v2.0 migration: remove the marker'd SKILL.md that briefly lived in
  // the user's skill store; the dir and every other entry stay. Drop the dir
  // only when we owned the sole file in it.
  try {
    var legacyDir = path.join(HOME_DIR, '.open-walnut', 'skills', 'walnut');
    if (path.resolve(legacyDir) !== path.resolve(canonicalDir)) {
      var legacyFile = path.join(legacyDir, 'SKILL.md');
      var legacyCur = null;
      try { legacyCur = fs.readFileSync(legacyFile, 'utf-8'); } catch (e) {}
      if (legacyCur !== null && legacyCur.indexOf(SKILL_SYNC_MARKER) !== -1) {
        fs.rmSync(legacyFile, { force: true });
        wrote.push(legacyFile);
        if (fs.readdirSync(legacyDir).length === 0) fs.rmdirSync(legacyDir);
      }
    }
  } catch (err) {
    logMsg('warn', 'skills.sync: legacy canonical cleanup failed', { error: err.message });
  }
  // 3. v1 migration: drop the fenced section this daemon used to keep in
  // ~/.codex/AGENTS.md (marker-guarded; a fence-only file is removed whole)
  try {
    var agentsMd = path.join(HOME_DIR, '.codex', 'AGENTS.md');
    var cur = '';
    try { cur = fs.readFileSync(agentsMd, 'utf-8'); } catch (e) {}
    var begin = cur.indexOf('<!-- BEGIN ' + SKILL_SYNC_MARKER);
    var endMark = '<!-- END ' + SKILL_SYNC_MARKER + ' -->';
    var end = cur.indexOf(endMark);
    if (begin !== -1 && end > begin) {
      var head = cur.slice(0, begin);
      while (head.length > 0 && head.charAt(head.length - 1) === NL) head = head.slice(0, -1);
      var tail = cur.slice(end + endMark.length);
      while (tail.length > 0 && tail.charAt(0) === NL) tail = tail.slice(1);
      var nextText = head === '' ? tail : (tail === '' ? head + NL : head + NL + NL + tail);
      if (nextText.trim() === '') fs.rmSync(agentsMd, { force: true });
      else fs.writeFileSync(agentsMd, nextText, { mode: 0o644 });
      wrote.push(agentsMd);
    }
  } catch (err2) {
    logMsg('warn', 'skills.sync: AGENTS.md fence removal failed', { error: err2.message });
  }
  if (wrote.length > 0) logMsg('info', 'walnut skill distributed', { wrote: wrote });
  return sendOk(ws, id, { applied: true, changed: wrote.length > 0, wrote: wrote });
}

function durableCronDenyMessage() {
  return 'Denied by Walnut: durable scheduled tasks are not allowed in a Walnut-managed session. '
    + 'A durable cron is written to .claude/scheduled_tasks.json and the scheduler lock is scoped to the '
    + 'PROJECT DIRECTORY, so once this session ends the job is adopted and executed by whatever other session '
    + 'shares this directory — with no indication that a cron, not the user, asked for it. '
    + 'Retry the same CronCreate with durable:false (the default) to keep the job inside this session. '
    + 'If the user genuinely needs an unattended job that survives this session, use a system scheduler '
    + '(crontab / launchd) that starts its own dedicated session instead.';
}
function durableCronCorrectionMessage(taskId) {
  return '[Walnut scheduler policy — automated message, not from the user] '
    + 'You just created a DURABLE scheduled task' + (taskId ? ' (' + taskId + ')' : '') + '. '
    + 'Durable tasks persist to .claude/scheduled_tasks.json and the CLI scopes the scheduler lock to the '
    + 'project directory, so after this session ends the job fires inside an unrelated session that happens to '
    + 'share this directory, delivered as if the user had typed it. That caused a real incident here. '
    + 'Please immediately call CronDelete on that task id, then re-create the same schedule with durable:false '
    + '(session-scoped). Do not keep the durable version. Then continue what you were doing and mention the swap '
    + 'briefly in your next summary.';
}
// Enforcement point 3 (deterministic, the one that actually holds): remove the
// dying session's own durable rows. Pure — returns the text to write back, or
// text:null when nothing changes. Mirrors daemon-core.ts.
function stripDurableTasksForSession(tasksJson, sid) {
  const unchanged = { changed: false, text: null, removed: [] };
  if (!tasksJson) return unchanged;
  let parsed;
  try { parsed = JSON.parse(tasksJson); } catch { return unchanged; }
  if (!parsed || !Array.isArray(parsed.tasks)) return unchanged;
  const removed = [];
  const kept = parsed.tasks.filter(function (t) {
    if (!t || t.createdBySessionId !== sid) return true;
    removed.push(typeof t.id === 'string' ? t.id : 'unknown');
    return false;
  });
  if (removed.length === 0) return unchanged;
  const next = Object.assign({}, parsed, { tasks: kept });
  return { changed: true, text: JSON.stringify(next, null, 2) + '\\n', removed: removed };
}

// Hook point cron.created: a bypassPermissions session never emits a
// can_use_tool control_request, so the cron.create deny can't fire — the job
// is already on disk by the time the tool_use echoes in the stream. The only
// available action is inject (fixed corrective text; the model may decline,
// which is why the hook set pairs this with cron.fire evict). Once per
// tool_use id so a re-read can't nag in a loop; durableCronNudged is
// in-memory only (a respawn re-nudges, which is correct — the durable task is
// still on disk).
function checkDurableCronCreate(sid, session, line) {
  var parsed;
  try { parsed = JSON.parse(line); } catch { return; }
  if (!parsed || parsed.type !== 'assistant') return;
  var content = parsed.message && parsed.message.content;
  if (!Array.isArray(content)) return;
  for (var i = 0; i < content.length; i++) {
    var block = content[i];
    if (!block || block.type !== 'tool_use') continue;
    if (block.name !== 'CronCreate') continue;
    var actions = hookActions('cron.created', { input: block.input, mode: session.mode, sid: sid });
    if (actions.indexOf('log') !== -1) {
      logMsg('info', 'hook log: cron.created', { sid: sid, input: block.input, mode: session.mode });
    }
    if (actions.indexOf('inject') === -1) continue;
    var key = String(block.id || 'unknown');
    if (!session.durableCronNudged) session.durableCronNudged = {};
    if (session.durableCronNudged[key]) continue;
    session.durableCronNudged[key] = Date.now();
    var payload = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: durableCronCorrectionMessage(undefined) },
    });
    var ok = writeFifoRaw(session.pipePath, payload);
    logMsg(ok ? 'warn' : 'error',
      'hook inject: durable CronCreate correction ' + (ok ? 'sent' : 'FIFO write FAILED'),
      { sid: sid, toolUseId: key, mode: session.mode });
  }
}

// ── Turn-error auto-retry ──
// Mirrors daemon-core.ts (classifyTurnError / parseTurnErrorLine /
// resolveTurnRetryConfig / decideTurnRetry / applyTurnRetry /
// clearTurnRetryStreak / turnRetryMessage / turnRetryMarkerText /
// turnRetryGiveUpText) + daemon-standalone.ts checkTurnRetry/fireTurnRetry.
// Template can't import; the parity test locks the sync.
//
// A turn killed by a TRANSIENT upstream failure (timeout, stalled stream,
// mid-response 5xx) leaves a healthy, resumable session with an unfinished
// turn. The daemon resumes it for up to a configured budget (default 12h) so an
// unattended overnight run survives an outage window without a human typing
// "continue" — and it works while the Mac is asleep or the tunnel is down,
// which is why this lives in the daemon and not on the Mac.
//
// SAFETY: the classifier is an ALLOWLIST. Unrecognized errors are TERMINAL, and
// terminal patterns are checked FIRST, so a model refusal ("can't help with
// this") can never start a 12h loop re-asking the same refused question.
var RETRYABLE_TURN_ERROR_PATTERNS = [
  /operation timed out/i,
  /request timed out/i,
  /\\bapi_timeout\\b/i,
  /server error mid-response/i,
  /stream idle timeout/i,
  /no chunks received/i,
  /response stalled mid-stream/i,
  /unexpected error during processing/i,
  /\\b(?:429|500|502|503|504|529)\\b/,
  /too many requests/i,
  /rate limit/i,
  /overloaded/i,
  /service unavailable/i,
  /bad gateway/i,
  /gateway timeout/i,
  /internal server error/i,
  /connection (?:error|reset|closed|refused)/i,
  /socket hang up/i,
  /\\bECONNRESET\\b|\\bETIMEDOUT\\b|\\bECONNREFUSED\\b|\\bEPIPE\\b|\\bEAI_AGAIN\\b|\\bENOTFOUND\\b/,
  /fetch failed/i,
  /network error/i,
  /premature close/i,
  /terminated/i,
];
var TERMINAL_TURN_ERROR_PATTERNS = [
  /can'?t help with this/i,
  /start a new session/i,
  /\\brefus(?:al|ed|es)\\b/i,
  /\\bstop_reason["\\s:]*['"]?refusal/i,
  /prompt too long/i,
  /context (?:window|length) (?:exceeded|too long)/i,
  /exceeds? the maximum/i,
  /too many tokens/i,
  /invalid[_\\s-]?request/i,
  /\\b400\\b/,
  /\\b401\\b|\\b403\\b/,
  /unauthorized|forbidden|authentication|credential|expired token|invalid api key/i,
  /quota exceeded|insufficient (?:quota|funds|credit)|bil{2}ing/i,
  /permission denied/i,
  /not\\s+found:\\s*model|model .* (?:not found|does not exist|unavailable in)/i,
  /aborted by user|user (?:aborted|cancell?ed|interrupted)|request cancell?ed/i,
  /\\bECANCELED\\b/,
];
function classifyTurnError(text) {
  if (!text) return 'terminal';
  for (var i = 0; i < TERMINAL_TURN_ERROR_PATTERNS.length; i++) {
    if (TERMINAL_TURN_ERROR_PATTERNS[i].test(text)) return 'terminal';
  }
  for (var j = 0; j < RETRYABLE_TURN_ERROR_PATTERNS.length; j++) {
    if (RETRYABLE_TURN_ERROR_PATTERNS[j].test(text)) return 'retryable';
  }
  return 'terminal';
}
// NOTE: the gate CANNOT be on subtype — a real timeout result carries
// "subtype":"success" alongside "is_error":true. is_error is the only signal.
function parseTurnErrorLine(line) {
  if (line.indexOf('"type":"result"') === -1 || line.indexOf('"is_error":true') === -1) {
    return { isTurnError: false, text: null };
  }
  var parsed;
  try { parsed = JSON.parse(line); } catch { return { isTurnError: false, text: null }; }
  if (!parsed || parsed.type !== 'result' || parsed.is_error !== true) {
    return { isTurnError: false, text: null };
  }
  return { isTurnError: true, text: typeof parsed.result === 'string' ? parsed.result : null };
}
function resolveTurnRetryConfig(env) {
  function num(raw, def, min, max) {
    var n = raw != null && raw !== '' ? Number(raw) : def;
    if (!isFinite(n)) return def;
    return Math.max(min, Math.min(max, Math.trunc(n)));
  }
  return {
    enabled: env.WALNUT_TURN_RETRY === '1',
    budgetMs: num(env.WALNUT_TURN_RETRY_BUDGET_MS, 12 * 3600000, 0, 7 * 86400000),
    maxAttempts: num(env.WALNUT_TURN_RETRY_MAX_ATTEMPTS, 200, 0, 10000),
    backoffBaseMs: num(env.WALNUT_TURN_RETRY_BACKOFF_MS, 30000, 1000, 3600000),
    backoffMaxMs: num(env.WALNUT_TURN_RETRY_BACKOFF_MAX_MS, 600000, 1000, 3600000),
  };
}
var TURN_RETRY_CFG = resolveTurnRetryConfig(process.env);
function newTurnRetryState() {
  return { attempts: 0, streakStartedAt: null, lastAttemptAt: null, lastHandledV: null };
}
// Budget is anchored on the streak START, not per attempt — re-anchoring each
// attempt would make the budget unbounded.
function decideTurnRetry(args) {
  var state = args.state, cfg = args.cfg, nowMs = args.nowMs;
  if (!cfg.enabled) return { retry: false, reason: 'disabled' };
  if (args.v != null && state.lastHandledV != null && args.v <= state.lastHandledV) {
    return { retry: false, reason: 'duplicate-line' };
  }
  if (classifyTurnError(args.errorText) === 'terminal') return { retry: false, reason: 'terminal' };
  if (cfg.maxAttempts <= 0) return { retry: false, reason: 'attempts-exhausted' };
  var streakStart = state.streakStartedAt != null ? state.streakStartedAt : nowMs;
  var elapsedMs = nowMs - streakStart;
  if (cfg.budgetMs <= 0 || elapsedMs >= cfg.budgetMs) return { retry: false, reason: 'budget-exhausted' };
  if (state.attempts >= cfg.maxAttempts) return { retry: false, reason: 'attempts-exhausted' };
  var raw = cfg.backoffBaseMs * Math.pow(2, state.attempts);
  var delayMs = Math.min(cfg.backoffMaxMs, isFinite(raw) ? raw : cfg.backoffMaxMs);
  return { retry: true, attempt: state.attempts + 1, delayMs: delayMs, elapsedMs: elapsedMs };
}
function applyTurnRetry(state, nowMs, v) {
  state.streakStartedAt = state.streakStartedAt != null ? state.streakStartedAt : nowMs;
  state.attempts += 1;
  state.lastAttemptAt = nowMs;
  if (v != null) state.lastHandledV = v;
}
function clearTurnRetryStreak(state) {
  if (state.attempts === 0 && state.streakStartedAt == null) return false;
  state.attempts = 0;
  state.streakStartedAt = null;
  state.lastAttemptAt = null;
  return true;
}
function turnRetryMessage(attempt, errorText) {
  var what = errorText ? String(errorText).replace(/\\s+/g, ' ').trim().slice(0, 200) : 'an upstream API error';
  return '[Walnut auto-retry — automated message, not from the user] '
    + 'The previous turn was interrupted by a transient upstream failure (' + what + ') '
    + 'and did not finish. This is retry attempt ' + attempt + '. '
    + 'Please continue exactly where you left off. Do not restart the task from the beginning, '
    + 'and do not re-run work you already completed — check what you had already done first.';
}
function turnRetryMarkerText(a) {
  var wait = a.delayMs < 60000
    ? Math.round(a.delayMs / 1000) + 's'
    : Math.round(a.delayMs / 60000) + 'min';
  return 'Turn failed (' + (a.errorText || 'upstream error') + '). Walnut is auto-retrying in ' + wait
    + ' — attempt ' + a.attempt + ', ' + Math.round(a.elapsedMs / 60000) + 'min into the '
    + Math.round(a.budgetMs / 3600000) + 'h retry budget.';
}
function turnRetryGiveUpText(reason, errorText) {
  var why = reason === 'budget-exhausted' ? 'the retry budget is spent'
    : reason === 'attempts-exhausted' ? 'the retry attempt cap is reached'
    : 'the error is not retryable';
  return 'Turn failed (' + (errorText || 'upstream error') + ') and Walnut stopped auto-retrying because '
    + why + '. Send a message to resume this session manually.';
}
function appendSystemMarker(sid, session, subtype, content) {
  try {
    var marker = JSON.stringify({
      type: 'system', subtype: subtype, content: content,
      uuid: crypto.randomUUID(), session_id: sid,
      timestamp: new Date().toISOString(),
    }) + '\\n';
    fs.appendFileSync(session.jsonlPath, marker);
  } catch (err) {
    logMsg('warn', 'system marker append failed', { sid: sid, subtype: subtype, error: err.message });
  }
}
function checkTurnRetry(sid, session, line, v) {
  if (!TURN_RETRY_CFG.enabled) return;
  var parsedErr = parseTurnErrorLine(line);
  if (!parsedErr.isTurnError) {
    // A clean turn ends the streak, so the budget bounds ONE outage.
    if (line.indexOf('"type":"result"') !== -1 && session.turnRetry) {
      if (clearTurnRetryStreak(session.turnRetry)) {
        logMsg('info', 'turn-retry streak cleared by a successful turn', { sid: sid });
        persistRegistry();
      }
    }
    return;
  }
  if (!session.turnRetry) session.turnRetry = newTurnRetryState();
  var now = Date.now();
  var decision = decideTurnRetry({
    errorText: parsedErr.text, state: session.turnRetry, cfg: TURN_RETRY_CFG, nowMs: now, v: v,
  });
  if (!decision.retry) {
    if (decision.reason === 'duplicate-line') return;
    logMsg('warn', 'turn-retry declined', {
      sid: sid, reason: decision.reason, errorText: parsedErr.text,
      attempts: session.turnRetry.attempts,
    });
    if (decision.reason !== 'terminal' || session.turnRetry.attempts > 0) {
      appendSystemMarker(sid, session, 'turn_retry_stopped',
        turnRetryGiveUpText(decision.reason, parsedErr.text));
    }
    return;
  }
  applyTurnRetry(session.turnRetry, now, v);
  persistRegistry();
  logMsg('warn', 'turn-retry scheduled', {
    sid: sid, attempt: decision.attempt, delayMs: decision.delayMs,
    elapsedMs: decision.elapsedMs, budgetMs: TURN_RETRY_CFG.budgetMs, errorText: parsedErr.text,
  });
  appendSystemMarker(sid, session, 'turn_retry', turnRetryMarkerText({
    attempt: decision.attempt, delayMs: decision.delayMs, errorText: parsedErr.text,
    budgetMs: TURN_RETRY_CFG.budgetMs, elapsedMs: decision.elapsedMs,
  }));
  if (session.turnRetryTimer) { clearTimeout(session.turnRetryTimer); session.turnRetryTimer = null; }
  var attempt = decision.attempt;
  var errText = parsedErr.text;
  session.turnRetryTimer = setTimeout(function () {
    session.turnRetryTimer = null;
    try { fireTurnRetry(sid, attempt, errText); } catch (err) {
      logMsg('error', 'turn-retry fire threw', { sid: sid, error: err.message });
    }
  }, decision.delayMs);
}
// Re-resolve the session from the map: across a 10-min backoff the entry can be
// reaped and REPLACED, and nudging a stale object writes to a dead FIFO.
function fireTurnRetry(sid, attempt, errorText) {
  var session = sessions.get(sid);
  if (!session) {
    logMsg('info', 'turn-retry aborted — session gone', { sid: sid, attempt: attempt });
    return;
  }
  var message = turnRetryMessage(attempt, errorText);
  if (session.state === 'running' && session.pid) {
    var alive = true;
    try { process.kill(session.pid, 0); } catch { alive = false; }
    if (alive) {
      var payload = JSON.stringify({ type: 'user', message: { role: 'user', content: message } });
      var ok = writeFifoRaw(session.pipePath, payload);
      logMsg(ok ? 'info' : 'error',
        'turn-retry ' + (ok ? 'injected via FIFO' : 'FIFO write FAILED'),
        { sid: sid, attempt: attempt });
      if (ok) return;
    }
  }
  logMsg('info', 'turn-retry resuming dead session', { sid: sid, attempt: attempt });
  cmdBridgeResume(RETRY_WS_SINK, 0, { cmd: 'bridgeResume', sid: sid, message: message });
}
// A retry is daemon-initiated, so there's no client socket to answer on. Drop
// the reply but still surface failures — a silent drop would hide a broken
// resume for 12 hours.
var RETRY_WS_SINK = {
  readyState: 1,
  send: function (raw) {
    try {
      var parsed = JSON.parse(raw);
      if (parsed && parsed.error) {
        logMsg('error', 'turn-retry resume returned an error', { error: parsed.error });
      }
    } catch { /* non-JSON reply */ }
    return 1;
  },
  close: function () {},
};
function cancelTurnRetry(sid, reason) {
  var session = sessions.get(sid);
  if (!session || !session.turnRetryTimer) return;
  clearTimeout(session.turnRetryTimer);
  session.turnRetryTimer = null;
  logMsg('info', 'turn-retry canceled', { sid: sid, reason: reason });
}

function ensureWatcher(sid) {
  const session = sessions.get(sid);
  if (!session) return;
  if (session.watcher) return; // already running
  if (session.state !== 'running') return;

  let offset = session.offset || 0;
  // ── Torn-tail carry (contract §4 "Feed", adjudicated 2026-08-05) ──
  // A poll can land MID-LINE (the CLI appends a >64KB whale tool_result while we
  // read, so stat.size cuts the line in half). Such a fragment must NEVER be
  // processed — not folded, not fanned out:
  //   * fold: two unparseable fragments each advance foldState.v past the real
  //     line end, and the v > foldState.v guard then skips the COMPLETE line
  //     forever → a torn result/idle wedges the snapshot at turnActive=true.
  //   * fan-out (pre-existing bug this also fixes): the client received half a
  //     JSON line, failed to parse it, then received the whole line again.
  // So the fragment waits in carry (BYTES — a UTF-8 char split across polls must
  // not be decoded twice) until its newline arrives.
  //
  // Offset semantics: offset is the READ cursor (every byte read, incl. the
  // carry). carryStartV is the absolute offset of the carry's first byte, i.e.
  // the last COMPLETE-line boundary, and satisfies
  // carryStartV + carryLen === offset at all times. We publish
  // watcher.offset = carryStartV, not the read cursor, so replay/attach never
  // hand a client a mid-line boundary and stopSessionWatcher persists a complete
  // line boundary — a rebuilt watcher re-reads the torn region from there, so
  // the carry is pure memory and nothing is lost when it dies.
  //
  // The carry is a PART LIST, not one Buffer (C26): a whale line arrives across
  // many polls, and concatenating (carry + new bytes) then searching for a
  // newline from byte 0 every tick re-copied and re-scanned the same megabytes
  // (quadratic). Instead: no newline in the NEW bytes ⇒ nothing can be
  // completed, so just append to the list; concat once, and start the newline
  // search at carryLen (the carry holds no newline by invariant), only when a
  // newline actually appears.
  // Keep in sync with daemon-standalone.ts.
  let carryParts = [];
  let carryLen = 0;
  let carryStartV = offset;
  // Set after a carry-overflow drop: the remainder of the oversized line is
  // still coming, so skip everything up to and including its newline.
  let discardThroughNextNewline = false;
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
      // The read cursor advances past ALL read bytes, including the torn tail we
      // are about to park in the carry (the carry is memory-only, see above).
      offset = stat.size;

      // Assemble COMPLETE lines only. L1 versioned events: v = end-of-line byte
      // offset in the append-only jsonl (monotonic per session, identical live
      // vs replay). Computed from absolute file positions (carryStartV), so
      // parking a fragment in the carry across polls changes no line's v.
      // Keep in sync with daemon-standalone.ts.
      const batch = [];
      // C26 fast path: if the NEW bytes hold no newline, no line can complete —
      // so skip the concat + full rescan entirely.
      if (buf.indexOf(10) === -1) {
        if (discardThroughNextNewline) {
          // Still inside an over-cap line: these bytes can never complete a line
          // and re-buffering them would just re-trip the cap. Drop them and keep
          // the carryStartV + carryLen === offset invariant.
          carryStartV = offset;
        } else {
          carryParts.push(buf);
          carryLen += buf.length;
        }
      } else {
        // A newline arrived. Concat once; the carry itself holds no newline (that
        // is why it was carried), so the first search may start at carryLen.
        const chunk = carryLen ? Buffer.concat(carryParts.concat([buf]), carryLen + buf.length) : buf;
        let searchFrom = carryLen;
        let lineEnd = carryStartV;
        let cut = 0;
        for (;;) {
          const nl = chunk.indexOf(10, searchFrom); // newline byte
          if (nl === -1) break;
          lineEnd += (nl - cut) + 1;
          const line = chunk.subarray(cut, nl).toString('utf-8');
          // A discarded whale (carry overflow below) ends at this newline: v is
          // now realigned, so resume normal processing with the NEXT line.
          if (discardThroughNextNewline) discardThroughNextNewline = false;
          else batch.push({ line, v: lineEnd });
          cut = nl + 1;
          searchFrom = cut;
        }
        // Copy the torn tail — chunk may alias buf, which the next tick reuses.
        const tail = Buffer.from(chunk.subarray(cut));
        carryParts = tail.length ? [tail] : [];
        carryLen = tail.length;
        carryStartV = lineEnd;
      }
      if (carryLen > TAILER_CARRY_MAX) {
        // A single line larger than the cap can't be assembled. Drop it and
        // realign on the next newline; carryStartV stays absolute so every later
        // line keeps its true v.
        logMsg('error', 'tailer carry overflow — dropping oversized partial line', {
          sid, carryBytes: carryLen, cap: TAILER_CARRY_MAX, offset,
        });
        carryStartV = offset;
        carryParts = [];
        carryLen = 0;
        discardThroughNextNewline = true;
      }
      // Publish the last COMPLETE-line boundary (not the read cursor) so
      // replay/attach never hand a client a mid-line offset.
      if (s.watcher) s.watcher.offset = carryStartV;

      for (const entry of batch) {
        const line = entry.line, v = entry.v;
        if (!line.trim()) continue;

        // ── C1: incremental snapshot fold — EVERY complete line, BEFORE any
        // intercept continues past fan-out. The v > foldState.v guard dedupes
        // bytes already folded out-of-band (appendUserMarker's optimistic
        // overlay, watcher-heal overlap re-reads). Keep in sync with
        // daemon-standalone.ts.
        if (v > s.foldState.v) s.foldState = foldLine(s.foldState, line, v);

        // ── Latency instrumentation: time from CLI spawn to first init line ──
        // Pure CLI cold-start (incl. MCP connect) as seen by the daemon,
        // directly comparable to running claude by hand. Logged once per session.
        if (!s.sawInit && line.includes('"type":"system"') && line.includes('"init"')) {
          s.sawInit = true;
          logMsg('info', 'first init line from CLI', {
            sid, spawnToInitMs: s.spawnTs ? Date.now() - s.spawnTs : null,
          });
        }

        // ── TTFT instrumentation (inc-1786665503510): send → first output ──
        // Anchored by handleSendCommand (ttftSendTs). Keep in sync with
        // daemon-standalone.ts (see there for the attribution rationale).
        if (s.ttftSendTs && line.includes('"type":"stream_event"')) {
          if (!s.ttftSawFirstLine) {
            s.ttftSawFirstLine = true;
            logMsg('info', 'ttft: first stream_event after send', {
              sid, sendToFirstLineMs: Date.now() - s.ttftSendTs,
            });
          }
          if (line.includes('"text_delta"')) {
            logMsg('info', 'ttft: first text_delta after send', {
              sid, sendToFirstTextMs: Date.now() - s.ttftSendTs,
            });
            s.ttftSendTs = null; // one-shot: only the FIRST text of the turn
          }
        }

        // ── Scheduled-task fire detection (see checkCronFires) ──
        // A cron fire's ONLY stream evidence is a bare turn start (init +
        // session_state_changed{running}, no user line). 30s throttle inside.
        // Keep in sync with daemon-standalone.ts.
        if (line.includes('"init"') || line.includes('"session_state_changed"')) {
          try { checkCronFires(sid, s); } catch {}
        }

        // ── Durable-cron invariant, corrective half (see checkDurableCronCreate) ──
        if (line.includes('CronCreate')) {
          try { checkDurableCronCreate(sid, s, line); } catch {}
        }

        // ── Turn-error auto-retry (see checkTurnRetry) ──
        // Clean results come through too: a successful turn is what clears the
        // failure streak. Keep in sync with daemon-standalone.ts.
        if (line.includes('"type":"result"')) {
          s.ttftSendTs = null; // turn over — a stale TTFT anchor must not leak into replays
          try { checkTurnRetry(sid, s, line, v); } catch (err) {
            logMsg('warn', 'turn-retry check threw', { sid, error: err.message });
          }
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
        if (line.includes('"control_request"') || line.includes('"control_response"')
          || line.includes('"control_cancel_request"')) {
          try {
            const parsed = JSON.parse(line);
            if (parsed.type === 'control_request' && parsed.request_id
              && parsed.request && parsed.request.subtype === 'can_use_tool') {
              const toolName = parsed.request.tool_name;
              // ── Hook point cron.create (see checkDurableCronCreate) ──
              // Evaluated BEFORE the auto-allow check: a bypass-mode session
              // would otherwise be waved through, and a durable job outlives
              // this session to fire inside a stranger sharing the directory.
              if (toolName === 'CronCreate') {
                const cronActions = hookActions('cron.create', { input: parsed.request.input, mode: s.mode, sid: sid });
                if (cronActions.indexOf('log') !== -1) {
                  logMsg('info', 'hook log: cron.create', { sid, input: parsed.request.input, mode: s.mode });
                }
                if (cronActions.indexOf('deny') !== -1) {
                  const denyResp = buildControlResponse(parsed.request_id, parsed.request, false, durableCronDenyMessage());
                  if (writeFifoRaw(s.pipePath, denyResp)) {
                    s.pendingCtrl = null;
                    try { persistRegistry(); } catch {}
                    logMsg('warn', 'hook deny: durable CronCreate refused (session-scoped crons only)', { sid, mode: s.mode });
                    continue;
                  }
                  // Deliberate fall-through: a failed deny write proceeds to
                  // shouldAutoRespond (a bypass session then auto-allows the
                  // durable cron). Blocking the turn forever would be worse —
                  // cron.fire evict + session.reap strip still cover the row.
                  logMsg('error', 'hook deny: response could not be written to FIFO', { sid });
                }
              }
              if (shouldAutoRespond(s.mode, toolName)) {
                const resp = buildControlResponse(parsed.request_id, parsed.request, true);
                if (writeFifoRaw(s.pipePath, resp)) {
                  s.pendingCtrl = null;
                  try { persistRegistry(); } catch {}
                  logMsg('info', 'auto-allowed control_request', { sid, tool: toolName, mode: s.mode });
                  continue;
                }
              }
              s.pendingCtrl = { reqId: parsed.request_id, toolName: toolName || 'unknown', request: parsed.request, receivedAt: Date.now() };
              try { persistRegistry(); } catch {}
            } else if (parsed.type === 'control_response' && s.pendingCtrl) {
              if (parsed.response && parsed.response.request_id === s.pendingCtrl.reqId) {
                s.pendingCtrl = null;
                try { persistRegistry(); } catch {}
              }
            } else if (parsed.type === 'control_cancel_request' && s.pendingCtrl) {
              // CLI withdrew the request (turn aborted / restart). Without this
              // branch pendingCtrl stays set forever -> snapshot waiting=true and
              // the UI shows a permanent Waiting badge (incident a172ce49).
              if (parsed.request_id === s.pendingCtrl.reqId) {
                s.pendingCtrl = null;
                try { persistRegistry(); } catch {}
                logMsg('info', 'control_cancel_request cleared pendingCtrl', { sid: sid, requestId: parsed.request_id });
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
      // ── C1: after each tailer batch, push the snapshot if it changed (also
      // covers pendingCtrl set/clear — both happen inside this loop).
      pushSnapshot(sid, false);
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
        logMsg('error', 'watcher stalled — forcing rebuild', { sid, offset, carryStartV, consecutiveErrors });
        // Persist the last COMPLETE-line boundary (NOT the read cursor), tear
        // down, recreate. The in-memory carry dies with this watcher, so the
        // rebuilt one must re-read the torn region — resuming at offset would
        // swallow the fragment's first half. Append-only file, client v-dedup
        // absorbs overlap. Keep in sync with daemon-standalone.ts.
        s.offset = carryStartV;
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
        // Prefix match: '"control_request"' misses control_request_progress
        // (heartbeats for in-flight side_question requests, inc-1786165723472)
        // and any future control_* variant — the whole family is plumbing.
        // Keep in sync with daemon-standalone.ts addSubscriber (CLAUDE.md).
        if (line.includes('"type":"control_')) continue;
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

    // Watcher starts at the fold rebuild's COMPLETE-line boundary — same rule as
    // adopt. Catch-up for [fromOffset, end) is addSubscriber's job. Using the
    // client's fromOffset is wrong both ways: 0 re-fans the whole file;
    // MAX_SAFE_INTEGER (future-only sentinel) freezes the watcher forever. And a
    // raw stat().size would sit mid-line whenever the CLI is writing during
    // attach (contract §4 boundary rule).
    // Keep in sync with daemon-standalone.ts (CLAUDE.md).
    const discovered = rebuildFoldStateFromJsonl(jsonlPath); // C1

    session = {
      proc: null,
      pipePath,
      jsonlPath,
      pgidPath,
      pid,
      offset: discovered.boundary,
      taskState: rebuildTaskStateFromJsonl(jsonlPath, Date.now()),
      foldState: discovered.state,
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
async function cmdSend(ws, id, cmd) {
  const { sid, message } = cmd;
  if (!sid || !message) return sendError(ws, id, 'send: missing sid or message');

  // A real send means someone is driving this session now — drop any pending
  // auto-retry so we never inject behind them. The retry's own delivery does
  // NOT come through here, so this can't cancel itself.
  cancelTurnRetry(sid, 'superseded-by-send');

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
    const result = await chainFifoWrite(sid, session, buf);
    if (result === 'ok') {
      sendOk(ws, id, { ok: true });
    } else if (result === 'dead') {
      // Reaped while queued/retrying — reaper already ran, just report it.
      sendOk(ws, id, { ok: false, reason: 'session_dead', exitCode: session.exitCode });
    } else if (result === 'ENXIO') {
      reapSession(sid, -1, 'send-enxio');
      sendOk(ws, id, { ok: false, reason: 'ENXIO', exitCode: session.exitCode });
    } else if (result === 'EAGAIN') {
      // Zero bytes accepted within the deadline: pipe full but INTACT — a
      // booting CLI gets another chance on retry instead of being reaped.
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
async function cmdSendRaw(ws, id, cmd) {
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
    const result = await chainFifoWrite(sid, session, buf);
    if (result === 'ok') {
      if (session.pendingCtrl) {
        try {
          const parsed = JSON.parse(raw.trim());
          if (parsed.type === 'control_response' && parsed.response
              && parsed.response.request_id === session.pendingCtrl.reqId) {
            const requestId = session.pendingCtrl.reqId;
            session.pendingCtrl = null;
            try { persistRegistry(); } catch {}
            logMsg('info', 'sendRaw cleared pending control_response', { sid: sid, requestId: requestId });
            pushSnapshot(sid, false); // C1: waiting resolves
          }
        } catch {}
      }
      sendOk(ws, id, { ok: true });
    } else if (result === 'dead') {
      sendOk(ws, id, { ok: false, reason: 'session_dead', exitCode: session.exitCode });
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
    // C1 (contract §4 "Feed"): fold the marker immediately as a pure OPTIMISTIC
    // OVERLAY — at the CURRENT foldState.v, with NO v advance. The daemon knows
    // the turn started before the CLI echoes anything, and the tailer re-folds
    // the same marker later at its TRUE v (a double-fold is a safe re-anchor).
    // Do NOT use the post-append size as the marker's lineEndV: the CLI appends concurrently,
    // so a line can land between appendFileSync and statSync (executed repro) —
    // an inflated v would make the tailer's v > foldState.v guard skip that
    // raced result/idle forever. No gap catch-up either: with no v advance there
    // is no gap. Keep in sync with daemon-core.ts handleAppendUserMarker.
    try {
      const rawLine = line.slice(0, -1);
      session.foldState = foldLine(session.foldState, rawLine, session.foldState.v);
      pushSnapshot(sid, false);
    } catch {}
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
    if (writeFifoRaw(session.pipePath, resp)) {
      logMsg('info', 'setMode: auto-allowed pending control_request', { sid, tool: session.pendingCtrl.toolName, mode });
      session.pendingCtrl = null;
      pushSnapshot(sid, false); // C1: pendingCtrl cleared → waiting resolves
    } else {
      logMsg('warn', 'setMode: failed to write pending control_response', { sid, tool: session.pendingCtrl.toolName, mode });
    }
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

  // An explicit stop is a human decision — never undone by a pending auto-retry
  // respawning the CLI minutes later. Cancel the timer AND clear the streak so
  // an in-flight result line can't re-arm one either.
  cancelTurnRetry(sid, 'session-stopped');
  if (session.turnRetry) clearTurnRetryStreak(session.turnRetry);

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
      // The reaper's OWN keep-alive verdict, with its source.
      protection: deriveSessionProtection(session, sid, Date.now()),
      // C1: assembled on demand — the PULL half of snapshot flow.
      snapshot: assembleSessionSnapshot(session),
    });
  }
  const jsonlPath = path.join(STREAMS_DIR, sid + '.jsonl');
  if (!fs.existsSync(jsonlPath)) return sendOk(ws, id, { exists: false });
  const taskState = rebuildTaskStateFromJsonl(jsonlPath, Date.now());
  // C1: disk-rebuild snapshot — no live process backs this sid → dead. Epoch
  // stamped from disk so pull-reconcile detects a recreated file (019a7fe5).
  let diskEpoch = null;
  try {
    const st = fs.statSync(jsonlPath);
    diskEpoch = st.dev + ':' + st.ino + ':' + Math.floor(st.birthtimeMs);
  } catch {}
  const snapshot = assembleSnapshot({
    foldState: rebuildFoldStateFromJsonl(jsonlPath).state,
    pendingCtrl: null,
    dead: true,
    pid: null,
    exitCode: null,
    streamEpoch: diskEpoch,
  });
  return sendOk(ws, id, { exists: true, alive: false, state: 'dead', taskState, snapshot });
}

// ── Rename session files ──
function cmdRename(ws, id, cmd) {
  const { oldSid, newSid } = cmd;
  if (!oldSid || !newSid) return sendError(ws, id, 'rename: missing oldSid or newSid');
  if (oldSid === newSid) return sendOk(ws, id, { renamed: true });

  const session = sessions.get(oldSid);
  if (!session) return sendError(ws, id, 'rename: session not found: ' + oldSid);

  // Derive from the session's ACTUAL file location, not STREAMS_DIR — a live
  // pre-move session's family is still in the legacy dir. Mirror daemon-standalone.ts.
  const liveDir = path.dirname(session.jsonlPath);
  const oldBase = path.join(liveDir, oldSid);
  const newBase = path.join(liveDir, newSid);

  // C14: flush a pending coalesced snapshot BEFORE the re-key. pushSnapshot's
  // 50ms timer carries a generation guard (sessions.get(sid) !== session) that is
  // keyed on the OLD sid — after the delete/set below it can never match, so the
  // queued state change would be silently dropped and walnut would only learn
  // about it on the next 30s pull. Flush at the old sid (that is the sid walnut's
  // subscribers know right now) and clear the timer.
  // Keep in sync with daemon-standalone.ts cmdRename.
  if (session.snapshotTimer) {
    try { pushSnapshot(oldSid, true); } catch {}
    if (session.snapshotTimer) { clearTimeout(session.snapshotTimer); session.snapshotTimer = null; }
  }

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
    // Agent gateway: the CLI's WALNUT_SESSION_ID env still carries the OLD sid
    // (env is frozen at spawn). Record the alias so resolveCallerSid can chase
    // the chain to the current sid. Keep in sync with daemon-standalone.ts.
    gatewaySidAliases.set(oldSid, newSid);

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
    // Regular files ONLY, checked BEFORE open: open() on a FIFO with no writer
    // blocks forever (2026-08-15: wedged every local fs RPC for hours).
    const st = await fs.promises.stat(filePath);
    if (!st.isFile()) {
      return sendError(ws, id, 'fs.read failed: not a regular file (ENOTFILE)');
    }
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

// Bridge-safe image read: extension allowlist + size cap. The ONLY fs command
// reachable from the cloud bridge (see BRIDGE_ALLOWED_COMMANDS) — phones need
// session-referenced pictures, but a compromised cloud box must not be able to
// read arbitrary files (keys, configs) off exec hosts.
// Keep in sync with daemon-standalone.ts cmdFsReadImage.
var IMAGE_READ_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
var IMAGE_READ_MAX_BYTES = 20 * 1024 * 1024;

// Magic-byte check: the extension gate alone would let a compromised cloud
// box exfiltrate any file that merely ENDS in .png; requiring a real image
// header means non-image bytes (keys, configs) never leave the host.
function looksLikeImage(data) {
  if (data.length < 12) return false;
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return true; // PNG
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return true; // JPEG
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38) return true; // GIF8
  if (data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46
    && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) return true; // RIFF…WEBP
  return false;
}

async function cmdFsReadImage(ws, id, cmd) {
  let filePath = cmd.path;
  if (!filePath) return sendError(ws, id, 'fs.readImage: missing path');
  if (filePath === '~' || filePath.startsWith('~/')) {
    filePath = HOME_DIR + filePath.slice(1);
  }
  if (filePath.includes('..')) return sendError(ws, id, 'fs.readImage: invalid path');
  const ext = filePath.slice(filePath.lastIndexOf('.') + 1).toLowerCase();
  if (!IMAGE_READ_EXTENSIONS.has(ext)) return sendError(ws, id, 'fs.readImage: not an image (ENOTIMAGE)');

  try {
    const st = await fs.promises.stat(filePath);
    if (!st.isFile()) return sendError(ws, id, 'fs.readImage: not a file (ENOENT)');
    if (st.size > IMAGE_READ_MAX_BYTES) return sendError(ws, id, 'fs.readImage: too large (EFBIG)');
    const data = await fs.promises.readFile(filePath);
    if (!looksLikeImage(data)) return sendError(ws, id, 'fs.readImage: not an image (ENOTIMAGE)');
    sendOk(ws, id, { data: data.toString('base64'), encoding: 'base64' });
  } catch (err) {
    const code = err.code || '';
    sendError(ws, id, 'fs.readImage failed: ' + err.message + (code ? ' (' + code + ')' : ''));
  }
}

// Bridge-safe bounded file read: size cap + HOST-SIDE path sandbox. Serves
// the cloud replica's phone file previews (HTML/text file-content relay).
// Unlike fs.read (trusted SSH channel only), this is reachable from the
// public cloud bridge, so THIS handler is the security authority — the
// replica's own checks are a convenience, not the guarantee. Keep in sync
// with daemon-standalone.ts cmdFsReadBounded.
var FS_READ_BOUNDED_MAX_BYTES = 2 * 1024 * 1024; // 2MB — bridge frames stay small
// Secret files/dirs never served over the bridge. Checked against the
// REALPATH-resolved target so a symlink can't launder a denied path.
var FS_READ_BOUNDED_DENIED_DIRS = ['.ssh', '.aws', '.gnupg', path.join('.config', 'walnut-secrets')];
var FS_READ_BOUNDED_DENIED_BASENAMES = new Set([
  '.netrc', '.npmrc', '.git-credentials', 'credentials', 'auth.json', 'bridge-tokens.json',
]);
var FS_READ_BOUNDED_DENIED_EXTENSIONS = new Set(['pem', 'key', 'p12', 'pfx', 'ppk', 'jks', 'keystore']);

function fsReadBoundedDenied(resolved) {
  for (const dir of FS_READ_BOUNDED_DENIED_DIRS) {
    const abs = path.join(HOME_DIR, dir);
    if (resolved === abs || resolved.startsWith(abs + path.sep)) return true;
    // Any path SEGMENT named .ssh/.aws/… — covers non-HOME checkouts of keys.
    if (resolved.split(path.sep).includes(dir)) return true;
  }
  const base = path.basename(resolved);
  if (FS_READ_BOUNDED_DENIED_BASENAMES.has(base)) return true;
  if (base === '.env' || base.startsWith('.env.')) return true;
  if (/^id_(rsa|dsa|ecdsa|ed25519)/.test(base)) return true;
  const ext = base.slice(base.lastIndexOf('.') + 1).toLowerCase();
  if (FS_READ_BOUNDED_DENIED_EXTENSIONS.has(ext)) return true;
  if (/^config\.ya?ml$/.test(base)) return true;
  return false;
}

async function cmdFsReadBounded(ws, id, cmd) {
  let filePath = cmd.path;
  if (!filePath || typeof filePath !== 'string') return sendError(ws, id, 'fs.readBounded: missing path');
  if (filePath === '~' || filePath.startsWith('~/')) {
    filePath = HOME_DIR + filePath.slice(1);
  }
  if (filePath.includes('..')) return sendError(ws, id, 'fs.readBounded: invalid path (EDENIED)');
  if (!path.isAbsolute(filePath)) return sendError(ws, id, 'fs.readBounded: path must be absolute (EDENIED)');
  try {
    // realpath BEFORE the denylist: a symlink at an innocent path must not
    // serve ~/.ssh bytes. ENOENT here doubles as the not-found check.
    const resolved = await fs.promises.realpath(filePath);
    if (fsReadBoundedDenied(resolved)) {
      return sendError(ws, id, 'fs.readBounded: path not permitted (EDENIED)');
    }
    // Regular files ONLY, stat BEFORE open: open() on a FIFO with no writer
    // wedges an fs-pool thread forever (same guard as fs.read).
    const st = await fs.promises.stat(resolved);
    if (!st.isFile()) return sendError(ws, id, 'fs.readBounded: not a regular file (ENOTFILE)');
    if (st.size > FS_READ_BOUNDED_MAX_BYTES) {
      return sendError(ws, id, 'fs.readBounded: too large (EFBIG)');
    }
    const data = await fs.promises.readFile(resolved);
    sendOk(ws, id, { data: data.toString('base64'), encoding: 'base64', size: data.length });
  } catch (err) {
    const code = err.code || '';
    sendError(ws, id, 'fs.readBounded failed: ' + err.message + (code ? ' (' + code + ')' : ''));
  }
}

// Bridge-safe image save: mediaType allowlist + decoded-size cap + magic-byte
// check, writing ONLY into a fixed daemon-owned directory with a generated
// filename. The ONLY write command reachable from the cloud bridge (see
// BRIDGE_ALLOWED_COMMANDS) — phones attach pictures to sessions, but a
// compromised cloud box must never get arbitrary file writes on exec hosts:
// no caller-controlled path component ever reaches the filesystem (the
// extension comes from the mediaType allowlist, never from the caller), and
// non-image bytes are refused, so this cannot plant scripts/configs/keys.
// Keep in sync with daemon-standalone.ts cmdImageSave.
var IMAGE_SAVE_MEDIA_TO_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'heic',
};
var IMAGE_SAVE_MAX_BYTES = 10 * 1024 * 1024;
// ~4/3 base64 overhead + slack — refuse before decoding an oversized string.
var IMAGE_SAVE_MAX_BASE64_LENGTH = 14000000;
var IMAGE_SAVE_DIR = path.join(DAEMON_DIR, 'images', 'mobile');

// HEIC rides ISO-BMFF: a 'ftyp' box at byte 4. looksLikeImage covers the rest.
function looksLikeHeic(data) {
  return data.length >= 12 && data.slice(4, 8).toString('latin1') === 'ftyp';
}

async function cmdImageSave(ws, id, cmd) {
  const data = cmd.data;
  const mediaType = cmd.mediaType;
  if (typeof data !== 'string' || data.length === 0) return sendError(ws, id, 'image.save: missing data');
  if (data.length > IMAGE_SAVE_MAX_BASE64_LENGTH) return sendError(ws, id, 'image.save: too large (EFBIG)');
  const ext = typeof mediaType === 'string' ? IMAGE_SAVE_MEDIA_TO_EXT[mediaType] : undefined;
  if (!ext) return sendError(ws, id, 'image.save: unsupported mediaType (ENOTIMAGE)');
  const buf = Buffer.from(data, 'base64');
  if (buf.length === 0) return sendError(ws, id, 'image.save: invalid base64');
  if (buf.length > IMAGE_SAVE_MAX_BYTES) return sendError(ws, id, 'image.save: too large (EFBIG)');
  const isImage = mediaType === 'image/heic' ? looksLikeHeic(buf) : looksLikeImage(buf);
  if (!isImage) return sendError(ws, id, 'image.save: not an image (ENOTIMAGE)');
  // Generated filename — timestamp + random; extension from the mediaType
  // allowlist. NEVER from caller input: no path component crosses the bridge.
  const filename = Date.now() + '-' + crypto.randomBytes(4).toString('hex') + '.' + ext;
  const filePath = path.join(IMAGE_SAVE_DIR, filename);
  try {
    await fs.promises.mkdir(IMAGE_SAVE_DIR, { recursive: true });
    await fs.promises.writeFile(filePath, buf);
    logMsg('info', 'image.save: saved', { path: filePath, size: buf.length });
    sendOk(ws, id, { path: filePath, size: buf.length });
  } catch (err) {
    const code = err.code || '';
    sendError(ws, id, 'image.save failed: ' + err.message + (code ? ' (' + code + ')' : ''));
  }
}

async function cmdFsWrite(ws, id, cmd) {
  const { path: filePath, data, encoding } = cmd;
  // typeof, not truthiness: EMPTY data is legal (clearing a file to zero bytes
  // is a real save), and a !data check rejected it as "missing".
  // (No backticks in this file — the daemon source is an embedded template literal.)
  if (!filePath || typeof data !== 'string') return sendError(ws, id, 'fs.write: missing path or data');
  // exclusive = "create a NEW file" (the Files panel's new-file affordance): no
  // mkdir -p (a missing parent is a typo, not an intent) and flag 'wx' so an
  // existing file is an EEXIST rather than a silent clobber. Absent = the
  // editor's save path, unchanged. PARITY: daemon-standalone cmdFsWrite.
  const exclusive = cmd.exclusive === true;

  // The mutation floor applies to the exclusive (Files-panel "new file") path
  // ONLY. The plain save path predates this command and legitimately writes
  // relative and ~ paths that the floor refuses; adding the floor there would
  // break saving. So the NEW affordance gets the guard, the old one keeps its
  // contract. Without this, creating a file was the one mutation with no
  // host-side check at all, contradicting what fs-mutate-v1 advertises.
  // PARITY: daemon-standalone cmdFsWrite.
  let target = filePath;
  if (exclusive) {
    const resolved = await fsMutateResolve(filePath);
    if (!resolved) return sendError(ws, id, 'fs.write refused: path outside the mutation floor (EDENIED)');
    target = resolved;
  }

  try {
    if (!exclusive) await fs.promises.mkdir(path.dirname(target), { recursive: true });
    const enc = encoding || 'base64';
    const buf = enc === 'base64' ? Buffer.from(data, 'base64') : Buffer.from(data, 'utf-8');
    if (exclusive) await fs.promises.writeFile(target, buf, { flag: 'wx' });
    else await fs.promises.writeFile(target, buf);
    sendOk(ws, id, { written: true, size: buf.length });
  } catch (err) {
    const code = err.code ?? '';
    sendError(ws, id, 'fs.write failed: ' + err.message + (code ? ' (' + code + ')' : ''));
  }
}

async function cmdFsMkdir(ws, id, cmd) {
  let dirPath = cmd.path;
  if (!dirPath) return sendError(ws, id, 'fs.mkdir: missing path');

  // Expand ~ to home directory (Node fs doesn't do shell expansion)
  if (dirPath === '~' || dirPath.startsWith('~/')) {
    dirPath = HOME_DIR + dirPath.slice(1);
  }

  // exclusive = the UI's "new folder": recursive:false makes an existing
  // directory an EEXIST, so the panel can say "that name is taken" instead of
  // silently succeeding. Absent = the idempotent ensure-dir behavior every
  // other caller depends on. PARITY: daemon-standalone cmdFsMkdir.
  const exclusive = cmd.exclusive === true;
  // Same split as cmdFsWrite: the floor guards the UI's "new folder" only. The
  // idempotent ensure-dir behaviour every other caller depends on keeps working
  // on paths the floor would refuse (a daemon working dir two segments up, say).
  // PARITY: daemon-standalone cmdFsMkdir.
  if (exclusive) {
    const resolved = await fsMutateResolve(dirPath);
    if (!resolved) return sendError(ws, id, 'fs.mkdir refused: path outside the mutation floor (EDENIED)');
    dirPath = resolved;
  }
  try {
    // recursive:true tolerates already-existing directories (idempotent)
    await fs.promises.mkdir(dirPath, { recursive: !exclusive });
    sendOk(ws, id, { created: true, resolvedPath: dirPath });
  } catch (err) {
    const code = err.code ?? '';
    sendError(ws, id, 'fs.mkdir failed: ' + err.message + (code ? ' (' + code + ')' : ''));
  }
}

// Input floor EVERY mutating fs command runs before touching the disk
// ('fs-mutate-v1': fs.rename / fs.rm / fs.copy, plus fs.write and fs.mkdir when
// called with exclusive — see the note in cmdFsWrite for why only then).
// Callers go through fsMutateResolve, which adds the denylist and the symlink
// resolution; this function holds the string rules alone so it stays pure.
//
// The server validates too, but the daemon is the thing holding the file
// descriptors and it must not depend on a caller having been careful: one
// mis-serialized undefined reaching a recursive rm of / is unrecoverable.
// Returns the ~-expanded path, or null when the request must be refused
// (EDENIED).
//
// The rules, each guarding a specific way to lose data: absolute only (a
// relative path resolves against the daemon's cwd, which the caller cannot
// reason about); no '.'/'..' SEGMENT, checked segment-wise and never by
// substring so an ordinary name like '..bar' or 'mod..old' stays usable; never
// '/' and never HOME_DIR itself; at least 2 non-empty segments, so '/tmp' and
// '/usr' are refused and only something at '/a/b' depth or deeper is reachable.
// PARITY: daemon-standalone fsMutateFloor + src/web/routes/file-ops.ts.
function fsMutateFloor(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  let p = raw;
  if (p === '~' || p.startsWith('~/')) p = HOME_DIR + p.slice(1);
  if (!path.isAbsolute(p)) return null;
  // Trailing slashes are cosmetic — strip them BEFORE the comparisons, or a
  // home path with one walks straight past the HOME_DIR check.
  while (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  const segments = p.split('/');
  for (const seg of segments) if (seg === '.' || seg === '..') return null;
  if (segments.filter((s) => s.length > 0).length < 2) return null;
  let home = HOME_DIR;
  while (home.length > 1 && home.endsWith('/')) home = home.slice(0, -1);
  if (p === '/' || p === home) return null;
  return p;
}

// Host-side denylist for mutations. The server has one too, but the server's is
// built from the SERVER's home directory — so on a remote host it compares a
// Linux path against a Mac home directory and matches nothing. That left this
// host's ~/.ssh deletable through a trusted request, while the READ path
// (cmdFsReadBounded) has always refused it host-side. This closes that asymmetry.
//
// Segment-wise, never substring: '.ssh' as a path SEGMENT is the credential
// store, whereas a file merely named 'my.ssh.notes' is not.
// PARITY: daemon-standalone fsMutateDenied + src/web/routes/file-ops.ts.
function fsMutateDenied(p) {
  const segments = p.split('/').filter((s) => s.length > 0);
  const base = segments.length > 0 ? segments[segments.length - 1] : '';
  // Credential stores, wherever on this host they live. Nothing in a file
  // manager needs to rename or delete these, and losing them locks the user
  // (and Walnut's own ControlMaster access) out of the host.
  for (const seg of segments) {
    if (seg === '.ssh' || seg === '.aws' || seg === '.gnupg' || seg === '.kube' || seg === 'secrets') return true;
  }
  if (base === 'auth.json' || base === 'bridge-tokens.json') return true;
  // Walnut's own irreplaceable state on this host. The stream JSONLs ARE the
  // conversation history: there is no second copy to restore from.
  // Both the legacy /tmp roots and the CURRENT home: streams moved to
  // ~/.open-walnut/tmp/streams in 2026-08 (PROD_STREAMS_DIR), and every
  // override the daemon honours is covered too, so a relocated install is
  // protected on the same terms as the default one.
  const runtimeRoots = [
    '/tmp/open-walnut', '/tmp/open-walnut-streams',
    path.join(HOME_DIR, '.open-walnut', 'tmp'),
    process.env.WALNUT_DAEMON_DIR, process.env.WALNUT_STREAMS_DIR, process.env.WALNUT_LEGACY_STREAMS_DIR,
  ].filter((r) => typeof r === 'string' && r.length > 0);
  for (const root of runtimeRoots) {
    if (p === root || p.indexOf(root + '/') === 0) return true;
  }
  return false;
}

// The floor plus the denylist, applied to the path the KERNEL will reach.
//
// fsMutateFloor alone reads the path as a string, but the kernel walks it as a
// chain of directories, so any symlinked ancestor launders a target past every
// rule: /tmp/link/.ssh is 3 segments deep, holds no '..', is not '/' and is not
// HOME_DIR, yet with 'link' pointing at the home directory a recursive delete
// destroys the real ~/.ssh. cmdFsReadBounded already resolves before checking;
// the destructive commands now do the same.
//
// Returns the ORIGINAL path, not the resolved one: a symlink must be renamed or
// deleted as the LINK and never followed to its target.
// PARITY: daemon-standalone fsMutateResolve.
async function fsMutateResolve(raw) {
  const p = fsMutateFloor(raw);
  if (!p) return null;
  if (fsMutateDenied(p)) return null;
  let real;
  try {
    real = path.join(await fs.promises.realpath(path.dirname(p)), path.basename(p));
  } catch (e) {
    // Parent missing or unreadable: there is no symlink chain to launder
    // through, and the real fs call is about to produce an accurate
    // ENOENT/EACCES. Do not convert that into a misleading EDENIED.
    return p;
  }
  if (real === p) return p;
  if (!fsMutateFloor(real) || fsMutateDenied(real)) return null;
  return p;
}

async function cmdFsRename(ws, id, cmd) {
  const from = await fsMutateResolve(cmd.from);
  const to = await fsMutateResolve(cmd.to);
  if (!from || !to) return sendError(ws, id, 'fs.rename refused: path outside the mutation floor (EDENIED)');

  try {
    // POSIX rename REPLACES an existing target without a word, so a rename in
    // the Files panel could silently delete another file. lstat first (not stat:
    // a symlink target must count as taken, and the link itself is what moves).
    let targetExists = true;
    try { await fs.promises.lstat(to); } catch (e) { targetExists = false; }
    if (targetExists) {
      return sendError(ws, id, 'fs.rename failed: target already exists (EEXIST)');
    }
    await fs.promises.rename(from, to);
    sendOk(ws, id, { renamed: true });
  } catch (err) {
    const code = err.code ?? '';
    sendError(ws, id, 'fs.rename failed: ' + err.message + (code ? ' (' + code + ')' : ''));
  }
}

async function cmdFsRm(ws, id, cmd) {
  const target = await fsMutateResolve(cmd.path);
  if (!target) return sendError(ws, id, 'fs.rm refused: path outside the mutation floor (EDENIED)');
  const recursive = cmd.recursive === true;

  try {
    // The directory guard is OURS, not node's: node and bun disagree on the code
    // for rm-a-directory-without-recursive (ERR_FS_EISDIR vs EISDIR vs EPERM),
    // and the server maps on the code. lstat, so a symlink TO a directory is
    // removed as the link and never followed.
    const st = await fs.promises.lstat(target);
    if (st.isDirectory() && !recursive) {
      return sendError(ws, id, 'fs.rm failed: target is a directory (EISDIR)');
    }
    await fs.promises.rm(target, { recursive: recursive, force: false });
    sendOk(ws, id, { removed: true });
  } catch (err) {
    const code = err.code ?? '';
    sendError(ws, id, 'fs.rm failed: ' + err.message + (code ? ' (' + code + ')' : ''));
  }
}

async function cmdFsCopy(ws, id, cmd) {
  const from = await fsMutateResolve(cmd.from);
  const to = await fsMutateResolve(cmd.to);
  if (!from || !to) return sendError(ws, id, 'fs.copy refused: path outside the mutation floor (EDENIED)');

  try {
    // Same never-clobber rule as rename, and the same lstat reason. errorOnExist
    // alone is not enough: it only fires per-entry inside a recursive copy.
    let targetExists = true;
    try { await fs.promises.lstat(to); } catch (e) { targetExists = false; }
    if (targetExists) {
      return sendError(ws, id, 'fs.copy failed: target already exists (EEXIST)');
    }
    try {
      await fs.promises.cp(from, to, { recursive: true, errorOnExist: true, force: false });
    } catch (cpErr) {
      // A copy that dies mid-tree (ENOSPC, EACCES on one entry) leaves a partial
      // destination behind, and the never-clobber check above then answers EEXIST
      // to every retry forever. 'to' was verified absent moments ago, so whatever
      // is there now is ours to remove. Best effort: the original error is what
      // the caller needs to see. PARITY: daemon-standalone cmdFsCopy.
      await fs.promises.rm(to, { recursive: true, force: true }).catch(() => {});
      throw cpErr;
    }
    sendOk(ws, id, { copied: true });
  } catch (err) {
    const code = err.code ?? '';
    sendError(ws, id, 'fs.copy failed: ' + err.message + (code ? ' (' + code + ')' : ''));
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
    // PARITY: keep in sync with daemon-standalone.ts cmdFsLs. detail:true adds
    // per-file size/mtimeMs for the session-changes subagent cache.
    const detail = cmd.detail === true;
    const result = await Promise.all(entries.map(async e => {
      const type = e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other';
      if (!detail || type !== 'file') return { name: e.name, type };
      try {
        const st = await fs.promises.stat(dirPath + '/' + e.name);
        return { name: e.name, type, size: st.size, mtimeMs: st.mtimeMs };
      } catch {
        return { name: e.name, type };
      }
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
    // dev/ino/birthtimeMs → walnut derives the stream-file epoch for the
    // stale-watermark reset (twin of daemon-standalone cmdFsStat).
    sendOk(ws, id, {
      exists: true, mtimeMs: st.mtimeMs, size: st.size,
      dev: st.dev, ino: st.ino, birthtimeMs: st.birthtimeMs,
    });
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
    // Same FIFO guard as fs.read: stat BEFORE open (see cmdFsRead).
    const pre = await fs.promises.stat(filePath);
    if (!pre.isFile()) {
      return sendError(ws, id, 'fs.readRange failed: not a regular file (ENOTFILE)');
    }
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
        if (newRel) entries.push({ status: 'renamed', relPath: newRel, oldRelPath: oldRel });
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
    // PARITY (git-diff-core.ts opts.paths): narrow blob materialization to the
    // caller's file set — scope=session sends the session's own files so we
    // don't git-show every changed file in the repo.
    let wanted = entries;
    if (Array.isArray(cmd.paths) && cmd.paths.every((p) => typeof p === 'string')) {
      const want = new Set(cmd.paths);
      wanted = entries.filter((e) => want.has(e.relPath) || (e.oldRelPath !== undefined && want.has(e.oldRelPath)));
    }
    if (wanted.length === 0) return sendOk(ws, id, { repoRoot: repoRoot, files: [] });

    // Parallel pool (PARITY with git-diff-core.ts): serial git-show spawns
    // were ~15ms x N — 683 files took ~10.7s.
    const files = new Array(wanted.length);
    let nextIdx = 0;
    const worker = async () => {
      while (nextIdx < wanted.length) {
        const i = nextIdx++;
        const e = wanted[i];
        const beforePath = e.oldRelPath || e.relPath;
        let before = '';
        if (e.status !== 'added') {
          const show = await exec(['git', 'show', baseRev + ':' + beforePath], repoRoot);
          before = show.code === 0 ? show.stdout : '';
        }
        const after = e.status === 'deleted' ? '' : await readText(joinPosix(repoRoot, e.relPath));
        files[i] = { relPath: e.relPath, before: before, after: after, status: e.status, oldRelPath: e.oldRelPath };
      }
    };
    const workers = [];
    for (let w = 0; w < Math.min(8, wanted.length); w++) workers.push(worker());
    await Promise.all(workers);
    files.sort((a, b) => a.relPath.localeCompare(b.relPath));
    sendOk(ws, id, { repoRoot: repoRoot, files: files });
  } catch (err) {
    sendError(ws, id, 'git.diff failed: ' + err.message);
  }
}

// -- Git history for ONE file (host-local — capability 'git-file-history-v1') --
// Same rule as git.diff: git and the file must be on the same host, so the Files
// panel's history asks the daemon rather than shuttling bytes. Two questions
// only — which commits touched this file, and what it looked like at one of
// them — each ONE git invocation with a timeout and a maxBuffer. Keep in sync
// with cmdGitFileLog/cmdGitFileShow in daemon-standalone.ts.

// A sha as it arrives from a caller. Checked BEFORE spawning: it lands in a
// 'git show <sha>:<path>' argument. Mirrors GIT_SHA_RE in file-history-git.ts.
const GIT_FILE_SHA_RE = /^[0-9a-f]{7,40}$/;
const GIT_FILE_LOG_FORMAT = '%H%x1f%ct%x1f%an%x1f%s';
const GIT_FILE_SHOW_MAX_BYTES = 8 * 1024 * 1024;

// One git run for the file-history family. Never throws — exit codes are answers.
function gitFileExec(argv, runCwd, maxBuffer) {
  const cp = require('child_process');
  return new Promise((resolve) => {
    cp.execFile(argv[0], argv.slice(1), { cwd: runCwd, timeout: 8000, maxBuffer: maxBuffer, encoding: 'utf-8' },
      (err, stdout, stderr) => {
        if (!err) return resolve({ stdout: stdout, stderr: stderr, code: 0, failure: '' });
        resolve({
          stdout: stdout || '',
          stderr: stderr || '',
          code: typeof err.code === 'number' ? err.code : 1,
          failure: err.message || '',
        });
      });
  });
}

// Expand a leading '~' against this host's HOME (same as the other commands).
function gitFileExpandHome(p) {
  return (p === '~' || p.startsWith('~/')) ? HOME_DIR + p.slice(1) : p;
}

async function cmdGitFileLog(ws, id, cmd) {
  const rawCwd = cmd.cwd;
  const rawPath = cmd.path;
  if (!rawCwd || typeof rawCwd !== 'string') return sendError(ws, id, 'git.fileLog: missing cwd');
  if (!rawPath || typeof rawPath !== 'string') return sendError(ws, id, 'git.fileLog: missing path');
  const cwd = gitFileExpandHome(rawCwd);
  const filePath = gitFileExpandHome(rawPath);
  const requested = typeof cmd.limit === 'number' && isFinite(cmd.limit) ? Math.floor(cmd.limit) : 30;
  const limit = Math.max(1, Math.min(requested, 200));
  try {
    const top = await gitFileExec(['git', 'rev-parse', '--show-toplevel'], cwd, 64 * 1024);
    if (top.code !== 0 || !top.stdout.trim()) return sendOk(ws, id, { repoRoot: null, commits: [] });
    const repoRoot = top.stdout.trim();
    const rel = path.relative(repoRoot, filePath).split(path.sep).join('/');
    if (!rel || rel === '..' || rel.startsWith('../')) return sendOk(ws, id, { repoRoot: repoRoot, commits: [] });
    const res = await gitFileExec(
      ['git', 'log', '--follow', '--no-color', '--format=' + GIT_FILE_LOG_FORMAT, '-n', String(limit), '--', rel],
      repoRoot, 4 * 1024 * 1024,
    );
    // A path git never tracked exits non-zero: an ordinary "no history", not a failure.
    if (res.code !== 0) return sendOk(ws, id, { repoRoot: repoRoot, commits: [] });
    const commits = [];
    const lines = res.stdout.split('\\n');
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i]) continue;
      const parts = lines[i].split('\\x1f');
      if (parts.length < 4) continue;
      const at = Number(parts[1]) * 1000;
      commits.push({
        sha: parts[0], at: isFinite(at) ? at : 0, author: parts[2],
        subject: parts.slice(3).join('\\x1f'),
      });
    }
    sendOk(ws, id, { repoRoot: repoRoot, commits: commits });
  } catch (err) {
    sendError(ws, id, 'git.fileLog failed: ' + err.message);
  }
}

async function cmdGitFileShow(ws, id, cmd) {
  const rawCwd = cmd.cwd;
  const rawPath = cmd.path;
  const sha = cmd.sha;
  if (!rawCwd || typeof rawCwd !== 'string') return sendError(ws, id, 'git.fileShow: missing cwd');
  if (!rawPath || typeof rawPath !== 'string') return sendError(ws, id, 'git.fileShow: missing path');
  if (!sha || typeof sha !== 'string' || !GIT_FILE_SHA_RE.test(sha)) {
    return sendError(ws, id, 'git.fileShow: invalid sha');
  }
  const cwd = gitFileExpandHome(rawCwd);
  const filePath = gitFileExpandHome(rawPath);
  try {
    const top = await gitFileExec(['git', 'rev-parse', '--show-toplevel'], cwd, 64 * 1024);
    if (top.code !== 0 || !top.stdout.trim()) return sendError(ws, id, 'git.fileShow failed: not a git repository');
    const repoRoot = top.stdout.trim();
    const rel = path.relative(repoRoot, filePath).split(path.sep).join('/');
    if (!rel || rel === '..' || rel.startsWith('../')) return sendError(ws, id, 'git.fileShow failed: file is outside the repository');
    const res = await gitFileExec(['git', 'show', sha + ':' + rel], repoRoot, GIT_FILE_SHOW_MAX_BYTES);
    if (res.code !== 0) {
      if (/maxBuffer/i.test(res.failure)) {
        return sendError(ws, id, 'git.fileShow failed: that version is larger than '
          + GIT_FILE_SHOW_MAX_BYTES + ' bytes — too big to show');
      }
      return sendError(ws, id, 'git.fileShow failed: '
        + (res.stderr.trim().split('\\n')[0] || res.failure || 'git show failed'));
    }
    sendOk(ws, id, { content: res.stdout });
  } catch (err) {
    sendError(ws, id, 'git.fileShow failed: ' + err.message);
  }
}

// -- Symbol search (host-local — capability 'grep-v1') --
// Inlined equivalent of search-grep-core.ts (this template can NOT import and
// must NOT contain backticks). NOT sidecar-gated: it needs only child_process,
// which every node has. Keep the caps, the classification regexes, the sort,
// and the reply shape in sync with search-grep-core.ts.
const GREP_SYMBOL_RE = /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/;
const GREP_PRUNE_DIRS = [
  'node_modules', '.git', 'dist', 'build', 'out', '.next', 'target',
  'coverage', '.cache', 'vendor', '__pycache__', '.venv', 'venv',
  '.gradle', '.idea', 'Pods', '.terraform', '.tox', '.mypy_cache',
];
const GREP_LINE_RE = /^(.*?):(\\d+):(.*)$/;
const GREP_MAX_TEXT_CHARS = 300;

function grepEscapeRe(s) {
  return s.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
}

// Does this line look like where the symbol is DECLARED? Keyword rules are
// anchored to the symbol, so a closure line that merely contains 'func' stays a
// ref. A wrong guess costs an ordering, never a wrong answer.
function grepClassifyDefinition(lineText, symbol) {
  if (!lineText || !GREP_SYMBOL_RE.test(symbol)) return false;
  const sym = grepEscapeRe(symbol);
  if (new RegExp('\\\\b(func|fn|def|function|class|struct|interface|trait|enum|impl|type|module|macro)\\\\s+(\\\\([^)]*\\\\)\\\\s*)?' + sym + '\\\\b').test(lineText)) return true;
  if (new RegExp('\\\\b(const|let|var|val|final|readonly)\\\\s+' + sym + '\\\\b').test(lineText)) return true;
  if (new RegExp('^\\\\s*' + sym + '\\\\s*:?=[^=]').test(lineText)) return true;
  if (new RegExp('\\\\b(public|private|protected|internal|static)\\\\s+[^=;]*\\\\b' + sym + '\\\\s*\\\\(').test(lineText)) return true;
  return false;
}

async function cmdFsGrep(ws, id, cmd) {
  const file = cmd.file;
  const symbol = cmd.symbol;
  if (!file || typeof file !== 'string') return sendError(ws, id, 'fs.grep: missing file');
  if (!symbol || typeof symbol !== 'string') return sendError(ws, id, 'fs.grep: missing symbol');
  try {
    if (!GREP_SYMBOL_RE.test(symbol)) {
      return sendOk(ws, id, { root: '', matches: [], truncated: false, tool: 'none', error: 'invalid symbol' });
    }
    if (!path.isAbsolute(file)) {
      return sendOk(ws, id, { root: '', matches: [], truncated: false, tool: 'none', error: 'file must be absolute' });
    }
    const requested = typeof cmd.maxMatches === 'number' && isFinite(cmd.maxMatches)
      ? Math.floor(cmd.maxMatches) : 500;
    const maxMatches = Math.max(1, Math.min(requested, 2000));
    const budgetMs = typeof cmd.budgetMs === 'number' ? cmd.budgetMs : 10000;
    const dir = path.dirname(file);

    // Never throws: exit 1 (no matches) is a normal answer; -1 means the process
    // could not run or was killed by the timeout.
    const cp = require('child_process');
    const run = (bin, args, runCwd) => new Promise((resolve) => {
      const child = cp.execFile(bin, args,
        { cwd: runCwd, timeout: Math.min(budgetMs, 8000), maxBuffer: 16 * 1024 * 1024, encoding: 'utf-8' },
        (err, stdout) => {
          if (!err) return resolve({ stdout: stdout || '', code: 0 });
          resolve({ stdout: stdout || '', code: typeof err.code === 'number' ? err.code : -1 });
        });
      child.on('error', () => resolve({ stdout: '', code: -1 }));
    });

    const build = (res, tool, root, toAbs) => {
      const failed = res.code !== 0 && res.code !== 1;
      if (failed && !res.stdout) {
        return { root: root, matches: [], truncated: false, tool: tool, error: 'search timed out or failed' };
      }
      const matches = [];
      let truncated = false;
      const lines = res.stdout.split('\\n');
      for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        if (!raw) continue;
        if (matches.length >= maxMatches) { truncated = true; break; }
        const m = GREP_LINE_RE.exec(raw);
        if (!m) continue;
        const text = m[3].replace(/\\r$/, '').slice(0, GREP_MAX_TEXT_CHARS);
        matches.push({
          file: toAbs(m[1]),
          line: Number(m[2]),
          text: text,
          kind: grepClassifyDefinition(text, symbol) ? 'def' : 'ref',
        });
      }
      // Definitions first, then file path, then line. Stable.
      const decorated = matches.map((mm, idx) => ({ m: mm, i: idx }));
      decorated.sort((a, b) =>
        (a.m.kind === b.m.kind ? 0 : a.m.kind === 'def' ? -1 : 1)
        || (a.m.file < b.m.file ? -1 : a.m.file > b.m.file ? 1 : 0)
        || a.m.line - b.m.line
        || a.i - b.i);
      return {
        root: root,
        matches: decorated.map((e) => e.m),
        truncated: truncated || failed,
        tool: tool,
      };
    };

    const top = await run('git', ['-C', dir, 'rev-parse', '--show-toplevel'], undefined);
    const root = top.code === 0 && top.stdout.trim() ? top.stdout.trim() : null;
    if (root) {
      const res = await run('git',
        ['grep', '-n', '-I', '--recurse-submodules', '-w', '-F', '-e', symbol, '--'], root);
      return sendOk(ws, id, build(res, 'git-grep', root, (rel) => path.join(root, rel)));
    }
    // --devices=skip: one FIFO in the tree otherwise BLOCKS grep on the open
    // until the timeout kills it (whole budget spent, zero results).
    const args = ['-r', '-n', '-I', '-w', '-F', '--devices=skip'];
    for (let i = 0; i < GREP_PRUNE_DIRS.length; i++) args.push('--exclude-dir=' + GREP_PRUNE_DIRS[i]);
    args.push('-e', symbol, dir);
    let res = await run('grep', args, dir);
    // BSD grep without --devices= exits 2 on the usage error: retry its spelling,
    // then plain (pre-existing behavior, not a regression).
    if (res.code === 2 && !res.stdout) {
      const bsd = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--devices=skip') { bsd.push('-D'); bsd.push('skip'); } else bsd.push(args[i]);
      }
      res = await run('grep', bsd, dir);
      if (res.code === 2 && !res.stdout) {
        const plain = [];
        for (let i = 0; i < args.length; i++) if (args[i] !== '--devices=skip') plain.push(args[i]);
        res = await run('grep', plain, dir);
      }
    }
    return sendOk(ws, id, build(res, 'grep', dir, (p) => p));
  } catch (err) {
    sendError(ws, id, 'fs.grep failed: ' + err.message);
  }
}

// ── Session changes (host-local compute — capability 'changes-v1') ──
// The pipeline lives in a SIDECAR bundle (changes-core.cjs) deployed next to
// this script — this template can't import modules (and must not contain
// backticks), so the core is require()d at startup and 'changes-v1' is
// advertised only when the sidecar loaded. Cache + serial gate mirror
// daemon-standalone.ts: per-sid full output keyed on (mtimeMs, size), one
// compute at a time daemon-wide, same-sid followers coalesce.
let changesCore = null;
try { changesCore = require(path.join(__dirname, 'changes-core.cjs')); } catch (err) { changesCore = null; }

// External-session scan sidecar (external-scan-core.cjs) — same sidecar
// rationale as changes-core above: the walk + transcript parse can't live in
// this template, so it is require()d and 'external-scan-v1' is advertised only
// when the load succeeds. An old/sidecar-less daemon simply never reports
// external sessions for its host (the server skips it on capability).
let externalScanCore = null;
try { externalScanCore = require(path.join(__dirname, 'external-scan-core.cjs')); } catch (err) { externalScanCore = null; }

// Layered path resolution sidecar (path-resolve-core.cjs) — same sidecar
// rationale: the transcript scan + git/find search can't live in this template.
// 'path-resolve-v1' is advertised only when the load succeeds; without it the
// server falls back to its own per-ancestor stat walk over RPC.
let pathResolveCore = null;
try { pathResolveCore = require(path.join(__dirname, 'path-resolve-core.cjs')); } catch (err) { pathResolveCore = null; }

// Embedded VS Code sidecar (vscode-server-core.cjs) — same sidecar rationale:
// the install/spawn/health pipeline can't live in this template. 'vscode-v1'
// is advertised only when the load succeeds; without it the web UI degrades
// to the vscode:// deep-link button.
let vscodeServerCore = null;
try { vscodeServerCore = require(path.join(__dirname, 'vscode-server-core.cjs')); } catch (err) { vscodeServerCore = null; }

// Transcript rewind probe sidecar (transcript-rewind-core.cjs) — same sidecar
// rationale: the chain walk + dead-set replay can't live in this template.
// 'rewind-probe-v1' is advertised only when the load succeeds; without it the
// server reads the whole transcript over the tunnel (and a transcript past the
// reader's byte ceiling can't be rewound at all until the next auto-deploy).
let transcriptRewindCore = null;
try { transcriptRewindCore = require(path.join(__dirname, 'transcript-rewind-core.cjs')); } catch (err) { transcriptRewindCore = null; }

function daemonCapabilities() {
  const caps = __DAEMON_CAPABILITIES__.slice();
  if (changesCore) caps.push('changes-v1');
  if (externalScanCore) caps.push('external-scan-v1');
  if (pathResolveCore) caps.push('path-resolve-v1');
  if (vscodeServerCore) caps.push('vscode-v1');
  if (transcriptRewindCore) caps.push('rewind-probe-v1');
  // 'grep-v1' is NOT sidecar-gated: cmdFsGrep is inlined above and needs only
  // child_process, so this twin can always answer fs.grep. Stated explicitly
  // here (and deduped) so the capability holds even if the static literal ever
  // stops carrying it.
  if (caps.indexOf('grep-v1') === -1) caps.push('grep-v1');
  return caps;
}

// Resolve "whatever the model wrote" to a real path on THIS host. See
// cmdFsResolvePath in daemon-standalone.ts for the design rationale.
async function cmdFsResolvePath(ws, id, cmd) {
  if (!pathResolveCore) {
    sendError(ws, id, 'fs.resolvePath unsupported: path-resolve-core sidecar not loaded');
    return;
  }
  const ref = cmd.ref;
  if (!ref || typeof ref !== 'string') return sendError(ws, id, 'fs.resolvePath: missing ref');
  try {
    const result = await pathResolveCore.resolvePathHostLocal({
      ref: ref,
      cwd: typeof cmd.cwd === 'string' && cmd.cwd ? cmd.cwd : undefined,
      sessionId: typeof cmd.sessionId === 'string' && cmd.sessionId ? cmd.sessionId : undefined,
      claudeHome: path.join(HOME_DIR, '.claude'),
      homeDir: HOME_DIR,
      budgetMs: typeof cmd.budgetMs === 'number' ? cmd.budgetMs : undefined,
    });
    sendOk(ws, id, result);
  } catch (err) {
    sendError(ws, id, 'fs.resolvePath failed: ' + err.message);
  }
}

// Embedded VS Code — see cmdVscodeEnsure in daemon-standalone.ts for the
// design rationale. NOT bridge-reachable (starts a process).
async function cmdVscodeEnsure(ws, id, cmd) {
  if (!vscodeServerCore) {
    sendError(ws, id, 'vscode.ensure unsupported: vscode-server-core sidecar not loaded');
    return;
  }
  try {
    const result = await vscodeServerCore.ensureCodeServer({ noInstall: cmd.noInstall === true });
    let open;
    if (typeof cmd.cwd === 'string' && cmd.cwd) {
      open = await vscodeServerCore.resolveOpenTarget(cmd.cwd);
    }
    if (!result.ok) logMsg('warn', 'vscode.ensure failed', { error: result.error, installed: result.installed });
    sendOk(ws, id, Object.assign({}, result, { open: open }));
  } catch (err) {
    sendError(ws, id, 'vscode.ensure failed: ' + err.message);
  }
}

// ── Discover sessions started OUTSIDE Walnut ──
// Serialized daemon-wide: a burst of server ticks must not stack concurrent
// directory walks over thousands of transcript files.
let externalScanInflight = Promise.resolve();

async function cmdDiscoverExternalSessions(ws, id, cmd) {
  if (!externalScanCore) {
    sendError(ws, id, 'sessions.discoverExternal unsupported: external-scan-core sidecar not loaded');
    return;
  }
  const prev = externalScanInflight;
  let release;
  externalScanInflight = new Promise((r) => { release = r; });
  await prev.catch(() => {});
  try {
    const sinceMs = typeof cmd.sinceMs === 'number' && cmd.sinceMs > 0 ? cmd.sinceMs : 30 * 24 * 60 * 60 * 1000;
    const knownSessionIds = Array.isArray(cmd.knownSessionIds)
      ? cmd.knownSessionIds.filter(function (s) { return typeof s === 'string'; })
      : [];
    const limit = typeof cmd.limit === 'number' && cmd.limit > 0 ? cmd.limit : undefined;
    const t0 = Date.now();
    const result = externalScanCore.scanExternalSessions({
      sinceMs: sinceMs, knownSessionIds: knownSessionIds, limit: limit, homeDir: HOME_DIR,
    });
    logMsg('info', 'external session scan', {
      scanned: result.scanned, found: result.candidates.length,
      truncated: result.truncated, ms: Date.now() - t0,
    });
    sendOk(ws, id, {
      candidates: result.candidates, scanned: result.scanned, truncated: result.truncated,
    });
  } catch (err) {
    sendError(ws, id, 'sessions.discoverExternal failed: ' + err.message);
  } finally {
    release();
  }
}

const changesCache = new Map();
const CHANGES_CACHE_MAX_SESSIONS = 12;
let changesInflight = Promise.resolve();
const changesInflightBySid = new Map();

async function computeChangesCached(sid, cwd, refresh) {
  // mtime+size fast-path — no lock needed for a pure cache hit. refresh
  // ("re-read the data") skips it but still reuses subCache/gitRoot memos.
  const cached = changesCache.get(sid);
  if (cached && !refresh) {
    try {
      const st = await fs.promises.stat(cached.output.jsonlPath);
      if (st.mtimeMs === cached.mtimeMs && st.size === cached.size) {
        cached.lastUsed = Date.now();
        return cached;
      }
    } catch (err) { /* stat failed → recompute below */ }
  }
  const existing = changesInflightBySid.get(sid);
  if (existing) return existing;
  const run = (async () => {
    // Daemon-wide serial gate: chain onto whatever compute is running.
    const prev = changesInflight;
    let release;
    changesInflight = new Promise((r) => { release = r; });
    await prev.catch(() => {});
    try {
      const prior = changesCache.get(sid);
      const output = await changesCore.computeHostLocalChanges({
        sessionId: sid,
        cwd: cwd,
        claudeHome: path.join(HOME_DIR, '.claude'),
        subCache: prior ? prior.subCache : undefined,
        gitRootByDir: prior ? prior.gitRootByDir : undefined,
      });
      if (!output) return null;
      const entry = {
        mtimeMs: output.mtimeMs,
        size: output.size,
        output: output,
        subCache: (prior && prior.subCache) || new Map(),
        gitRootByDir: (prior && prior.gitRootByDir) || new Map(),
        lastUsed: Date.now(),
      };
      changesCache.set(sid, entry);
      // LRU bound — whale outputs hold full before/after strings.
      if (changesCache.size > CHANGES_CACHE_MAX_SESSIONS) {
        let oldest = null;
        let oldestTs = Infinity;
        for (const [k, v] of changesCache) {
          if (v.lastUsed < oldestTs) { oldestTs = v.lastUsed; oldest = k; }
        }
        if (oldest && oldest !== sid) changesCache.delete(oldest);
      }
      return entry;
    } finally {
      release();
      changesInflightBySid.delete(sid);
    }
  })();
  changesInflightBySid.set(sid, run);
  return run;
}

async function cmdChangesCompute(ws, id, cmd) {
  if (!changesCore) return sendError(ws, id, 'changes.compute: core sidecar not available on this host');
  const sid = cmd.sid;
  if (!sid) return sendError(ws, id, 'changes.compute: missing sid');
  const cwd = typeof cmd.cwd === 'string' && cmd.cwd ? cmd.cwd : undefined;
  const refresh = cmd.refresh === true;
  try {
    const entry = await computeChangesCached(sid, cwd, refresh);
    if (!entry) return sendOk(ws, id, { found: false, result: null });
    // The wire result is ALWAYS light — per-file content rides changes.file.
    sendOk(ws, id, {
      found: true,
      result: changesCore.toLightChangesResult(entry.output.result),
      mtimeMs: entry.mtimeMs,
      jsonlPath: entry.output.jsonlPath,
    });
  } catch (err) {
    sendError(ws, id, 'changes.compute failed: ' + err.message);
  }
}

async function cmdChangesFile(ws, id, cmd) {
  if (!changesCore) return sendError(ws, id, 'changes.file: core sidecar not available on this host');
  const sid = cmd.sid;
  const filePath = cmd.path;
  if (!sid) return sendError(ws, id, 'changes.file: missing sid');
  if (!filePath) return sendError(ws, id, 'changes.file: missing path');
  const cwd = typeof cmd.cwd === 'string' && cmd.cwd ? cmd.cwd : undefined;
  try {
    // Serve from the cached full output even when slightly stale (mtime
    // moved): a file click must not wait behind a whale recompute. The list
    // refresh converges the frontend's per-file cache.
    let entry = changesCache.get(sid);
    if (!entry) entry = await computeChangesCached(sid, cwd, false);
    if (!entry) return sendOk(ws, id, { found: false });
    entry.lastUsed = Date.now();
    for (const group of entry.output.result.groups) {
      const file = group.files.find((f) => f.filePath === filePath);
      if (file) return sendOk(ws, id, { found: true, repoRoot: group.repoRoot, file: file });
    }
    sendOk(ws, id, { found: false });
  } catch (err) {
    sendError(ws, id, 'changes.file failed: ' + err.message);
  }
}

// ── Transcript rewind probe (host-local — capability 'rewind-probe-v1') ──
// See cmdTranscriptRewindProbe in daemon-standalone.ts for the design rationale.
// Deliberately UNCACHED: callers ask precisely because the file may have changed.
// Concurrency gated like changes.compute: one probe at a time daemon-wide, and
// identical requests share one promise (key = the whole request, not the sid —
// two callers asking different questions need different answers).
let rewindProbeInflight = Promise.resolve();
const rewindProbeInflightByKey = new Map();

function rewindProbeKey(input) {
  const cutSig = (input.cuts || []).map(function (c) {
    return c.uuid + '>' + c.lastUuidAtCommit;
  }).join(',');
  return [input.sessionId, input.cwd || '', input.uuid || '', cutSig].join('|');
}

async function probeTranscriptRewindGated(input) {
  const key = rewindProbeKey(input);
  const existing = rewindProbeInflightByKey.get(key);
  if (existing) return existing;
  const run = (async () => {
    const prev = rewindProbeInflight;
    let release;
    rewindProbeInflight = new Promise((r) => { release = r; });
    await prev.catch(() => {});
    try {
      return await transcriptRewindCore.probeTranscriptRewindHostLocal(input);
    } finally {
      release();
      rewindProbeInflightByKey.delete(key);
    }
  })();
  rewindProbeInflightByKey.set(key, run);
  return run;
}

async function cmdTranscriptRewindProbe(ws, id, cmd) {
  if (!transcriptRewindCore) {
    return sendError(ws, id, 'transcript.rewindProbe: core sidecar not available on this host');
  }
  const sid = cmd.sid;
  if (!sid) return sendError(ws, id, 'transcript.rewindProbe: missing sid');
  const cwd = typeof cmd.cwd === 'string' && cmd.cwd ? cmd.cwd : undefined;
  const uuid = typeof cmd.uuid === 'string' && cmd.uuid ? cmd.uuid : undefined;
  let cuts = undefined;
  if (Array.isArray(cmd.cuts)) {
    cuts = [];
    for (const c of cmd.cuts) {
      if (!c || typeof c.uuid !== 'string' || typeof c.lastUuidAtCommit !== 'string') continue;
      const cut = { uuid: c.uuid, lastUuidAtCommit: c.lastUuidAtCommit };
      if (Array.isArray(c.trailingQueueKeys)) {
        cut.trailingQueueKeys = c.trailingQueueKeys.filter(function (k) { return typeof k === 'string'; });
      }
      cuts.push(cut);
    }
  }
  try {
    const input = { sessionId: sid, cwd: cwd, claudeHome: path.join(HOME_DIR, '.claude') };
    if (uuid) input.uuid = uuid;
    if (cuts) input.cuts = cuts;
    const output = await probeTranscriptRewindGated(input);
    if (!output) return sendOk(ws, id, { found: false });
    sendOk(ws, id, Object.assign({ found: true }, output));
  } catch (err) {
    sendError(ws, id, 'transcript.rewindProbe failed: ' + err.message);
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
let bridgeDialTimer = null;
// When the in-flight dial started (null = no dial in flight) — feeds the
// reconcile decision so an identical-config push can't kill a young dial.
let bridgeDialStartedAt = null;
let bridgeBackoffMs = 1000;
// When the pending redial is due (null = none pending) — lets the Mac's heal
// push preempt a far-away redial instead of waiting out backoff earned offline.
let bridgeRedialDueAt = null;
let bridgeGeneration = 0;
let bridgeLastInbound = 0;

const BRIDGE_BACKOFF_MAX_MS = 60000;
const BRIDGE_PING_INTERVAL_MS = 30000;
const BRIDGE_SILENCE_MS = 75000;
// No onopen within this window → the dial is wedged (e.g. stuck in
// CONNECTING); abandon it and redial. Env override is for tests.
const BRIDGE_DIAL_TIMEOUT_MS = parseInt(process.env.WALNUT_BRIDGE_DIAL_TIMEOUT_MS || '', 10) || 20000;

// Mirror of daemon-core.ts decideBridgeRestart (template can't import).
function decideBridgeRestart(s) {
  if (s.changed) return { restart: true, reason: 'configure' };
  if (!s.enabled) return { restart: false };
  if (s.adapterConnected) return { restart: false };
  if (s.dialAgeMs != null && s.dialAgeMs < s.dialTimeoutMs) return { restart: false };
  if (s.redialPending) {
    // Unknown remaining wait (older caller) → keep the old conservative answer.
    const remaining = s.redialWaitRemainingMs;
    if (remaining == null) return { restart: false };
    if (remaining <= s.dialTimeoutMs) return { restart: false };
  }
  return { restart: true, reason: 'reconcile' };
}

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
  // changed → restart ('configure'). Unchanged but bridge should be up and
  // nothing is working on it → restart ('reconcile') so the Mac's periodic
  // identical push heals a wedged dial.
  const decision = decideBridgeRestart({
    enabled: next.enabled,
    changed,
    adapterConnected: bridgeAdapter != null,
    redialPending: bridgeRedialTimer != null,
    dialAgeMs: bridgeDialStartedAt != null ? Date.now() - bridgeDialStartedAt : null,
    dialTimeoutMs: BRIDGE_DIAL_TIMEOUT_MS,
    redialWaitRemainingMs: bridgeRedialDueAt != null ? bridgeRedialDueAt - Date.now() : null,
  });
  if (decision.restart) startBridge(decision.reason);
  logMsg('info', 'bridge: configured', {
    enabled: next.enabled, hostAlias: next.hostAlias, changed,
    restarted: decision.restart ? decision.reason : false,
  });
  sendOk(ws, id, { applied: true, connected: bridgeAdapter != null });
}

function stopBridge() {
  bridgeGeneration++;
  if (bridgeRedialTimer) { clearTimeout(bridgeRedialTimer); bridgeRedialTimer = null; }
  bridgeRedialDueAt = null;
  if (bridgePingTimer) { clearInterval(bridgePingTimer); bridgePingTimer = null; }
  if (bridgeDialTimer) { clearTimeout(bridgeDialTimer); bridgeDialTimer = null; }
  bridgeDialStartedAt = null;
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
  // One pending redial at a time — a dial-timeout teardown and a late onclose
  // from the same dead socket must not stack two timers.
  if (bridgeRedialTimer) return;
  const jitter = 0.75 + Math.random() * 0.5;
  const delay = Math.round(Math.min(bridgeBackoffMs, BRIDGE_BACKOFF_MAX_MS) * jitter);
  bridgeBackoffMs = Math.min(bridgeBackoffMs * 2, BRIDGE_BACKOFF_MAX_MS);
  bridgeRedialDueAt = Date.now() + delay;
  bridgeRedialTimer = setTimeout(function() {
    bridgeRedialTimer = null;
    bridgeRedialDueAt = null;
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
  bridgeDialStartedAt = Date.now();
  // NOTE: bridgeLastInbound is (re)set in onopen — the silence watchdog only
  // starts there; the pre-open window is covered by the dial timeout below.
  // Dial timeout: no onopen within the window → tear down + redial. A socket
  // wedged in CONNECTING fires neither onopen nor onclose, so without this
  // timer the bridge would stay down forever with zero log lines.
  bridgeDialTimer = setTimeout(function() {
    bridgeDialTimer = null;
    if (gen !== bridgeGeneration || bridgeAdapter != null) return;
    logMsg('warn', 'bridge: dial timeout — abandoning socket', {
      dialMs: bridgeDialStartedAt != null ? Date.now() - bridgeDialStartedAt : null,
    });
    bridgeDialStartedAt = null;
    if (bridgeClient === client) bridgeClient = null;
    try { client.close(); } catch {}
    // Don't rely on close() firing onclose for a wedged socket — schedule
    // directly. scheduleBridgeRedial dedupes if onclose does fire too.
    scheduleBridgeRedial(gen);
  }, BRIDGE_DIAL_TIMEOUT_MS);

  const onOpen = function() {
    if (gen !== bridgeGeneration) { try { client.close(); } catch {} return; }
    if (bridgeDialTimer) { clearTimeout(bridgeDialTimer); bridgeDialTimer = null; }
    bridgeDialStartedAt = null;
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
    // Late close from a socket the dial timeout already abandoned — a newer
    // dial may be in flight; don't clobber its state.
    // LOAD-BEARING with scheduleBridgeRedial's dedupe: after the dial timeout
    // sets bridgeClient=null there is a window where this guard passes
    // (bridgeClient===null) and the late close falls through to
    // scheduleBridgeRedial — only the "if (bridgeRedialTimer) return" dedupe
    // stops a SECOND stacked redial then. Change either side only in tandem.
    if (bridgeClient !== null && bridgeClient !== client) return;
    if (bridgeDialTimer) { clearTimeout(bridgeDialTimer); bridgeDialTimer = null; }
    bridgeDialStartedAt = null;
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
// Cron-armed sessions (/loop): the CLI's in-process scheduler lives in THIS
// process's memory — killing it silently kills the loop. Extended, not
// disabled: the CLI auto-expires recurring crons after 7 days.
const SESSION_CRON_IDLE_KILL_MS = 7 * 24 * 60 * 60 * 1000;   // 7 days
// Sessions with a running background task: wait-style bash tasks write to
// output_file, not the JSONL, so the session looks idle for the task's whole
// lifetime (incident inc-1786222771315). PRINCIPLE: never reap running bg
// work — this 3-day cap exists only for a wedged task framework that will
// never emit a terminal event (immortal-process backstop). See
// daemon-standalone.ts for the full rationale.
const SESSION_BG_IDLE_KILL_MS = 3 * 24 * 60 * 60 * 1000;   // 3 days
const SESSION_SCAN_INTERVAL_MS = 60000;             // every 60s

// Last-resort cron evidence: the CLI scheduler's own debug log in HOME
// (survives /tmp wipes). See daemon-standalone.ts for the full rationale.
const CRON_DEBUG_TAIL_BYTES = 64 * 1024;
function hasRecentSchedulerFiring(sid, withinMs) {
  const debugPath = path.join(os.homedir(), '.claude', 'debug', sid + '.txt');
  let fd;
  try { fd = fs.openSync(debugPath, 'r'); } catch { return false; }
  try {
    const size = fs.fstatSync(fd).size;
    const readLen = Math.min(size, CRON_DEBUG_TAIL_BYTES);
    const buf = Buffer.alloc(readLen);
    fs.readSync(fd, buf, 0, readLen, size - readLen);
    const text = buf.toString('utf-8');
    const cutoff = Date.now() - withinMs;
    const re = /^(\S+) \[DEBUG\] \[ScheduledTasks\] (?:firing|scheduled) /gm;
    let m;
    while ((m = re.exec(text)) !== null) {
      const t = Date.parse(m[1]);
      if (!Number.isNaN(t) && t >= cutoff) return true;
    }
    return false;
  } catch { return false; } finally {
    try { fs.closeSync(fd); } catch {}
  }
}

// Session keep-alive protection: ONE authoritative verdict with a source.
// Every "why is this idle session still alive?" decision flows through here;
// getState exposes the same verdict. New cross-turn CLI state = add ONE
// branch here. Keep in sync with daemon-standalone.ts (full rationale there).
function deriveSessionProtection(session, sid, now) {
  if (Object.keys(session.foldState.cronIds || {}).length > 0) {
    return { source: 'cron', killMs: SESSION_CRON_IDLE_KILL_MS, detail: 'fold' };
  }
  if (session.cwd) {
    // 10-min TTL cache — staleness only delays lift of protection, never a kill.
    if (session.diskCronCache && now - session.diskCronCache.at < 10 * 60000) {
      if (session.diskCronCache.armed) {
        return { source: 'cron', killMs: SESSION_CRON_IDLE_KILL_MS, detail: 'disk-cache' };
      }
    } else {
      var tasksJson = null, lockJson = null;
      try { tasksJson = fs.readFileSync(path.join(session.cwd, '.claude', 'scheduled_tasks.json'), 'utf-8'); } catch {}
      try { lockJson = fs.readFileSync(path.join(session.cwd, '.claude', 'scheduled_tasks.lock'), 'utf-8'); } catch {}
      var disk = hasDiskCronInterest({ sid: sid, tasksJson: tasksJson, lockJson: lockJson, nowMs: now });
      session.diskCronCache = { at: now, armed: disk.armed, reason: disk.reason };
      if (disk.armed) {
        return { source: 'cron', killMs: SESSION_CRON_IDLE_KILL_MS, detail: 'disk:' + (disk.reason || '') };
      }
    }
  }
  // In-process team: lead session polls teammates with no JSONL output.
  if (session.foldState.teamActive) {
    return { source: 'team', killMs: SESSION_BG_IDLE_KILL_MS };
  }
  // Running background task (daemon's OWN taskState) — inc-1786222771315.
  if ((session.taskState && session.taskState.derivedRunning > 0) === true) {
    return { source: 'bg-task', killMs: SESSION_BG_IDLE_KILL_MS };
  }
  // Pending turn-retry: the session is deliberately silent during the backoff
  // (up to 10 min), which reads as "idle" to the reaper. Without this branch the
  // idle kill eats a session that was waiting out an upstream outage, and the
  // retry then fires against a corpse.
  if (session.turnRetryTimer) {
    return { source: 'turn-retry', killMs: SESSION_BG_IDLE_KILL_MS, detail: 'backoff-pending' };
  }
  return { source: null, killMs: SESSION_IDLE_KILL_MS };
}

function scanIdleSessions() {
  const now = Date.now();
  // Embedded code-server rides the same scan: 2h untouched → reap.
  if (vscodeServerCore && vscodeServerCore.reapIdleCodeServer(now)) {
    logMsg('info', 'idle scan: reaped idle code-server', {});
  }
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

    // Feed the age-cleaner watchdog: .pgid is written once at spawn; systemd-
    // tmpfiles' 10-day /tmp age rule would delete it under a long-lived
    // session, breaking re-adopt on daemon restart. Touch it every scan.
    try { const t = new Date(); fs.utimesSync(session.pgidPath, t, t); } catch {}

    // 2. Has at least one subscribed ws? Skip idle check — someone cares.
    if (session.subscribers.size > 0) continue;

    // 3. Check JSONL file mtime
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(session.jsonlPath).mtimeMs; } catch { continue; }

    const idleMs = now - mtimeMs;
    // ONE authoritative verdict with a source — see deriveSessionProtection.
    const prot = deriveSessionProtection(session, sid, now);
    if (idleMs < SESSION_IDLE_WARNING_MS) {
      continue;
    } else if (idleMs < prot.killMs) {
      const idleMinutes = Math.round(idleMs / 60000);
      logMsg('warn', 'idle scan: session idle with no subscribers', { sid, pid, idleMinutes, protectedBy: prot.source, thresholdMs: prot.killMs, detail: prot.detail });
    } else {
      // FINAL CHECK before the irreversible kill: the CLI scheduler's own
      // debug log (HOME, survives /tmp wipes). A recent firing means a live
      // loop the fold failed to see (stream file wiped + rebuild) — refuse.
      if (prot.source !== 'cron' && hasRecentSchedulerFiring(sid, SESSION_IDLE_KILL_MS)) {
        logMsg('warn', 'idle scan: kill vetoed — CLI scheduler debug log shows recent cron firing', { sid, pid, idleMinutes: Math.round(idleMs / 60000) });
        continue;
      }
      const idleMinutes = Math.round(idleMs / 60000);
      logMsg('warn', 'idle scan: killing idle session (no subscribers, no output)', { sid, pid, idleMinutes, protectedBy: prot.source, thresholdMs: prot.killMs, detail: prot.detail });
      // Record the intent BEFORE signalling: the reap arrives asynchronously
      // (the orphan poll sees ESRCH and reports 'orphan-poll-dead', code -1), so
      // by then nothing remembers that WE asked for this. Without the stamp
      // reapSession can only consult the JSONL tail, which says "not a clean turn
      // end" for any session whose last line isn't a type:result — and the
      // projection then shows a red Error for our own routine reclamation.
      // Keep in sync with daemon-standalone.ts scanIdleSessions.
      session.idleReclaimAt = now;
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
          // Watcher starts at the fold rebuild's COMPLETE-line boundary — same
          // rule as registry adopt and attach-discover. 0 would live-fan the
          // whole history and poison the client cursor; a raw stat().size would
          // start mid-line (contract §4 boundary rule). Keep in sync with
          // daemon-standalone.ts.
          const legacyFold = rebuildFoldStateFromJsonl(jsonlPath); // C1
          sessions.set(sid, {
            proc: null,  // no handle — process was started by old daemon.
            pipePath,
            jsonlPath,
            pgidPath,
            pid,
            offset: legacyFold.boundary,
            taskState: rebuildTaskStateFromJsonl(jsonlPath, Date.now()),
            foldState: legacyFold.state,
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

  // Embedded code-server: leave it for successor adoption on production
  // restarts; reap in isolated/test daemons (no successor). Keep in sync with
  // daemon-standalone.ts cleanup().
  if (vscodeServerCore && shouldReapOnExit()) { try { vscodeServerCore.stopCodeServer(); } catch {} }

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
    // C1: flush a pending coalesced snapshot while subscribers are still
    // attached — the last state change of this daemon's life reaches the
    // connected walnut instead of dying inside a 50ms timer. (This twin does
    // not clear the subscriber set in cleanup; the standalone does, and flushes
    // before clearing.) Keep in sync with daemon-standalone.ts cleanup().
    if (session.snapshotTimer) {
      try { pushSnapshot(sid, true); } catch {}
    }
  }
  // Do we still own this daemon dir? A zombie exiting via the heartbeat
  // self-check finds daemon.pid naming its SUCCESSOR — it must touch neither
  // the dir's files nor (crucially) the session process groups the successor
  // has already adopted. Computed BEFORE the reap for exactly that reason.
  let ownsFiles = true;
  try {
    const ownerPid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
    if (ownerPid > 0 && ownerPid !== process.pid) ownsFiles = false;
  } catch {}

  // EXCEPTION — isolated-dir daemons (sandbox/tests/demos): no successor will
  // ever adopt these, so "preserve for adoption" leaks CLI process groups
  // forever. Keep in sync with daemon-standalone.ts.
  if (ownsFiles && shouldReapOnExit()) reapAllSessionGroupsSync();

  try { persistRegistry(); } catch {}
  // Stop all agent subs
  for (const [, sub] of agentSubs) {
    clearInterval(sub.timer);
    clearInterval(sub.rediscoverTimer);
  }
  // Remove port/pid/instance files (so new daemon knows to start fresh).
  // IMPORTANT: Do NOT remove .pgid files here — cleanupOrphanedProcessGroups()
  // on the next daemon needs them to adopt running sessions. See that function above.
  if (ownsFiles) {
    try { fs.unlinkSync(PORT_FILE); } catch {}
    try { fs.unlinkSync(PID_FILE); } catch {}
    try { fs.unlinkSync(INSTANCE_ID_FILE); } catch {}
    try { fs.unlinkSync(VERSION_FILE); } catch {}
    // Agent gateway artifacts — a zombie must never delete its successor's
    // live socket/shim, hence inside the ownsFiles guard. Keep in sync with
    // daemon-standalone.ts cleanup().
    try { fs.unlinkSync(GATEWAY_SOCK_PATH); } catch {}
    try { fs.unlinkSync(GATEWAY_SHIM_PATH); } catch {}
    try { fs.unlinkSync(path.join(GATEWAY_SHIM_DIR, 'wn')); } catch {} // retired alias, older daemons wrote it
  }
  logMsg('info', 'daemon cleanup complete', { uptimeSec: Math.floor((Date.now() - DAEMON_START_TS) / 1000) });
}

// ── Main ──
const action = process.argv[2];

// CLI mode: the deployed daemon.cjs doubles as the on-host walnut CLI (the
// on-PATH walnut is a 2-line shim exec'ing node + this file). BOTH keywords
// dispatch here: 'walnut' is canonical, 'wn' is a deprecated compat alias that
// MUST stay because shims written by daemons already deployed in the field pass
// 'wn', and a shim is only rewritten when its own daemon next boots. Async — the
// socket handlers inside runWnMinimal call process.exit; the final usage branch
// below must NOT fire for either keyword. Keep in sync with daemon-standalone.ts.
var isDaemonCliKeyword = function (a) { return a === 'walnut' || a === 'wn'; };
if (isDaemonCliKeyword(action)) {
  runWnMinimal(process.argv.slice(3));
}

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

  ensureOwnerOnlyStorage();

  // Move dead-session stream files from legacy /tmp to the HOME dir BEFORE
  // reconcile (adopted sessions resolve files by registry absolute paths).
  try { migrateLegacyStreams(); } catch (err) {
    logMsg('error', 'legacy streams migration failed', { error: err.message });
  }

  // Daemon hooks: restore the last pushed rules (or the legacy env synth)
  // BEFORE reconcile — session.reap during reconcile must see them.
  loadDaemonHooksAtBoot();

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

  // Agent gateway: second (unix-socket) listener + on-PATH walnut shim. Both
  // additive — failures log a warning and never abort daemon startup.
  // Keep in sync with daemon-standalone.ts --start.
  startGatewayListener();
  writeWalnutShim();

  // Listen on random port (localhost only)
  httpServer.listen(0, '127.0.0.1', () => {
    const port = httpServer.address().port;
    fs.writeFileSync(PORT_FILE, String(port));
    fs.writeFileSync(PID_FILE, String(process.pid));
    fs.writeFileSync(INSTANCE_ID_FILE, DAEMON_INSTANCE_ID);
    fs.writeFileSync(VERSION_FILE, DAEMON_VERSION);
    console.log(port); // Print port for parent to capture
    // turnRetry: read from env ONCE at boot, so this line is the only way to
    // answer "is this daemon retrying, and with what budget?" without shell
    // access to its environ. Keep in sync with daemon-standalone.ts.
    logMsg('info', 'daemon started', { port, pid: process.pid, startedAt: DAEMON_START_TS,
      turnRetry: TURN_RETRY_CFG.enabled
        ? { budgetMs: TURN_RETRY_CFG.budgetMs, maxAttempts: TURN_RETRY_CFG.maxAttempts,
            backoffBaseMs: TURN_RETRY_CFG.backoffBaseMs, backoffMaxMs: TURN_RETRY_CFG.backoffMaxMs }
        : false });

    // Start session idle scanner (every 60s)
    setInterval(scanIdleSessions, SESSION_SCAN_INTERVAL_MS);

    // Dead-stream retention: hourly; first pass after reconcile settles.
    setTimeout(sweepDeadStreams, 60000);
    setInterval(sweepDeadStreams, STREAM_RETENTION_SWEEP_MS);

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
      // Parent-liveness watchdog: isolated-dir daemons (tests, sandbox, demos)
      // carry WALNUT_DAEMON_PARENT_PID and must die with their one walnut
      // process — detached spawn means nothing else reaps them (300+ orphans
      // starved the machine, 2026-07-23). Production daemons never get the
      // var. Keep in sync with daemon-standalone.ts heartbeat (CLAUDE.md).
      if (WATCHDOG_PARENT_PID) {
        let parentAlive = true;
        try { process.kill(WATCHDOG_PARENT_PID, 0); } catch { parentAlive = false; }
        if (!parentAlive) {
          logMsg('warn', 'parent-liveness watchdog: parent process gone — exiting', {
            parentPid: WATCHDOG_PARENT_PID,
          });
          cleanup();
          process.exit(0);
        }
      }
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
} else if (!isDaemonCliKeyword(action)) {
  // Both CLI keywords are handled above (async — neither must fall into this
  // usage error). 'wn' is the deprecated alias kept for shims in the field.
  console.error('Usage: node daemon.js --start | --stop | --status | walnut <args...>');
  process.exit(1);
}
`;
