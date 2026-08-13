/**
 * Terminal spawn — the ONLY place that knows where terminal bytes come from.
 *
 * Returns an `IPty` handle for a session's shell. The shell runs under `dtach`
 * (a ~50KB detach/attach tool) on the target host so it survives ssh/server
 * death WITHOUT taking over the terminal the way tmux does:
 *   - local:  node-pty spawns `dtach -A <socket> -z -E ... <$SHELL> -l`
 *   - remote: node-pty spawns `ssh -tt <host> 'cd <cwd> && exec dtach -A ... "$SHELL" -l'`
 *
 * The shell is the user's DEFAULT $SHELL launched as a LOGIN shell (`-l`), so
 * the embedded terminal feels exactly like opening tmux on that host: the full
 * startup chain loads (zsh: ~/.zprofile + ~/.zlogin for PATH, ~/.zshrc for
 * aliases; bash: ~/.bash_profile→~/.bashrc), so every alias and PATH entry from
 * the user's normal interactive terminal is present. (Earlier we exec'd a bare
 * non-login `bash`, which sourced none of that — the "weird shell with no
 * aliases" report. tmux's default-command is a LOGIN shell; we now match it.)
 *
 * Why dtach instead of tmux:
 *   - dtach does ONE thing — detach/reattach a pty — and does NOT create an
 *     alternate screen, status bar, or mouse-grabbing copy-mode. So the browser
 *     xterm.js keeps its OWN scrollback: the scroll wheel scrolls natively and
 *     drag-select + copy work natively. tmux grabbed the mouse (the `^[[A`
 *     "won't scroll / can't copy" bug) and needed version-specific mouse-mode
 *     hacks; dtach has none of that.
 *   - dtach `-A <socket>` is idempotent (attach if the socket exists, else
 *     create + run the command), exactly like `tmux new-session -A`, so a
 *     reconnect re-attaches the same shell with state (cwd/env/running process)
 *     intact. Verified on a real remote host: a counter kept ticking with NO
 *     ssh connected, and cwd/env survived across independent reconnects.
 *
 * The upper layers (TerminalManager / ring buffer / RPC) only see `IPty` — to
 * change transport you only touch this file.
 */

import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import type { IPty } from '@homebridge/node-pty-prebuilt-multiarch'
import type { SessionRecord } from '../../core/types.js'
import type { SshTarget } from '../../providers/session-io.js'
import { shellQuote } from '../../providers/session-io.js'
import { getConfig } from '../../core/config-manager.js'
import { DTACH_SOCKET_DIR } from '../../constants.js'
import { log } from '../../logging/index.js'
import { remoteDtachPath, localDtachPath } from './dtach-provision.js'

/**
 * SSH ControlMaster args shared by the dtach probe/provision AND the terminal
 * spawn for a host. WHY: a fresh SSH connection to a remote dev host behind a
 * proxy can cost 2-21s (highly variable). Without muxing, the probe pays that
 * once and the spawn pays it AGAIN moments later. With a shared ControlPath the
 * probe establishes the master connection and the spawn reuses it instantly
 * (ControlPersist keeps it warm). Same pattern the session daemon uses.
 *
 * `host` is the alias — one socket per alias, stable across probe+spawn+reaper.
 */
export function sshControlMasterArgs(host: string): string[] {
  const socket = path.join(os.tmpdir(), `walnut-term-ssh-${host}`)
  return [
    '-o', 'ControlMaster=auto',
    '-o', `ControlPath=${socket}`,
    '-o', 'ControlPersist=120',
  ]
}

export interface SpawnResult {
  pty: IPty
  /** Resolved working directory (for diagnostics). */
  cwd?: string
  /** Host alias when remote, undefined for local. */
  host?: string
}

/**
 * Directory holding the per-session dtach unix sockets, one per terminal:
 * `<dir>/walnut-<sessionId>.dsock`. A dedicated dir makes the orphan reaper a
 * simple readdir + compare against the session registry.
 *
 * Re-exported from constants (LOG_DIR/term) so it is isolated per instance in
 * lockstep with the session registry — see the DTACH_SOCKET_DIR doc comment in
 * constants.ts for why a machine-global literal here let one instance's reaper
 * kill another instance's live terminals.
 *
 * NOTE (remote hosts): this LOCAL path is also used verbatim as the socket path
 * ON the remote host (the ssh command interpolates it, and `mkdir -p`s it there).
 * So a walnut whose LOG_DIR is overridden creates that same dir on the remote
 * box. That's coherent — an isolated instance stays isolated on both ends — but
 * it means the remote path is chosen by the LOCAL env, not the remote one. Fine
 * today (only local test/demo instances override LOG_DIR, and a test instance is
 * now gated out of reaping anyway); revisit if remote-specific dirs are ever
 * needed.
 */
export { DTACH_SOCKET_DIR }

