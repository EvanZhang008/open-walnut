/**
 * npm-registry installs for the Plugin Store.
 *
 * The git path (plugin-sources.ts) clones a repo; this path fetches a published
 * package. Same trust model — a plugin runs in-process with full privileges, so
 * ADDING the source is the consent step — but the supply chain is different and
 * gets its own rules:
 *
 * - **Registry package specs only.** `name`, `name@1.2.3`, `name@tag`,
 *   `@scope/name[@…]`. Anything that could make npm fetch from somewhere else or
 *   read the local filesystem (a URL, `git+…`, `file:`, `npm:` alias, a path) is
 *   rejected before npm ever sees it, as is a leading dash (argument injection)
 *   and any whitespace/control character. Ranges are rejected too: a `^1.0.0`
 *   source would silently change code under the user on the next install, and
 *   this store never auto-updates.
 * - **Never a shell.** Every child process uses spawn with an argv
 *   array. The runner is swappable (`setNpmRunner`) so tests exercise the whole
 *   flow without touching the network.
 * - **No lifecycle scripts, ever.** `--ignore-scripts` is not a preference: an
 *   `install` script would run arbitrary code at ADD time, before the user has
 *   seen what the manifest declares.
 * - **Resolve, install, then verify the receipt.** `npm view` pins an exact
 *   version. After install, Walnut reads npm's own hidden lockfile for the actual
 *   tarball origin and integrity npm verified. The receipt must match the earlier
 *   resolution, and every installed dependency must live below the Plugin root so
 *   it survives the final rename. The receipt integrity is what state persists.
 * - **Stage, verify, then rename.** The package is installed into a 0700 temp dir
 *   on the same filesystem, verified (real directories, no symlinks, package.json
 *   matches what the registry promised, a valid root manifest.json), and only then
 *   renamed into place. A half-installed plugin never becomes visible to the
 *   loader, and a failure cleans up only the staging dir this call created.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createSubsystemLogger } from '../logging/index.js';
import { safeKillProcessGroup } from './process-group-kill.js';

const log = createSubsystemLogger('plugin-sources');

const VIEW_TIMEOUT = 60_000;
const INSTALL_TIMEOUT = 300_000;

// ── Spec parsing & validation ──

/** One path segment of an npm name: lowercase, no leading dot/underscore/dash. */
const NAME_SEG_RE = /^[a-z0-9][a-z0-9._-]*$/;
const SCOPE_RE = /^@[a-z0-9][a-z0-9._-]*$/;
/** Exact semver — a range would let the installed code change without consent. */
const EXACT_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
/** dist-tag: `latest`, `next`, `beta`, `v2-canary`… */
const DIST_TAG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/;
/** semver range operators — present ⇒ not an exact pin. */
const RANGE_CHARS_RE = /[\^~><=*|,]/;
const INTEGRITY_TOKEN_RE = /^sha(?:1|256|384|512)-[A-Za-z0-9+/]+={0,2}$/i;

function isValidIntegrity(value: string): boolean {
  const tokens = value.trim().split(/\s+/);
  return tokens.length > 0 && tokens.every((token) => INTEGRITY_TOKEN_RE.test(token));
}

export interface ParsedNpmSpec {
  /** Full package name including scope, e.g. `@acme/walnut-plugin`. */
  name: string;
  /** Exact version or dist-tag the user asked for; absent means `latest`. */
  requested?: string;
  /** Normalized spec (trimmed) — safe to hand to npm as a positional argument. */
  spec: string;
}

/**
 * Parse a registry package spec. Returns null (never throws) for anything that
 * is not a plain registry reference, so callers can fall through to the git path.
 */
