/**
 * Cloud exec — the decision core that turns the cloud companion from a pure
 * RELAY into a real execution host, so the phone can still start and continue
 * work while the Mac is asleep or offline.
 *
 * ## The one-line model
 *
 * The cloud box runs THE SAME session daemon every other exec host runs, on
 * loopback, and spawns `claude` on itself. It does NOT get a second, cloud-
 * special session implementation on the server (CLAUDE.md: "host-local work
 * belongs to the DAEMON, not the server").
 *
 * ## Transport: loopback. Not SSH, not the bridge.
 *
 * Every other host is reached over an SSH tunnel (Mac → remote daemon) or the
 * dialed-out `/bridge` socket (daemon → cloud). The cloud box reaching its OWN
 * daemon needs neither: server and daemon are the same machine, so it uses the
 * identical path the Mac uses for its own daemon — `localDaemon.ensureRunning()`
 * then `ws://localhost:<port>` (providers/local-daemon.ts, and the `__local__`
 * fast-path in DaemonConnection.connect). Consequences worth stating:
 *
 *  - **No new deploy mechanism, and no manual scp.** The chunked/gzipped
 *    auto-deploy exists because SSH proxies kill large transfers; there is no
 *    transfer here. `npm run build` on the cloud box already runs
 *    scripts/build-daemon.sh (which is the only reason setup.sh installs bun),
 *    so dist/daemon-binaries/daemon-linux-<arch> is present and
 *    pickDaemonBinary() finds it by exact platform-arch name.
 *  - **The cloud box must never dial its own bridge.** cloud-bridge-config.ts
 *    already returns `{enabled:false}` under CLOUD_MODE; that stays. A self-
 *    bridge would loop the box's own RPCs back into itself.
 *  - The `/bridge` allowlist (BRIDGE_ALLOWED_COMMANDS in the daemon twins) is
 *    untouched. Its whole point — "a compromised cloud box must never get
 *    arbitrary argv on an EXEC HOST" — is about the cloud reaching OTHER hosts.
 *    Running on itself is a different question, answered below.
 *
 * ## Auth: what authenticates a spawn here
 *
 * Three layers, all pre-existing, which is why this does not open an RCE hole:
 *
 *  1. **The daemon is loopback-only.** It binds 127.0.0.1 (daemon-standalone.ts
 *     `hostname: '127.0.0.1'`), Caddy reverse-proxies only :3456, and nothing
 *     forwards the daemon's ephemeral port. It is not reachable from the
 *     internet at all.
 *  2. **Every cloud HTTP request needs a device Bearer token.** In CLOUD_MODE
 *     the private-network auth bypass is disabled (web/middleware/auth.ts), so
 *     the only door to a spawn is an authenticated API call.
 *  3. **Opt-in, with an explicit cwd sandbox.** Default is OFF. A device-token
 *     holder could already relay a spawn to the Mac, so this grants no new
 *     *identity* any new authority — but an internet-facing box that silently
 *     became an exec host is a posture change the operator did not ask for, so
 *     it takes `cloud.exec.enabled: true` plus at least one `cwd_roots` entry.
 *     No roots configured = feature stays off, loudly (see `cloudExecStatus`).
 *
 * ## Data ownership: PEER for execution, REPLICA for data, disjoint keyspace
 *
 * The cloud box CANNOT publish a session row to the Mac and must not try:
 * sessions.sqlite is gitignored, `sessions/projection.json` has exactly one
 * writer (the exporter is behind `if (!CLOUD_MODE)`), and that file carries no
 * `lastUpdated` content clock — so if both boxes wrote it, git-sync's LWW would
 * fall through to commit-time (the phase of each box's 30s tick, not data
 * freshness) and replace a whole 500-session list wholesale. That is the exact
 * shape of the 2026-08-23 incident the content-clock exists to prevent.
 *
 * So there is no write conflict, by construction: the cloud box keeps its own
 * sessions in its own local (gitignored) registry and NEVER writes the Mac's
 * projection. The two halves meet only at READ time, on the box that owns both
 * (`unionOwnedSessions` below) — a local merge, never a distributed write. Ids
 * are UUIDs, so the keyspaces cannot collide.
 *
 * ## Host selection: explicit choice, never a silent fallback
 *
 * The cloud box appears as its OWN host (`CLOUD_HOST_ALIAS`) in the launcher's
 * host list. An absent/empty `host` keeps meaning "the primary box" and is
 * relayed exactly as today — it must never quietly become the cloud box, since
 * running work on the wrong machine is worse than an honest error. When the
 * primary is unreachable, `launchOptionsWhenPrimaryOffline` answers locally
 * with the cloud host plus `primaryOffline: true`, which is the data a client
 * needs to ask "the Mac is offline — run this on the cloud companion?" instead
 * of failing with a bare 503.
 */