/**
 * Stable dtach socket path derived from the Claude session ID.
 *
 * The path is interpolated UNQUOTED into remote `ssh ... 'dtach -A <path>'`
 * command strings, so the session id must contain no shell metacharacters.
 * Claude session IDs are UUIDs (hex + dashes); we fail fast on anything outside
 * `[A-Za-z0-9_-]` rather than silently building an injectable command.
 */
export function dtachSocketPath(sessionId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
    throw new Error(`Unsafe session id for dtach socket: ${JSON.stringify(sessionId)}`)
  }
  return `${DTACH_SOCKET_DIR}/walnut-${sessionId}.dsock`
}

/**
 * Resolve a host alias to an SshTarget via config.hosts.
 * Throws if the alias is unknown.
 */
export async function resolveSshTarget(host: string): Promise<SshTarget> {
  const config = await getConfig()
  const def = config.hosts?.[host]
  if (!def) throw new Error(`Unknown host: ${host}`)
  if (!def.hostname) throw new Error(`Host "${host}" has no hostname`)
  return { hostname: def.hostname, user: def.user, port: def.port, shell_setup: def.shell_setup }
}

function sshHostString(t: SshTarget): string {
  return t.user ? `${t.user}@${t.hostname}` : t.hostname
}

/** SSH options shared by terminal connections: batch mode + keepalive. */
function sshKeepaliveArgs(t: SshTarget): string[] {
  const args = [
    '-tt', // force remote PTY allocation
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
  ]
  if (t.port) args.push('-p', String(t.port))
  return args
}

/**
 * The dtach argv (shared shape for local + remote). `-A <socket> <cmd...>`:
 * attach to the socket if it exists, else create it and run the login shell.
 *
 *   -z  disable dtach's suspend-key handling — Ctrl-Z should reach the shell,
 *       not dtach.
 *   -E  disable dtach's detach character (default Ctrl-\). We detach by closing
 *       the ssh/pty connection (WS disconnect), never by a keystroke, so the
 *       user's Ctrl-\ must pass through to the program.
 *   -r winch  on reattach, send SIGWINCH so the program redraws at the new
 *       size. dtach does NOT repaint a saved screen (it has no alternate
 *       screen) — this nudges full-screen programs to redraw; line-based shells
 *       just continue. The browser-side scrollback lives in xterm.js.
 *
 * `dtachBin` is the resolved dtach path (provisioned per host). `shell` is the
 * user's default shell; we pass `-l` so dtach execs it as a LOGIN shell (loads
 * the full ~/.zprofile→~/.zshrc / ~/.bash_profile→~/.bashrc chain → PATH +
 * aliases present, matching tmux). On REATTACH dtach ignores the command, so
 * `-l` (like cwd) only takes effect on first create — exactly what we want.
 */
export function buildDtachArgs(dtachBin: string, sessionId: string, shell: string): string[] {
  const sock = dtachSocketPath(sessionId)
  return [dtachBin, '-A', sock, '-z', '-E', '-r', 'winch', shell, '-l']
}

/**
 * Default remote shell expression. NOT shell-quoted: it is meant to be expanded
 * BY the remote shell, so the login user's actual shell (from the passwd entry,
 * which sshd exports as $SHELL — verified `/bin/zsh` on our dev hosts) is used,
 * exactly like tmux picks the user's shell. Falls back to bash if unset. It is
 * a fixed literal we author (no user input), so emitting it unquoted is safe.
 */
const REMOTE_DEFAULT_SHELL = '"${SHELL:-/bin/bash}"'

/**
 * The remote command run over ssh: ensure the socket dir exists, cd to the
 * session cwd, then exec dtach. The cwd is set by `cd` (a NEW dtach session
 * inherits the launching shell's cwd; on REATTACH dtach keeps the existing
 * pane's cwd, so the `cd` is harmless). `exec` replaces the shell so the ssh
 * process becomes dtach directly (clean signal handling).
 *
 * `shell` defaults to the remote `$SHELL` (expanded remotely) and is launched
 * with `-l` so it's a LOGIN shell — the embedded terminal then loads the user's
 * full startup chain (PATH + aliases), matching tmux. A caller MAY pass an
 * explicit shell token (already shell-safe) to override.
 */
export function buildRemoteDtachCommand(dtachBin: string, sessionId: string, shell: string = REMOTE_DEFAULT_SHELL, cwd?: string): string {
  const sock = dtachSocketPath(sessionId)
  const mkdir = `mkdir -p ${shellQuote(DTACH_SOCKET_DIR)}`
  // `-l` → login shell. `shell` is either our unquoted REMOTE_DEFAULT_SHELL
  // (must expand remotely) or an explicit safe token, so it is NOT re-quoted.
  const dtach = `exec ${shellQuote(dtachBin)} -A ${shellQuote(sock)} -z -E -r winch ${shell} -l`
  const body = cwd ? `cd ${shellQuote(cwd)} && ${dtach}` : dtach
  return `${mkdir}; ${body}`
}