export function parseNpmSpec(raw: string): ParsedNpmSpec | null {
  if (typeof raw !== 'string') return null;
  const spec = raw.trim();
  if (!spec) return null;
  // Argument injection, embedded whitespace, control bytes.
  if (spec.startsWith('-')) return null;
  if (/\s/.test(spec) || CONTROL_RE.test(spec)) return null;
  // A registry spec never contains a colon. This one check rejects every
  // alternate fetcher in one go: https://, git+ssh://, git:, file:, npm:,
  // github:, gitlab:, bitbucket:, gist:, link:, workspace:, patch:.
  if (spec.includes(':')) return null;
  // Local paths and backslash tricks.
  if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('~') || spec.includes('\\')) return null;
  if (spec.length > 250) return null;

  let scope = '';
  let rest = spec;
  if (spec.startsWith('@')) {
    const slash = spec.indexOf('/');
    if (slash < 0) return null; // `@foo` with no package part
    scope = spec.slice(0, slash);
    rest = spec.slice(slash + 1);
    if (!SCOPE_RE.test(scope)) return null;
  }
  // Only the scope separator may be a slash — anything else is a path.
  if (rest.includes('/')) return null;

  const at = rest.indexOf('@');
  const nameSeg = at < 0 ? rest : rest.slice(0, at);
  const requested = at < 0 ? '' : rest.slice(at + 1);
  if (!NAME_SEG_RE.test(nameSeg)) return null;

  const name = scope ? `${scope}/${nameSeg}` : nameSeg;
  if (name.length > 214) return null;

  if (at >= 0) {
    if (!requested) return null; // trailing `@`
    if (RANGE_CHARS_RE.test(requested)) return null;
    if (/^[xX]$/.test(requested)) return null; // bare wildcard range

    // Version-ish (`1.2.3`, `v1.2.3`) must be an exact pin; `1.x` / `1.2` are
    // ranges wearing a version's clothes and must not slip through as "tags".
    if (/^v?\d/.test(requested)) {
      const bare = requested.startsWith('v') ? requested.slice(1) : requested;
      if (!EXACT_VERSION_RE.test(bare)) return null;
    } else if (!DIST_TAG_RE.test(requested)) {
      return null;
    }
  }

  return { name, requested: requested || undefined, spec };
}

export function isValidNpmSpec(raw: string): boolean {
  return parseNpmSpec(raw) !== null;
}

/**
 * Store directory slug for an npm package. The `npm-` prefix distinguishes the
 * ordinary same-name Git repository; source registration also rejects any actual
 * configured-slug collision.
 */
