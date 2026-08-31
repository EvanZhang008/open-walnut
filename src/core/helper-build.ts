/**
 * Shared build pipeline for the native macOS helpers in src/data/*.swift.
 *
 * Walnut ships four tiny Swift programs because some macOS capabilities are only
 * reachable from native code, and because a capability that needs a TCC
 * permission should hold that permission ALONE rather than handing it to the
 * process that runs agent sessions:
 *
 *   walnut-calendar  EventKit           needs Calendars       (promptable)
 *   walnut-activity  Apple Events       needs Automation      (promptable)
 *   walnut-extract   PDFKit + Vision    needs nothing
 *   walnut-reader    plain file read    needs Full Disk Access (NOT promptable)
 *
 * They are compiled ON THE USER'S MACHINE at first use (swiftc), cached under
 * WALNUT_HOME/cache, and signed here if a certificate identity exists. This file
 * owns compile + sign + cache for all of them; before it existed the same swiftc
 * invocation was copy-pasted in three places and none of them signed anything.
 *
 * ── Why signing matters more than it looks (the whole reason this file exists) ──
 *
 * A TCC grant is not remembered against "Walnut". It is remembered against a
 * CODE IDENTITY, and how macOS computes that identity depends on the signature:
 *
 *   ad-hoc / unsigned  →  identity includes the binary's CONTENT HASH (cdhash).
 *                         Recompile anything and macOS sees a DIFFERENT program;
 *                         the existing grant no longer applies.
 *   certificate-signed →  identity is "signed by team T, identifier I".
 *                         Content may change freely; the grant survives updates.
 *
 * Consequences we measured on this repo:
 *
 *   - Every helper was ad-hoc (`Signature=adhoc`, `TeamIdentifier=not set`), so
 *     every version bump silently became a new program. For the PROMPTABLE
 *     permissions that is merely annoying: macOS shows its dialog again and one
 *     click restores it. `desktop/build-release.sh` hit exactly this and its
 *     comments record it: an ad-hoc app bundle re-prompted for the microphone on
 *     every update, which is why it now prefers a certificate identity.
 *
 *   - For FULL DISK ACCESS the same event is far worse, because FDA has no API
 *     to request it and no dialog. A stale grant fails as a bare
 *     `Operation not permitted`, with nothing on screen. Worse, System Settings
 *     still SHOWS the entry with its toggle on, because that row describes the
 *     old content hash. Toggling it off and on does not help. The user has to
 *     select the row, press MINUS to remove it, then press PLUS and add the very
 *     same path back so tccd re-reads the current hash. Nobody guesses that, so
 *     callers must detect the state and say it explicitly (see
 *     src/core/time-tracking/screentime-reader.ts, which distinguishes "never
 *     granted" from "granted but stale" using its own success marker).
 *
 *   - A bug this file fixes: the old compile wrote to `<bin>.tmp-<pid>` and
 *     renamed afterwards, and swiftc's automatic ad-hoc signature takes its
 *     identifier from the file name at sign time. So walnut-activity shipped with
 *     `Identifier=walnut-activity-v3.tmp-6899` — the identifier contained the
 *     COMPILING PROCESS'S PID and therefore differed on every single compile.
 *     Signing after the rename would still tie the identifier to a versioned file
 *     name (`…-v3` → `…-v4` is a different identifier), so we always pass an
 *     explicit, version-free `-i` instead.
 *
 *   - `--timestamp` is not optional. Without a secure timestamp, a signature made
 *     by a certificate that later expires can stop validating. The identities
 *     available here are `Apple Development`, which expire yearly.
 *
 * ── Roadmap (deliberately not done yet) ──
 *
 * The real end state is to compile the helpers ONCE at release time as universal
 * binaries, sign them with a `Developer ID Application` certificate, and ship
 * them inside the npm package and inside Walnut.app/Contents/Helpers (which is
 * how every Mac app ships its helpers: Chrome carries five helper .apps plus
 * three bare binaries inside its bundle and the user only ever sees one icon).
 * Then no user needs Xcode Command Line Tools, there is no first-run compile, and
 * everyone gets an update-stable TCC identity. That is blocked on one thing: the
 * account currently holds only `DEVELOPMENT` certificates, and Developer ID is a
 * separate certificate the Account Holder must create. Local compile + sign stays
 * as the fallback regardless, because a contributor without any certificate must
 * still be able to build and run everything.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLOUD_MODE, WALNUT_HOME } from '../constants.js';
import { log } from '../logging/index.js';

/** Why this box cannot have a given helper. Null means fine, or not tried yet. */
export type HelperUnavailable = 'not_macos' | 'no_compiler' | 'compile_failed';