import path from 'node:path';
import os from 'node:os';
import type { Config } from './types.js';

/**
 * Host alias for "the cloud companion itself".
 *
 * Deliberately NOT `''`/`__local__`: on the cloud box those already mean "the
 * primary box" throughout the projection and relay code (ProjectedSession.host
 * `''` → `__local__`), and overloading them is how a launch would silently run
 * on the wrong machine. The double-underscore form matches `__local__`'s
 * convention and cannot collide with a config.hosts alias (SSH aliases don't
 * look like this, and `assertNotReservedHostAlias` rejects it if one tries).
 */
export const CLOUD_HOST_ALIAS = '__cloud__';

/** Label shown in the launcher's host picker. */
export const CLOUD_HOST_LABEL = 'Cloud companion';

/**
 * Concurrency cap for CLI sessions on the cloud box. Low on purpose: the
 * reference companion is a 2-vCPU / 2GB instance (setup.sh adds a 2GB swapfile
 * just to get `vite build` through), and one `claude` CLI is heavy. The generic
 * per-host defaults (local=7) would swap-thrash the box into unresponsiveness,
 * which on a single-box deploy also takes the HTTP API down with it.
 */
export const CLOUD_EXEC_DEFAULT_MAX_SESSIONS = 2;

export interface CloudExecConfig {
  enabled: boolean;
  /** Absolute, `~`-expanded directory roots a cloud session may run inside. */
  cwdRoots: string[];
  maxSessions: number;
}

/**
 * Why cloud exec is off, when it is off. Surfaced by `/api/v1/status` so the
 * operator sees a reason instead of a silently missing host — a feature that
 * is off because it was never configured and one that is off because its
 * config is unusable are different problems.
 */
export type CloudExecDisabledReason =
  | 'not_cloud_mode'
  | 'not_enabled'
  | 'no_cwd_roots'
  | 'cwd_roots_not_absolute';

export interface CloudExecStatus {
  enabled: boolean;
  reason?: CloudExecDisabledReason;
  maxSessions?: number;
  /** Root count only — the paths themselves are machine-local detail. */
  cwdRootCount?: number;
}

/**
 * Expand a leading `~` and normalize. Pure: `home` is a parameter so tests
 * don't depend on the runner's HOME.
 */
function expandRoot(root: string, home: string): string {
  let out = root.trim();
  if (out === '~') out = home;
  else if (out.startsWith('~/')) out = path.join(home, out.slice(2));
  return path.normalize(out);
}

/**
 * Read the effective cloud-exec config. `cloudMode` is a parameter (not the
 * CLOUD_MODE import) so the whole module stays pure and unit-testable without
 * an env dance — callers pass the constant.
 */
export function readCloudExecConfig(
  config: Pick<Config, 'cloud'> | undefined,
  cloudMode: boolean,
  home: string = os.homedir(),
): CloudExecConfig {
  const raw = config?.cloud?.exec;
  const rawRoots: unknown[] = Array.isArray(raw?.cwd_roots) ? raw!.cwd_roots! : [];
  const cwdRoots = rawRoots
    .filter((r): r is string => typeof r === 'string' && r.trim() !== '')
    .map((r: string) => expandRoot(r, home))
    // Relative roots are dropped rather than resolved against process.cwd():
    // a sandbox root whose meaning depends on where the server was launched
    // from is not a sandbox. `cloudExecStatus` reports the resulting emptiness.
    .filter((r) => path.isAbsolute(r));
  const maxRaw = raw?.max_sessions;
  const maxSessions = typeof maxRaw === 'number' && Number.isInteger(maxRaw) && maxRaw > 0
    ? maxRaw
    : CLOUD_EXEC_DEFAULT_MAX_SESSIONS;
  return {
    enabled: cloudMode && raw?.enabled === true && cwdRoots.length > 0,
    cwdRoots,
    maxSessions,
  };
}

/** Diagnostic form of the above — the `/api/v1/status` payload. */
export function cloudExecStatus(
  config: Pick<Config, 'cloud'> | undefined,
  cloudMode: boolean,
  home: string = os.homedir(),
): CloudExecStatus {
  if (!cloudMode) return { enabled: false, reason: 'not_cloud_mode' };
  const raw = config?.cloud?.exec;
  if (raw?.enabled !== true) return { enabled: false, reason: 'not_enabled' };
  const resolved = readCloudExecConfig(config, cloudMode, home);
  if (resolved.cwdRoots.length === 0) {
    const declared = Array.isArray(raw.cwd_roots) ? raw.cwd_roots.length : 0;
    // Distinguish "you forgot the roots" from "your roots were unusable" —
    // the second is a typo the operator can only find if we say so.
    return { enabled: false, reason: declared > 0 ? 'cwd_roots_not_absolute' : 'no_cwd_roots' };
  }
  return { enabled: true, maxSessions: resolved.maxSessions, cwdRootCount: resolved.cwdRoots.length };
}