/** Full ssh argv for a remote terminal. `host` (alias) keys the shared
 * ControlMaster socket so the probe's warm connection is reused here. */
export function buildRemoteSshArgs(
  dtachBin: string,
  sessionId: string,
  target: SshTarget,
  shell: string = REMOTE_DEFAULT_SHELL,
  cwd?: string,
  host?: string,
): string[] {
  return [
    ...sshKeepaliveArgs(target),
    ...(host ? sshControlMasterArgs(host) : []),
    sshHostString(target),
    buildRemoteDtachCommand(dtachBin, sessionId, shell, cwd),
  ]
}

/** The local shell to launch inside dtach: the user's default $SHELL (the
 * server inherits it from the launching terminal), falling back to bash.
 * `buildDtachArgs` appends `-l` so it runs as a login shell. */
function localShell(): string {
  return process.env.SHELL || '/bin/bash'
}

/**
 * Prewarm a remote host so a later `terminal:open` is fast. The entire cost of
 * opening a remote terminal is the FIRST ssh connection (measured ~2.5s to
 * establish the ControlMaster through the proxy); subsequent ssh calls reuse
 * that master in ~0.2s. So we warm two things ahead of the click:
 *   1. the shared ControlMaster connection (the expensive part), and
 *   2. dtach provisioning (probe/build), which is memoized per host.
 *
 * `remoteDtachPath()` already does an ssh round-trip over the SAME shared
 * ControlMaster socket the real spawn uses, so calling it here BOTH provisions
 * dtach AND leaves a warm master connection behind (ControlPersist keeps it
 * alive ~120s). Local sessions need no prewarm (no ssh; ~0.02s to open), so
 * this is a no-op for them. Best-effort — failures just mean the open pays the
 * cold cost as before. Idempotent: dtach provisioning is memoized.
 */
export async function prewarmRemoteHost(host: string | undefined): Promise<void> {
  if (!host) return // local: nothing to warm
  try {
    await remoteDtachPath(host) // warms ControlMaster + provisions dtach (memoized)
    log.web.info('terminal prewarm complete', { host })
  } catch (err) {
    // Non-fatal: the real open will surface NO_DTACH / connection errors itself.
    log.web.debug('terminal prewarm failed (open will retry)', { host, error: String(err) })
  }
}

/**
 * Spawn a terminal pty for a session record. Local → dtach; remote → ssh→dtach.
 * `node-pty` is imported lazily so a native-binary load failure can be caught
 * by the caller and degrade gracefully (terminal disabled, server stays up).
 *
 * Assumes dtach is already provisioned on the target (the RPC layer runs the
 * probe/provision before calling this).
 */
export async function resolveSpawnForSession(
  record: SessionRecord,
  cols: number,
  rows: number,
): Promise<SpawnResult> {
  const pty = await import('@homebridge/node-pty-prebuilt-multiarch')
  const env = { ...process.env, TERM: 'xterm-256color' } as Record<string, string>

  if (record.host) {
    const target = await resolveSshTarget(record.host)
    const dtachBin = await remoteDtachPath(record.host)
    // Remote shell: let buildRemoteSshArgs default to the remote `$SHELL` (the
    // login user's actual shell from passwd, e.g. zsh) launched as a LOGIN
    // shell. This loads the full startup chain (PATH + aliases) so the embedded
    // terminal matches what the user sees in tmux — not a bare aliasless bash.
    const args = buildRemoteSshArgs(dtachBin, record.claudeSessionId, target, undefined, record.cwd, record.host)
    log.web.info('terminal spawn (remote/dtach)', { sessionId: record.claudeSessionId, host: record.host, cwd: record.cwd })
    const p = pty.spawn('ssh', args, { name: 'xterm-256color', cols, rows, cwd: os.homedir(), env })
    return { pty: p, cwd: record.cwd, host: record.host }
  }

  const cwd = record.cwd ?? os.homedir()
  const dtachBin = await localDtachPath()
  // Ensure the dtach socket dir exists locally (the remote path mkdir -p's it in
  // the ssh command; locally we create it here before spawning).
  try { fs.mkdirSync(DTACH_SOCKET_DIR, { recursive: true }) } catch { /* best-effort */ }
  const args = buildDtachArgs(dtachBin, record.claudeSessionId, localShell())
  log.web.info('terminal spawn (local/dtach)', { sessionId: record.claudeSessionId, cwd })
  // Start dir comes from node-pty's cwd option (a new dtach session inherits
  // the launching process's cwd).
  const p = pty.spawn(dtachBin, args.slice(1), { name: 'xterm-256color', cols, rows, cwd, env })
  return { pty: p, cwd }
}