export function slugForNpmPackage(name: string): string {
  const flat = name
    .replace(/^@/, '')
    .replace(/\//g, '-')
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    // Collapse dot runs: a hand-edited config could otherwise smuggle `..`
    // into the slug, and slugs are joined onto PLUGIN_STORES_DIR.
    .replace(/\.{2,}/g, '.');
  return `npm-${flat || 'package'}`;
}

/** Slug for a spec string; throws if the spec is not a registry spec. */
export function slugForNpmSpec(spec: string): string {
  const parsed = parseNpmSpec(spec);
  if (!parsed) throw new Error(invalidSpecMessage());
  return slugForNpmPackage(parsed.name);
}

export function invalidSpecMessage(): string {
  return 'Invalid npm package spec. Expected a registry package: name, name@1.2.3, name@tag, '
    + '@scope/name, or @scope/name@1.2.3. URLs, git/file/path specs, npm: aliases and version '
    + 'ranges (^, ~, x) are not accepted.';
}

// ── Child-process seam ──

export interface NpmRunResult {
  stdout: string;
  stderr: string;
}

export type NpmRunner = (args: string[], opts: { cwd: string; timeoutMs: number }) => Promise<NpmRunResult>;

/**
 * Default runner: argv-only spawn in its own process group. npm can launch
 * fetchers and lifecycle helpers, so timeout must reap the whole tree.
 */
const defaultRunner: NpmRunner = (args, opts) =>
  new Promise((resolve, reject) => {
    const child = spawn('npm', args, {
      cwd: opts.cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const outputLimit = 16 * 1024 * 1024;
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let outputExceeded = false;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const killGroup = (signal: NodeJS.Signals): void => {
      if (!safeKillProcessGroup(child.pid, signal)) {
        try { child.kill(signal); } catch { /* already gone */ }
      }
    };
    const terminate = (): void => {
      killGroup('SIGTERM');
      killTimer = setTimeout(() => killGroup('SIGKILL'), 3_000);
      killTimer.unref?.();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, opts.timeoutMs);
    timer.unref?.();

    const collect = (target: 'stdout' | 'stderr', chunk: Buffer | string): void => {
      if (outputExceeded) return;
      const text = String(chunk);
      if (target === 'stdout') {
        stdoutBytes += Buffer.byteLength(text);
        if (stdoutBytes > outputLimit) outputExceeded = true;
        else stdout += text;
      } else {
        stderrBytes += Buffer.byteLength(text);
        if (stderrBytes > outputLimit) outputExceeded = true;
        else stderr += text;
      }
      if (outputExceeded) terminate();
    };
    child.stdout?.on('data', (chunk) => collect('stdout', chunk));
    child.stderr?.on('data', (chunk) => collect('stderr', chunk));

    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      const detail = sanitizeNpmOutput(error.message);
      reject(new Error(detail ? `npm ${args[0]} failed: ${detail}` : `npm ${args[0]} failed`));
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (timedOut) {
        reject(new Error(`npm ${args[0]} timed out after ${opts.timeoutMs}ms`));
        return;
      }
      if (outputExceeded) {
        reject(new Error(`npm ${args[0]} failed: output exceeded ${outputLimit} bytes`));
        return;
      }
      if (code !== 0) {
        const detail = sanitizeNpmOutput(stderr || stdout || `exit ${code ?? 'unknown'}`);
        reject(new Error(detail ? `npm ${args[0]} failed: ${detail}` : `npm ${args[0]} failed`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });

let activeRunner: NpmRunner = defaultRunner;

/** Test seam: pass null to restore the real process-group runner. */
export function setNpmRunner(runner: NpmRunner | null): void {
  activeRunner = runner ?? defaultRunner;
}

/**
 * Bound npm's chatter and mask anything credential-shaped. A registry spec
 * cannot carry credentials, but a user's ~/.npmrc can, and npm occasionally
 * echoes config lines back on error.
 */
export function sanitizeNpmOutput(raw: string): string {
  return String(raw ?? '')
    // A credential assignment runs to end of line — `\S+` would leave the tail
    // of `authorization: Bearer <token>` in the message.
    .replace(/(_auth(?:Token)?|_password|authorization)\s*[=:][^\n]*/gi, '$1=***')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, '$1 ***')
    .replace(/(https?:\/\/)[^/\s@]+@/gi, '$1***@')
    .trim()
    .slice(0, 2000);
}

// ── Resolve ──

export interface ResolvedNpmPackage {
  name: string;
  version: string;
  /** `name@version` — the exact spec that was (or will be) installed. */
  resolved: string;
  /** Registry-advertised SRI. The install receipt becomes authoritative on disk. */
  integrity?: string;
  /** Registry-advertised tarball URL, used to bind the install receipt to its origin. */
  tarball: string;
}

function secureTarballUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} is not a valid URL.`);
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error(`${label} must be an HTTPS URL without embedded credentials.`);
  }
  return url;
}

function pickField(data: Record<string, unknown>, dotted: string): string | undefined {
  // npm prints dotted field requests as flat keys ("dist.integrity"), but keep
  // the nested read as a fallback so a future npm shape change degrades quietly.
  const flat = data[dotted];
  if (typeof flat === 'string') return flat;
  const [head, tail] = dotted.split('.');
  const nested = data[head];
  if (nested && typeof nested === 'object' && tail) {
    const value = (nested as Record<string, unknown>)[tail];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

/**
 * Ask the registry what a spec means right now. Nothing else in this module
 * accepts a tag — resolution happens exactly once per explicit user action.
 */
export async function resolveNpmSpec(raw: string, opts: { cwd?: string } = {}): Promise<ResolvedNpmPackage> {
  const parsed = parseNpmSpec(raw);
  if (!parsed) throw new Error(invalidSpecMessage());

  const cwd = opts.cwd ?? process.cwd();
  const { stdout } = await activeRunner(
    ['view', '--json', '--', parsed.spec, 'name', 'version', 'dist.integrity', 'dist.tarball'],
    { cwd, timeoutMs: VIEW_TIMEOUT },
  );

  let payload: unknown;
  try {
    payload = JSON.parse(stdout);
  } catch {
    throw new Error(`Could not read the registry response for "${parsed.spec}".`);
  }
  // A range would return an array; ranges are rejected, but stay defensive.
  const data = (Array.isArray(payload) ? payload[payload.length - 1] : payload) as Record<string, unknown> | undefined;
  if (!data || typeof data !== 'object') {
    throw new Error(`Package "${parsed.spec}" was not found in the registry.`);
  }

  const name = pickField(data, 'name');
  const version = pickField(data, 'version');
  if (!name || !version) {
    throw new Error(`Registry response for "${parsed.spec}" is missing name/version.`);
  }
  // The registry must be describing the package the user asked for.
  if (name !== parsed.name) {
    throw new Error(`Registry returned "${name}" for "${parsed.spec}" — refusing to install a different package.`);
  }
  if (!EXACT_VERSION_RE.test(version)) {
    throw new Error(`Registry returned a non-exact version "${version}" for "${parsed.spec}".`);
  }
  if (parsed.requested && /^v?\d/.test(parsed.requested)) {
    const requested = parsed.requested.startsWith('v') ? parsed.requested.slice(1) : parsed.requested;
    if (requested !== version) {
      throw new Error(`Registry returned version "${version}" for exact pin "${parsed.spec}".`);
    }
  }

  const integrity = pickField(data, 'dist.integrity');
  if (integrity && !isValidIntegrity(integrity)) {
    throw new Error(`Registry returned a malformed integrity value for "${parsed.spec}".`);
  }
  const tarball = pickField(data, 'dist.tarball');
  if (!tarball) throw new Error(`Registry response for "${parsed.spec}" is missing dist.tarball.`);
  secureTarballUrl(tarball, `Registry tarball for "${parsed.spec}"`);

  return {
    name,
    version,
    resolved: `${name}@${version}`,
    ...(integrity ? { integrity: integrity.trim() } : {}),
    tarball,
  };
}

async function writeScopePackageJson(dir: string): Promise<void> {
  await fsp.writeFile(
    path.join(dir, 'package.json'),
    `${JSON.stringify({ name: 'walnut-plugin-staging', version: '0.0.0', private: true }, null, 2)}\n`,
    'utf-8',
  );
}

/** Resolve with an owned package.json so ancestor project config cannot change registries. */
export async function resolveNpmSpecIsolated(raw: string, stagingRoot: string): Promise<ResolvedNpmPackage> {
  const parsed = parseNpmSpec(raw);
  if (!parsed) throw new Error(invalidSpecMessage());
  await fsp.mkdir(stagingRoot, { recursive: true });
  const scopePath = path.join(
    stagingRoot,
    `.metadata-${slugForNpmPackage(parsed.name)}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
  );
  await fsp.mkdir(scopePath, { mode: 0o700 });
  await fsp.chmod(scopePath, 0o700);
  const scope = await fsp.realpath(scopePath);
  try {
    await writeScopePackageJson(scope);
    return await resolveNpmSpec(raw, { cwd: scope });
  } finally {
    await fsp.rm(scope, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ── Staging & verification ──

interface StagedPackage {
  stagingDir: string;
  packageRoot: string;
  resolved: VerifiedNpmPackage;
}

async function assertRealDirectory(target: string, label: string): Promise<void> {
  let stat: fs.Stats;
  try {
    stat = await fsp.lstat(target);
  } catch {
    throw new Error(`${label} is missing after install (${target}).`);
  }
  // lstat, not stat: a symlink here could point the "package root" anywhere.
  if (stat.isSymbolicLink()) throw new Error(`${label} is a symlink — refusing to install (${target}).`);
  if (!stat.isDirectory()) throw new Error(`${label} is not a directory (${target}).`);
}

async function assertInside(child: string, parent: string, label: string): Promise<void> {
  const realParent = await fsp.realpath(parent);
  const realChild = await fsp.realpath(child);
  const rel = path.relative(realParent, realChild);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`${label} resolved outside the staging directory — refusing to install.`);
  }
}

interface HiddenLockEntry {
  version?: unknown;
  resolved?: unknown;
  integrity?: unknown;
  link?: unknown;
  inBundle?: unknown;
}

interface HiddenLock {
  lockfileVersion?: unknown;
  packages?: unknown;
}

interface VerifiedNpmPackage extends ResolvedNpmPackage {
  integrity: string;
}

async function verifyInstallReceipt(
  stagingDir: string,
  packageRoot: string,
  resolved: ResolvedNpmPackage,
): Promise<VerifiedNpmPackage> {
  const lockPath = path.join(stagingDir, 'node_modules', '.package-lock.json');
  let lock: HiddenLock;
  try {
    lock = JSON.parse(await fsp.readFile(lockPath, 'utf8')) as HiddenLock;
  } catch (error) {
    throw new Error(`npm install did not produce a readable hidden lockfile receipt: ${error instanceof Error ? error.message : String(error)}`);
  }
  if ((lock.lockfileVersion !== 2 && lock.lockfileVersion !== 3)
    || !lock.packages || typeof lock.packages !== 'object' || Array.isArray(lock.packages)) {
    throw new Error('npm install produced an unsupported hidden lockfile receipt.');
  }

  const packageReal = await fsp.realpath(packageRoot);
  const outside: string[] = [];
  const rootEntries: HiddenLockEntry[] = [];
  for (const [key, rawEntry] of Object.entries(lock.packages as Record<string, unknown>)) {
    if (!key) continue;
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
      throw new Error(`npm install receipt has an invalid entry for ${JSON.stringify(key)}.`);
    }
    const entryPath = path.resolve(stagingDir, key);
    let entryReal: string;
    try {
      entryReal = await fsp.realpath(entryPath);
    } catch {
      throw new Error(`npm install receipt references a missing path: ${key}.`);
    }
    if (entryReal === packageReal) {
      rootEntries.push(rawEntry as HiddenLockEntry);
      continue;
    }
    const relative = path.relative(packageReal, entryReal);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) outside.push(key);
  }
  if (outside.length > 0) {
    throw new Error(`npm installed dependencies outside the Plugin package; they would be lost after placement: ${outside.slice(0, 5).join(', ')}`);
  }
  if (rootEntries.length !== 1) {
    throw new Error(`npm install receipt has ${rootEntries.length} entries for the Plugin package root; expected exactly one.`);
  }

  const receipt = rootEntries[0];
  if (receipt.link === true || receipt.inBundle === true) {
    throw new Error('npm install receipt describes the Plugin package as a link or bundled dependency.');
  }
  if (receipt.version !== resolved.version) {
    throw new Error(`npm install receipt version is ${String(receipt.version)}, expected ${resolved.version}.`);
  }
  if (typeof receipt.integrity !== 'string' || !isValidIntegrity(receipt.integrity)) {
    throw new Error('npm install receipt is missing a valid integrity value.');
  }
  if (typeof receipt.resolved !== 'string') {
    throw new Error('npm install receipt is missing a tarball URL.');
  }
  const advertisedUrl = secureTarballUrl(resolved.tarball, 'Registry tarball');
  const installedUrl = secureTarballUrl(receipt.resolved, 'Installed tarball');
  if (advertisedUrl.origin !== installedUrl.origin) {
    throw new Error('npm installed the Plugin from a different tarball origin than the registry advertised.');
  }
  const integrity = receipt.integrity.trim();
  if (resolved.integrity && resolved.integrity.trim() !== integrity) {
    throw new Error('npm install integrity does not match the registry resolution.');
  }
  if (integrity.split(/\s+/).some((token) => token.toLowerCase().startsWith('sha1-'))) {
    log.warn('npm Plugin installed with legacy sha1 integrity', { resolved: resolved.resolved });
  }
  return { ...resolved, integrity, tarball: receipt.resolved };
}

/** Install into a fresh 0700 staging dir and verify everything before anyone sees it. */
async function stagePackage(
  spec: string,
  stagingRoot: string,
  preResolved?: ResolvedNpmPackage,
): Promise<StagedPackage> {
  const parsed = parseNpmSpec(spec);
  if (!parsed) throw new Error(invalidSpecMessage());

  await fsp.mkdir(stagingRoot, { recursive: true });

  // Staging lives under stagingRoot so the final rename is same-filesystem
  // (a cross-device rename fails with EXDEV — see writeJsonFile's tmp rule).
  const stagingPath = path.join(
    stagingRoot,
    `.staging-${slugForNpmPackage(parsed.name)}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
  );
  await fsp.mkdir(stagingPath, { mode: 0o700 });
  await fsp.chmod(stagingPath, 0o700); // mkdir mode is umask-masked
  const stagingDir = await fsp.realpath(stagingPath);

  try {
    // An own package.json stops npm from walking up and reading ancestor project config.
    await writeScopePackageJson(stagingDir);
    const resolved = preResolved ?? await resolveNpmSpec(spec, { cwd: stagingDir });
    if (resolved.name !== parsed.name) {
      throw new Error(`Resolved package ${resolved.name} does not match requested package ${parsed.name}.`);
    }

    await activeRunner([
      'install',
      '--ignore-scripts',      // no package lifecycle code, ever
      '--omit=dev',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
      '--install-strategy=nested', // deps live under the package → they ride the rename
      '--prefix', stagingDir,
      '--',
      resolved.resolved,       // exact name@version, never the tag
    ], { cwd: stagingDir, timeoutMs: INSTALL_TIMEOUT });

    const modulesDir = path.join(stagingDir, 'node_modules');
    await assertRealDirectory(modulesDir, 'node_modules');
    // Walk the scope segments explicitly: each one must be a real directory.
    const segments = resolved.name.split('/');
    let packageRoot = modulesDir;
    for (const segment of segments) {
      packageRoot = path.join(packageRoot, segment);
      await assertRealDirectory(packageRoot, `installed package path "${segment}"`);
    }
    await assertInside(packageRoot, stagingDir, 'Installed package');

    // package.json must match what the registry promised.
    let pkg: Record<string, unknown>;
    try {
      pkg = JSON.parse(await fsp.readFile(path.join(packageRoot, 'package.json'), 'utf-8')) as Record<string, unknown>;
    } catch (err) {
      throw new Error(`Installed package has no readable package.json: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (pkg.name !== resolved.name || pkg.version !== resolved.version) {
      throw new Error(`Installed package is ${String(pkg.name)}@${String(pkg.version)}, expected ${resolved.resolved}.`);
    }
    const verified = await verifyInstallReceipt(stagingDir, packageRoot, resolved);

    // A Walnut plugin is a manifest at the package root. Without it the install
    // would land a directory the loader silently ignores.
    const manifestPath = path.join(packageRoot, 'manifest.json');
    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf-8')) as Record<string, unknown>;
    } catch (err) {
      const missing = err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
      throw new Error(missing
        ? `${resolved.resolved} is not a Walnut plugin: no manifest.json at the package root.`
        : `${resolved.resolved} has an invalid manifest.json: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (typeof manifest.id !== 'string' || !manifest.id.trim()) {
      throw new Error(`${resolved.resolved} has a manifest.json without a string "id".`);
    }

    return { stagingDir, packageRoot, resolved: verified };
  } catch (err) {
    // Only ever remove the staging dir THIS call created.
    await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

// ── Public install / replace ──

async function pathExists(target: string): Promise<boolean> {
  try {
    await fsp.lstat(target);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

export interface NpmInstallResult extends ResolvedNpmPackage {
  /** Integrity read from npm's installed-tree receipt, not the earlier metadata lookup. */
  integrity: string;
  /** Final on-disk plugin directory. */
  dir: string;
}

/** First install: the final directory must not exist. */
export async function installNpmPlugin(opts: {
  spec: string;
  finalDir: string;
  stagingRoot: string;
  resolved?: ResolvedNpmPackage;
}): Promise<NpmInstallResult> {
  if (await pathExists(opts.finalDir)) {
    throw new Error(`${opts.finalDir} already exists. Remove the existing source first.`);
  }
  const staged = await stagePackage(opts.spec, opts.stagingRoot, opts.resolved);
  try {
    await fsp.rename(staged.packageRoot, opts.finalDir);
  } finally {
    await fsp.rm(staged.stagingDir, { recursive: true, force: true }).catch(() => {});
  }
  log.info('npm plugin installed', { resolved: staged.resolved.resolved, dir: opts.finalDir });
  return { ...staged.resolved, dir: opts.finalDir };
}

/**
 * Update in place: stage the new version, move the old tree aside on the same
 * filesystem, swap, and roll back if the swap fails. Never leaves the plugin dir
 * missing on a failed update.
 */
export async function replaceNpmPlugin(opts: {
  spec: string;
  finalDir: string;
  stagingRoot: string;
  resolved?: ResolvedNpmPackage;
  commit?: (installed: NpmInstallResult) => Promise<void>;
}): Promise<NpmInstallResult> {
  const staged = await stagePackage(opts.spec, opts.stagingRoot, opts.resolved);
  const backupDir = path.join(
    opts.stagingRoot,
    `.backup-${path.basename(opts.finalDir)}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
  );
  const installed: NpmInstallResult = { ...staged.resolved, dir: opts.finalDir };
  let backedUp = false;
  let swappedIn = false;
  let completed = false;
  try {
    if (await pathExists(opts.finalDir)) {
      await fsp.rename(opts.finalDir, backupDir);
      backedUp = true;
    }
    await fsp.rename(staged.packageRoot, opts.finalDir);
    swappedIn = true;
    await opts.commit?.(installed);
    completed = true;
  } catch (error) {
    let rollbackError: unknown;
    if (swappedIn) {
      try {
        await fsp.rm(opts.finalDir, { recursive: true, force: true });
        swappedIn = false;
      } catch (failure) {
        rollbackError = failure;
      }
    }
    if (backedUp && !rollbackError) {
      try {
        await fsp.rename(backupDir, opts.finalDir);
        backedUp = false;
      } catch (failure) {
        rollbackError = failure;
      }
    }
    if (rollbackError) {
      const original = sanitizeNpmOutput(error instanceof Error ? error.message : String(error));
      const rollback = sanitizeNpmOutput(rollbackError instanceof Error ? rollbackError.message : String(rollbackError));
      log.error('npm Plugin update and rollback failed', {
        finalDir: opts.finalDir,
        backupDir: backedUp ? backupDir : undefined,
        error: original,
        rollbackError: rollback,
      });
      const preservation = backedUp
        ? `Previous version is preserved at "${backupDir}".`
        : 'No previous version backup was available.';
      throw new Error(
        `npm Plugin update failed and rollback also failed. ${preservation} `
        + `Original error: ${original}. Rollback error: ${rollback}.`,
      );
    }
    throw error;
  } finally {
    await fsp.rm(staged.stagingDir, { recursive: true, force: true }).catch(() => undefined);
    if (completed && backedUp) {
      await fsp.rm(backupDir, { recursive: true, force: true }).catch((error) => {
        log.warn('could not remove old npm Plugin backup', { backupDir, error: String(error) });
      });
    }
  }
  log.info('npm plugin updated', { resolved: staged.resolved.resolved, dir: opts.finalDir });
  return installed;
}