/**
 * Is `cwd` inside one of the configured roots?
 *
 * Containment is checked on NORMALIZED ABSOLUTE paths with a separator-anchored
 * prefix — never a bare substring. Two traps this encodes (both from the
 * path-resolver family of bugs in CLAUDE.md):
 *
 *  - A substring check makes `/srv/work-secrets` look like it lives under
 *    `/srv/work`. The `root + sep` anchor is what makes it a SEGMENT boundary.
 *  - `path.normalize` is what collapses `..`, so it must run BEFORE the
 *    containment test, never after: any rule that can delete a `..` has to
 *    precede the safety check, or `/srv/work/../etc` reads as contained.
 *
 * Not resolved: symlinks. That needs I/O, and this decision runs on the request
 * path. The contract is therefore explicit — a `cwd_roots` entry must be a
 * directory the operator controls and that contains no symlink pointing out of
 * it. The daemon's own guards are not a substitute here (its realpath denylist
 * covers the BRIDGE surface, which this path does not use).
 */
export function isCwdWithinRoots(cwd: string, roots: string[], home: string = os.homedir()): boolean {
  if (typeof cwd !== 'string' || cwd.trim() === '') return false;
  const abs = expandRoot(cwd, home);
  if (!path.isAbsolute(abs)) return false;
  for (const root of roots) {
    if (abs === root) return true;
    if (abs.startsWith(root.endsWith(path.sep) ? root : root + path.sep)) return true;
  }
  return false;
}

/**
 * Where should a launch for `host` actually run, as seen from THIS box?
 *
 *  - `run-here`  — spawn on this box through its own local daemon.
 *  - `relay`     — hand the whole launch to the primary (today's behavior).
 *  - `refused`   — the caller asked for the cloud host and it can't serve it;
 *                  say why rather than quietly running somewhere else.
 *
 * The `undefined`/`''` case is the important one: it keeps meaning "the primary
 * box" and is relayed. Making it fall back to the cloud box when the Mac is
 * offline is exactly the silent-wrong-host failure this design refuses.
 */
export type CloudExecTarget =
  | { kind: 'run-here' }
  | { kind: 'relay' }
  | { kind: 'refused'; reason: CloudExecDisabledReason | 'cwd_not_allowed'; message: string };

export function resolveLaunchTarget(
  host: string | undefined,
  cwd: string,
  config: Pick<Config, 'cloud'> | undefined,
  cloudMode: boolean,
  home: string = os.homedir(),
): CloudExecTarget {
  if (host !== CLOUD_HOST_ALIAS) return { kind: 'relay' };
  const status = cloudExecStatus(config, cloudMode, home);
  if (!status.enabled) {
    return {
      kind: 'refused',
      reason: status.reason ?? 'not_enabled',
      message: cloudExecRefusalMessage(status.reason ?? 'not_enabled'),
    };
  }
  const { cwdRoots } = readCloudExecConfig(config, cloudMode, home);
  if (!isCwdWithinRoots(cwd, cwdRoots, home)) {
    return {
      kind: 'refused',
      reason: 'cwd_not_allowed',
      // The allowed roots are NOT echoed: this message crosses to an
      // internet-facing client, and the box's directory layout is not its
      // business. The operator sees the roots in their own config.
      message: `Working directory is not inside an allowed cloud-exec root: ${cwd}`,
    };
  }
  return { kind: 'run-here' };
}

export function cloudExecRefusalMessage(reason: CloudExecDisabledReason): string {
  switch (reason) {
    case 'not_cloud_mode':
      return 'This box is not a cloud companion — use the primary box or a configured host';
    case 'not_enabled':
      return 'The cloud companion is not configured to run sessions (set cloud.exec.enabled)';
    case 'no_cwd_roots':
      return 'The cloud companion has no allowed working-directory roots (set cloud.exec.cwd_roots)';
    case 'cwd_roots_not_absolute':
      return 'The cloud companion\'s cloud.exec.cwd_roots contains no usable absolute path';
  }
}