export interface HelperSpec {
  /** Base name, no version: `walnut-reader`. The cached file appends the version. */
  name: string;
  /** Bumped when the .swift changes. Part of the cached file name so an upgrade
   *  never runs a stale binary, and so two Walnut versions can coexist. */
  version: string;
  /**
   * Signing identifier, pinned and VERSION-FREE on purpose. This is the string a
   * certificate-signed TCC grant is remembered against, so it must not move when
   * `version` bumps or the grant would break on every upgrade — which is the
   * entire problem this module exists to solve.
   */
  identifier: string;
  /** Embedded into __TEXT,__info_plist. Required when tccd must read a usage
   *  description string (Calendars, Apple Events). Omit when no prompt exists. */
  infoPlist?: string;
}

interface BuildOutcome {
  bin: string | null;
  reason: HelperUnavailable | null;
}

/** In-flight/settled build per helper name, so N callers compile once. */
const builds = new Map<string, Promise<BuildOutcome>>();
/** Last settled outcome per helper, for the API's `reason` field. */
const outcomes = new Map<string, BuildOutcome>();

/** The compile/availability failure for a helper, if it has settled as failed. */
export function helperFailure(name: string): HelperUnavailable | null {
  return outcomes.get(name)?.reason ?? null;
}

/**
 * Let a FAILED build be retried (the user installed the Xcode command line tools
 * and flipped the toggle again). Only clears a SETTLED failure: a compile still
 * in flight has no recorded reason, so it is never thrown away mid-run.
 */
export function clearFailedHelper(name: string): void {
  if (!outcomes.has(name)) return;
  if (outcomes.get(name)?.reason === null) return;
  outcomes.delete(name);
  builds.delete(name);
}

/** Drop all memoized builds (tests, and a WALNUT_HOME swap). */
export function resetHelperBuilds(): void {
  builds.clear();
  outcomes.clear();
}

/** Resolve `src/data/<file>` across the source tree and the bundled dist layout. */
export function helperSourcePath(file: string): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, `data/${file}`), // dist/cli.js → dist/data
    path.resolve(here, `../data/${file}`),
    path.resolve(here, `../../data/${file}`), // src/core/<sub> → src/data
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return candidates[0]!;
}

function cachedBinPath(spec: HelperSpec): string {
  return path.join(WALNUT_HOME, 'cache', `${spec.name}-${spec.version}`);
}

/** Sidecar recording WHAT the cached binary was built from, so a rebuild can be
 *  skipped with proof rather than by hoping the version was bumped. */
function fingerprintPath(spec: HelperSpec): string {
  return `${cachedBinPath(spec)}.srchash`;
}

/**
 * Identity of the inputs that decide the binary's bytes: the Swift source, the
 * signing identifier, and the embedded plist. NOT the version, which is already
 * in the file name.
 */
function sourceFingerprint(spec: HelperSpec, srcPath: string): string | null {
  let source: Buffer;
  try {
    source = fs.readFileSync(srcPath);
  } catch {
    return null;
  }
  return createHash('sha256')
    .update(source)
    .update('\n--\n')
    .update(spec.identifier)
    .update('\n--\n')
    .update(spec.infoPlist ?? '')
    .digest('hex');
}