/**
 * Translate an API-edge host alias into the value the session core expects.
 *
 * This is the trick that keeps the spawn path untouched: `CLOUD_HOST_ALIAS` is
 * a PRESENTATION concept that exists only at the HTTP edge. Handed to the
 * launch core as `undefined`, everything downstream already does the right
 * thing — quickStartSession → SESSION_START → handleStart resolves no
 * sshTarget → createSessionManager routes to the local daemon. No new branch in
 * claude-code-session.ts / session-manager.ts, and therefore no new way for the
 * generic local path to regress.
 */
export function launchHostForCore(host: string | undefined): string | undefined {
  return host === CLOUD_HOST_ALIAS ? undefined : host;
}

/** The launcher's host row for this box, or null when it can't execute. */
export function cloudExecHostEntry(
  config: Pick<Config, 'cloud'> | undefined,
  cloudMode: boolean,
  home: string = os.homedir(),
): { alias: string; label: string } | null {
  if (!readCloudExecConfig(config, cloudMode, home).enabled) return null;
  return { alias: CLOUD_HOST_ALIAS, label: CLOUD_HOST_LABEL };
}

/**
 * Launch options the cloud box can answer BY ITSELF when the primary's bridge
 * is down. Today that request relays and 503s, so "the Mac is asleep" presents
 * as "you cannot start anything" with no explanation and no alternative.
 *
 * Only the cloud host is offered: the Mac's own host list and frequent-dirs
 * live on the Mac, and inventing entries for machines we cannot reach would be
 * a confident wrong answer. `primaryOffline` is the flag a client turns into
 * "the Mac is offline — run this on the cloud companion?".
 *
 * Returns null when this box cannot execute either — the caller then keeps its
 * honest 503, because there is genuinely nothing to offer.
 */
export function launchOptionsWhenPrimaryOffline(
  config: Pick<Config, 'cloud'> | undefined,
  cloudMode: boolean,
  home: string = os.homedir(),
): { hosts: Array<{ alias: string; label: string }>; dirs: never[]; primaryOffline: true; degraded: true } | null {
  const entry = cloudExecHostEntry(config, cloudMode, home);
  if (!entry) return null;
  return { hosts: [entry], dirs: [], primaryOffline: true, degraded: true };
}

/**
 * Read-side union of the Mac's projected sessions and the sessions THIS cloud
 * box owns. The only place the two halves meet, and deliberately a local merge
 * rather than any kind of shared write (see the data-ownership note above).
 *
 * Own rows are re-tagged to `CLOUD_HOST_ALIAS`: a locally-created record stores
 * `host: ''`, which everywhere else in the projection vocabulary means "the
 * primary box". Shipping that verbatim would tell the phone a cloud session
 * lives on the Mac, and its next send would be relayed to the wrong machine.
 *
 * Projection rows win on id collision. That cannot happen with UUID ids, but if
 * it ever did, the Mac is the box that owns lifecycle and its answer is the one
 * to trust.
 */
export function unionOwnedSessions<P extends { id: string; host: string }, O extends { id: string }>(
  projected: P[],
  owned: O[],
): Array<P | (O & { host: string })> {
  const seen = new Set(projected.map((s) => s.id));
  const tagged = owned
    .filter((s) => !seen.has(s.id))
    .map((s) => ({ ...s, host: CLOUD_HOST_ALIAS }));
  return [...projected, ...tagged];
}

/**
 * Guard for config load: a user-defined SSH host must not shadow the reserved
 * aliases. `__local__` was already de-facto reserved; `__cloud__` joins it.
 * Returns the offending aliases so the caller can warn (never throw — an
 * unusable host entry must not take the whole config down).
 */
export function reservedHostAliasConflicts(aliases: Iterable<string>): string[] {
  const reserved = new Set(['__local__', CLOUD_HOST_ALIAS]);
  return [...aliases].filter((a) => reserved.has(a));
}

/**
 * Per-host session limits with the cloud cap folded in. Applied as a FLOOR-less
 * override on purpose: an operator who set `session_limits.__cloud__` meant it,
 * but the default must be the small cloud number, not the generic local=7 that
 * would swap-thrash a 2GB box.
 */
export function cloudSessionLimits(
  config: Pick<Config, 'cloud' | 'session_limits'> | undefined,
  cloudMode: boolean,
  home: string = os.homedir(),
): Record<string, number> {
  const limits = { ...(config?.session_limits ?? {}) };
  const exec = readCloudExecConfig(config, cloudMode, home);
  if (!exec.enabled) return limits;
  // The cloud box spawns through its LOCAL daemon, so the limit the tracker
  // consults is the 'local' key — the alias is edge-only (launchHostForCore).
  if (limits.local === undefined) limits.local = exec.maxSessions;
  return limits;
}