function readFingerprint(spec: HelperSpec): string | null {
  try {
    return fs.readFileSync(fingerprintPath(spec), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/**
 * Whether the cached binary may be served as-is.
 *
 *   reuse    the fingerprints agree, the file stands
 *   adopt    a pre-fingerprint (or fingerprint-less) binary; record and keep it
 *   rebuild  the .swift moved while `version` did not, so the cache is a lie
 *   compile  nothing cached yet
 *
 * Split out because "may I overwrite this file?" is the ENTIRE bug this guards
 * against and it must be assertable without a swiftc on the box: overwriting an
 * unchanged ad-hoc helper silently throws away the macOS permission the user
 * granted it, and nothing anywhere reports that it happened.
 */
export type HelperCacheDecision = 'reuse' | 'adopt' | 'rebuild' | 'compile';

export function helperCacheDecision(spec: HelperSpec, srcPath: string): HelperCacheDecision {
  if (!fs.existsSync(cachedBinPath(spec))) return 'compile';
  const fingerprint = sourceFingerprint(spec, srcPath);
  // No readable source means no evidence of a change, and a working binary beats
  // a theory. (buildHelper reports the missing source separately.)
  if (fingerprint === null) return 'reuse';
  const stored = readFingerprint(spec);
  if (stored === null) return 'adopt';
  return stored === fingerprint ? 'reuse' : 'rebuild';
}

/**
 * Older cached generations of the same helper, newest first.
 *
 * Why this exists: an ad-hoc helper's TCC grant is keyed to its content hash, so
 * the grant does NOT move to a new generation — but it also does not disappear.
 * `walnut-calendar-v4` kept full Calendars access after `-v5` appeared next to it
 * with no grant at all. A caller that hits `permission-denied` on the current
 * generation can therefore keep working from a previous one while the user
 * re-grants, instead of reporting an empty calendar (see
 * src/core/calendar/sources/eventkit.ts). Only `v<N>` versions take part, and the
 * caller still has to prove the older protocol does what it needs.
 */
export function olderHelperGenerations(spec: HelperSpec): string[] {
  const current = /^v(\d+)$/.exec(spec.version);
  if (!current) return [];
  const currentN = Number(current[1]);
  const dir = path.join(WALNUT_HOME, 'cache');
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const found: { n: number; bin: string }[] = [];
  for (const entry of entries) {
    const m = new RegExp(`^${escapeRegExp(spec.name)}-v(\\d+)$`).exec(entry);
    if (!m) continue;
    const n = Number(m[1]);
    if (n >= currentN) continue;
    const bin = path.join(dir, entry);
    try {
      if (!fs.statSync(bin).isFile()) continue;
      fs.accessSync(bin, fs.constants.X_OK);
    } catch {
      continue;
    }
    found.push({ n, bin });
  }
  return found.sort((a, b) => b.n - a.n).map((f) => f.bin);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compile (once per machine per version) and sign the helper; resolve its path,
 * or null when this box cannot have it at all.
 *
 * The cached path is the fast path forever after, so a swiftc killed mid-link
 * must never be able to leave a partial binary there: we build to a per-process
 * temp name and rename, which is atomic inside one directory.
 */
export function ensureHelper(spec: HelperSpec, sourceFile: string): Promise<string | null> {
  const existing = builds.get(spec.name);
  if (existing) return existing.then((o) => o.bin);
  const build = buildHelper(spec, sourceFile).then((outcome) => {
    outcomes.set(spec.name, outcome);
    return outcome;
  });
  builds.set(spec.name, build);
  return build.then((o) => o.bin);
}

async function buildHelper(spec: HelperSpec, sourceFile: string): Promise<BuildOutcome> {
  if (process.platform !== 'darwin' || CLOUD_MODE) return { bin: null, reason: 'not_macos' };
  const bin = cachedBinPath(spec);
  const src = helperSourcePath(sourceFile);
  const fingerprint = sourceFingerprint(spec, src);

  // An existing binary is REUSED, never rewritten, unless its inputs really moved.
  // Rewriting it would be silently destructive: the binary's content hash is the
  // TCC identity for an ad-hoc signature, so a pointless recompile hands the user
  // an identical-looking helper that has lost the permission they granted.
  const decision = helperCacheDecision(spec, src);
  if (decision === 'reuse') return { bin, reason: null };
  if (decision === 'adopt') {
    // Built before fingerprints existed (or the sidecar was lost). The version in
    // the file name is the only contract that generation ever had, so adopt it
    // rather than throwing away a working grant on a guess.
    if (fingerprint) await fsp.writeFile(fingerprintPath(spec), fingerprint).catch(() => {});
    return { bin, reason: null };
  }
  if (decision === 'rebuild') {
    // Same version, different source: somebody edited the .swift without bumping
    // `version`. Serving the stale binary would be a silent lie, so rebuild — but
    // say out loud that the permission is about to need a re-grant.
    log.web.warn('helper source changed without a version bump, rebuilding', {
      helper: spec.name,
      version: spec.version,
      note: 'an ad-hoc helper loses its macOS permission grant on rebuild; bump the version instead',
    });
  }

  if (!fs.existsSync(src)) {
    log.web.warn('helper source missing, feature disabled', { helper: spec.name, src });
    return { bin: null, reason: 'compile_failed' };
  }
  await fsp.mkdir(path.dirname(bin), { recursive: true });

  const args = ['-n', '10', 'xcrun', 'swiftc', '-O', '-o', '', src];
  const tmpBin = `${bin}.tmp-${process.pid}`;
  args[6] = tmpBin;
  let plistPath: string | undefined;
  if (spec.infoPlist) {
    // tccd reads the usage description out of this section once the helper
    // disclaims parent responsibility and becomes its own TCC subject.
    plistPath = path.join(WALNUT_HOME, 'cache', `${spec.name}-${spec.version}.plist`);
    await fsp.writeFile(plistPath, spec.infoPlist);
    args.push(
      '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT',
      '-Xlinker', '__info_plist', '-Xlinker', plistPath,
    );
  }

  const compiled = await run('nice', args);
  if (!compiled.ok) {
    await fsp.rm(tmpBin, { force: true }).catch(() => {});
    // "No compiler on this box" is an install step for the user; "our source
    // won't build" is our bug. They must not collapse into one message.
    const missing = compiled.code === null || compiled.code === 127
      || /xcrun: error|unable to find utility|command not found|no developer tools/i.test(compiled.stderr);
    const reason: HelperUnavailable = missing ? 'no_compiler' : 'compile_failed';
    log.web.warn('helper swift compile failed, feature disabled', {
      helper: spec.name, reason, code: compiled.code, error: compiled.stderr.slice(0, 400),
    });
    return { bin: null, reason };
  }

  await signHelper(tmpBin, spec);

  try {
    await fsp.chmod(tmpBin, 0o755);
    await fsp.rename(tmpBin, bin); // same dir → atomic, never EXDEV
  } catch (err) {
    await fsp.rm(tmpBin, { force: true }).catch(() => {});
    log.web.warn('helper could not be installed', {
      helper: spec.name, error: err instanceof Error ? err.message : String(err),
    });
    return { bin: null, reason: 'compile_failed' };
  }
  // Written only AFTER the binary is in place: a fingerprint without its binary
  // would make the next boot skip a compile it still has to do.
  if (fingerprint) await fsp.writeFile(fingerprintPath(spec), fingerprint).catch(() => {});
  return { bin, reason: null };
}

/**
 * Sign with a real identity when one exists, else leave swiftc's automatic ad-hoc
 * signature in place.
 *
 * NEVER a hard failure: an unsigned helper works perfectly, it just has a
 * content-hash TCC identity instead of a stable one (see the file header). A
 * contributor with no certificate must still get a working build.
 *
 * Signing happens BEFORE the rename to the final path but with an explicit `-i`,
 * so the identifier is neither the temp file name (which carries our pid) nor the
 * versioned final name (which changes every bump). Both of those were real
 * defects: shipped binaries carried `Identifier=walnut-activity-v3.tmp-6899`.
 */
async function signHelper(binPath: string, spec: HelperSpec): Promise<void> {
  const candidates = await signingCandidates();
  if (candidates.length === 0) {
    log.web.info('helper left ad-hoc signed (no codesigning identity on this box)', {
      helper: spec.name,
      note: 'TCC grants are keyed to the binary hash and reset whenever the helper is rebuilt',
    });
    return;
  }
  for (const candidate of candidates) {
    // --timestamp: without a secure timestamp a signature can stop validating once
    // the certificate expires, and Apple Development certs expire yearly.
    const signed = await run('codesign', [
      '--force', '--sign', candidate.hash, '-i', spec.identifier,
      '--timestamp', '--options', 'runtime', binPath,
    ]);
    if (!signed.ok) {
      // Usually the keychain refusing access to the private key without a UI
      // prompt. Try the next identity rather than losing the feature.
      log.web.warn('helper signing failed with this identity, trying the next', {
        helper: spec.name, identity: candidate.name, error: signed.stderr.slice(0, 200),
      });
      continue;
    }
    if (await signatureIsUsable(binPath)) {
      log.web.info('helper signed', {
        helper: spec.name, identifier: spec.identifier, identity: candidate.name,
      });
      return;
    }
    log.web.warn('helper signature assessed as unusable, trying the next identity', {
      helper: spec.name, identity: candidate.name,
    });
  }
  // Every identity failed. Leaving the last (bad) signature in place would be
  // WORSE than not signing: a binary signed by a revoked certificate is killed
  // with SIGKILL the moment it launches, so the feature would be dead rather than
  // merely losing grant stability. Restore an ad-hoc signature explicitly.
  const adhoc = await run('codesign', ['--force', '--sign', '-', '-i', spec.identifier, binPath]);
  log.web.warn('helper fell back to an ad-hoc signature', {
    helper: spec.name, restored: adhoc.ok,
  });
}

/**
 * Does this signature actually let the binary run?
 *
 * `security find-identity -v -p codesigning` does NOT check revocation, so it
 * happily lists a revoked certificate as valid. Measured on this machine: one of
 * the two listed `Apple Development` identities was revoked; `codesign --verify`
 * still reported "satisfies its Designated Requirement", but `spctl` returned
 * CSSMERR_TP_CERT_REVOKED and every launch of the signed binary died with
 * SIGKILL. Picking "the first identity that matches" is therefore a coin flip
 * between a working helper and a permanently dead one, which is why every
 * candidate is assessed after signing rather than trusted up front.
 * `desktop/build-release.sh` learned the same lesson for the app bundle.
 *
 * The test has to be CONTRACT-FREE, and the first version was not. It ran
 * `<binary> --version` as its "can it execute" check, which only walnut-reader
 * implements: walnut-calendar and walnut-activity exit 1 on an unknown argument,
 * so both were judged unusable and fell back to ad-hoc, silently undoing the whole
 * point of signing them. Measured on a correctly-signed calendar helper: `spctl`
 * says a bare `rejected` (a Development certificate is not valid for
 * distribution, so Gatekeeper refuses it regardless), and `--version` exits 1.
 * Neither says anything about the certificate.
 *
 * So the last-resort question is the narrowest one that separates the two cases:
 * was the process KILLED BY THE KERNEL, or did it run and choose an exit code? A
 * revoked signature is the former; wrong arguments are the latter. Any exit code at
 * all means the code got to run, which is all this function needs to know.
 */
async function signatureIsUsable(binPath: string): Promise<boolean> {
  const assessed = await run('spctl', ['-a', '-t', 'exec', binPath]);
  if (assessed.ok) return true;
  // A rejection is only believed when it names a certificate problem.
  if (/REVOKED|EXPIRED|CERT/i.test(assessed.stderr + assessed.stdout)) return false;
  // No arguments, so no helper needs to understand anything. A helper that streams
  // when run bare (walnut-activity) is stopped by our own timeout, and a timeout is
  // NOT a verdict against it: it proves the code was running.
  const ran = await run(binPath, [], { timeoutMs: 3_000 });
  return !ran.killedByKernel;
}

interface SigningCandidate { hash: string; name: string }

/** Memoized identity lookup: one `security` spawn per process, not per helper. */
let candidatesPromise: Promise<SigningCandidate[]> | null = null;

/**
 * Codesigning identities to try, best first.
 *
 * Order is `Developer ID Application` (the only kind valid for distribution and
 * notarization) before `Apple Development`, and within each kind sorted by name.
 * The sort is not cosmetic: the chosen identity becomes part of the signature's
 * designated requirement, which is exactly what a TCC grant is remembered
 * against, so an order that varies with keychain enumeration would silently
 * invalidate the user's Full Disk Access grant on some later rebuild.
 *
 * `WALNUT_HELPER_SIGN_IDENTITY` overrides everything (a hash or an exact name),
 * which is how a release build pins one identity for reproducible signatures.
 */
function signingCandidates(): Promise<SigningCandidate[]> {
  if (candidatesPromise) return candidatesPromise;
  candidatesPromise = (async () => {
    const pinned = process.env.WALNUT_HELPER_SIGN_IDENTITY?.trim();
    if (pinned) return [{ hash: pinned, name: pinned }];
    const found = await run('security', ['find-identity', '-v', '-p', 'codesigning']);
    if (!found.ok) return [];
    const devId: SigningCandidate[] = [];
    const appleDev: SigningCandidate[] = [];
    for (const line of found.stdout.split('\n')) {
      // `  1) <40-hex> "Apple Development: Name (TEAMID)"`
      const m = /^\s*\d+\)\s+([0-9A-F]{40})\s+"(.+)"\s*$/i.exec(line);
      if (!m) continue;
      const entry = { hash: m[1]!, name: m[2]! };
      if (/^Developer ID Application/i.test(entry.name)) devId.push(entry);
      else if (/^Apple Development/i.test(entry.name)) appleDev.push(entry);
    }
    const byName = (a: SigningCandidate, b: SigningCandidate) => a.name.localeCompare(b.name);
    return [...devId.sort(byName), ...appleDev.sort(byName)];
  })();
  return candidatesPromise;
}

/** Reset the memoized identity lookup (tests). */
export function resetSigningIdentityCache(): void {
  candidatesPromise = null;
}

interface RunResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  /**
   * The process died on a signal WE did not send, which is what a signature macOS
   * refuses looks like (SIGKILL at launch, before any of the program runs). Our own
   * timeout kill is excluded on purpose: it means the process was alive and working.
   */
  killedByKernel: boolean;
}

/**
 * Spawn and collect. With `timeoutMs`, the promise settles ON THE TIMEOUT and does not
 * wait for `close`.
 *
 * That distinction is not defensive tidiness, it is required. Measured while building
 * this: a binary signed by a revoked certificate is SIGKILLed at launch, and node's
 * `close` event for it never arrived at all (a bare `spawn` + `close` listener sat
 * there indefinitely). A probe that awaited `close` would therefore hang the helper
 * build forever, and every caller awaiting the helper with it. Settling on our own
 * timer means the worst case is a wrong-but-bounded answer instead of a wedge.
 */
function run(cmd: string, args: string[], opts: { timeoutMs?: number } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (result: RunResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    const timer = opts.timeoutMs
      ? setTimeout(() => {
        child.kill('SIGKILL');
        // Still running at the deadline means the code IS running, whatever it is
        // doing, so this is not a verdict against its signature.
        done({ ok: false, code: null, stdout, stderr: `${stderr} (timed out)`, killedByKernel: false });
      }, opts.timeoutMs)
      : undefined;
    child.stdout?.on('data', (d) => { stdout += String(d); });
    child.stderr?.on('data', (d) => { stderr += String(d); });
    child.on('error', (err) => {
      done({ ok: false, code: null, stdout, stderr: err.message, killedByKernel: false });
    });
    child.on('close', (code, signal) => {
      done({ ok: code === 0, code, stdout, stderr, killedByKernel: signal !== null });
    });
  });
}
