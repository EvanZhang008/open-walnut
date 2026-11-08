import fs from 'node:fs/promises';
import path from 'node:path';
import { log } from '../logging/index.js';
import { sshDir, sshHome } from '../lib/ssh-home.js';

export interface DiscoveredHost {
  alias: string;
  hostname: string;
  user?: string;
  port?: number;
  label?: string;
}

/** Hosts that are git/code servers, not shells you can run sessions on.
 *  `User git` is the canonical signal (github/gitlab style); the name prefixes
 *  catch git servers that use a personal user (e.g. git.example.com). */
function isGitServerHost(h: DiscoveredHost): boolean {
  if (h.user === 'git') return true;
  const gitPrefix = /^(git|github|gitlab|bitbucket|codecommit|ssh\.github)\./i;
  return gitPrefix.test(h.alias) || gitPrefix.test(h.hostname);
}

/** Auto-generate a short display label for a raw FQDN entry.
 *  'build-box-jdoe-2b-2f7e54b8.us-west-2.example.com' → 'build-box…2f7e54b8'
 *  Keeps the first name segment's prefix + its trailing uniqueness token so
 *  near-identical machine names stay distinguishable at a glance. */
export function shortLabelForFqdn(hostname: string): string {
  const first = hostname.split('.')[0];
  if (first.length <= 24) return first;
  const parts = first.split('-');
  if (parts.length >= 3) {
    // prefix (first two tokens) + last token (usually the unique hash)
    return `${parts[0]}-${parts[1]}…${parts[parts.length - 1]}`;
  }
  return `${first.slice(0, 12)}…${first.slice(-8)}`;
}

// ── mtime cache ──
// scanSshConfig is called from getConfig(), which sits on the request hot path —
// without a cache every API call re-reads + re-parses ~/.ssh/config and spams an
// INFO log line. Cache by the mtime of every file (and Include glob directory) the
// last parse read: those changing is the ONLY thing that can change the result.
interface ScanCacheEntry { stamps: Array<{ path: string; mtimeMs: number }>; result: Map<string, DiscoveredHost> }
const scanCache = new Map<string, ScanCacheEntry>();

/** Reset the scan cache (tests only). */
export function _resetScanCacheForTest(): void {
  scanCache.clear();
}

async function mtimeOf(p: string): Promise<number | null> {
  try { return (await fs.stat(p)).mtimeMs; } catch { return null; }
}

async function cacheStillValid(entry: ScanCacheEntry): Promise<boolean> {
  for (const s of entry.stamps) if ((await mtimeOf(s.path)) !== s.mtimeMs) return false;
  return true;
}

/**
 * Parse ~/.ssh/config and extract Host entries.
 * Returns a map of alias → host config. Cached by file mtimes — call freely
 * from hot paths; a re-parse (and its log line) happens only when a file it
 * read actually changed.
 *
 * Resolution follows ssh's own rules for what a config file alone can decide
 * (ssh_config(5)): every name on a `Host` line that is not a pattern is an alias;
 * each alias takes the FIRST value of HostName / User / Port from the blocks that
 * apply to it, in file order (options before any Host line, `Host` blocks whose
 * patterns match it, wildcards and `!negations` included, and `Match all`);
 * `Include` files are read in place (globs, `~`, paths relative to ~/.ssh). A
 * `Match` block other than `Match all` needs ssh itself to evaluate, so it is
 * skipped. `%h` in HostName is the alias.
 *
 * Customer-experience filters applied before returning:
 *  - git/code servers dropped (you can't run a Claude Code session on github)
 *  - one entry per SSH target: aliases that reach the same (HostName, Port, User)
 *    are one entry, preferring a human-made short alias (Host olddev → HostName
 *    build-box-…) over the raw FQDN. Two aliases of one HostName with another
 *    port or user are two targets (containers, forwards) and both stay.
 */
export async function scanSshConfig(configPath?: string): Promise<Map<string, DiscoveredHost>> {
  // The home is sshHome(): $HOME, or the account's in Walnut Demo after "Use my SSH hosts".
  const sshConfigPath = configPath ?? path.join(sshDir(), 'config');

  // No file → no discovered hosts (a single stat, cheap to repeat).
  if ((await mtimeOf(sshConfigPath)) === null) return new Map();
  const cached = scanCache.get(sshConfigPath);
  if (cached && await cacheStillValid(cached)) return cached.result;

  const stamps: ScanCacheEntry['stamps'] = [];
  const result = await parseSshConfigFile(sshConfigPath, stamps);
  scanCache.set(sshConfigPath, { stamps, result });
  return result;
}

/** One block of the config: options before any Host line (`all`), a Host line's patterns, or a Match. */
interface Block {
  match: { kind: 'all' } | { kind: 'host'; patterns: string[] } | { kind: 'never' };
  opts: Map<string, string>;
}

const MAX_INCLUDE_DEPTH = 16; // ssh's own READCONF_MAX_DEPTH
const KEPT_OPTIONS = new Set(['hostname', 'user', 'port']);

/** `Keyword value`, `Keyword=value`, `Keyword = value`; a quoted value keeps its spaces. */
function splitDirective(line: string): { key: string; args: string[] } | null {
  const m = /^([A-Za-z]+)\s*(?:=\s*|\s+)(.*)$/.exec(line);
  if (!m) return null;
  const args: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let a: RegExpExecArray | null;
  while ((a = re.exec(m[2])) !== null) args.push(a[1] ?? a[2]);
  return { key: m[1].toLowerCase(), args };
}

/** ssh's pattern match: `*` any run, `?` one character, case-insensitive. */
function globMatch(pattern: string, name: string): boolean {
  const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
  return re.test(name);
}

function isPattern(name: string): boolean {
  return name.includes('*') || name.includes('?') || name.startsWith('!');
}

/** A Host line applies to a name: one positive pattern matches and no negated one does. */
function hostLineMatches(patterns: readonly string[], name: string): boolean {
  let hit = false;
  for (const p of patterns) {
    if (p.startsWith('!')) { if (globMatch(p.slice(1), name)) return false; }
    else if (globMatch(p, name)) hit = true;
  }
  return hit;
}

function expandTilde(p: string): string {
  const home = sshHome();
  return p === '~' ? home : p.startsWith('~/') ? path.join(home, p.slice(2)) : p;
}

/** The files one `Include` argument names, sorted as ssh's glob(3) returns them. */
async function includeFiles(arg: string, baseDir: string, stamps: ScanCacheEntry['stamps']): Promise<string[]> {
  const full = path.isAbsolute(expandTilde(arg)) ? expandTilde(arg) : path.join(baseDir, arg);
  const dir = path.dirname(full);
  const base = path.basename(full);
  if (!isPattern(base) || base.startsWith('!')) {
    const m = await mtimeOf(full);
    stamps.push({ path: full, mtimeMs: m ?? -1 });
    return m === null ? [] : [full];
  }
  // A glob in the last part: the directory's mtime changes when a file comes or goes.
  stamps.push({ path: dir, mtimeMs: (await mtimeOf(dir)) ?? -1 });
  let names: string[];
  try { names = await fs.readdir(dir); } catch { return []; }
  return names.filter((n) => !n.startsWith('.') && globMatch(base, n)).sort().map((n) => path.join(dir, n));
}

/** Read one file into `blocks`, Include files in place. */
async function readInto(
  file: string, blocks: Block[], aliases: string[], ctx: { baseDir: string; stamps: ScanCacheEntry['stamps']; depth: number },
): Promise<void> {
  if (ctx.depth > MAX_INCLUDE_DEPTH) return;
  // Stamp BEFORE reading: an edit between the two then leaves a stamp older than the
  // file, so the next scan reads it again. Stamped after, the cache would hold the old
  // content under the new mtime and never notice the edit.
  if (!ctx.stamps.some((s) => s.path === file)) ctx.stamps.push({ path: file, mtimeMs: (await mtimeOf(file)) ?? -1 });
  let content: string;
  try {
    content = await fs.readFile(file, 'utf-8');
  } catch (err) {
    if (ctx.depth === 0) throw err;
    return; // an Include that cannot be read is skipped, as ssh skips a glob with no match
  }
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const d = splitDirective(line);
    if (!d) continue;
    if (d.key === 'host') {
      blocks.push({ match: { kind: 'host', patterns: d.args }, opts: new Map() });
      for (const name of d.args) if (!isPattern(name) && !aliases.includes(name)) aliases.push(name);
      continue;
    }
    if (d.key === 'match') {
      const all = d.args.length === 1 && d.args[0].toLowerCase() === 'all';
      blocks.push({ match: all ? { kind: 'all' } : { kind: 'never' }, opts: new Map() });
      continue;
    }
    if (d.key === 'include') {
      for (const arg of d.args) {
        for (const inc of await includeFiles(arg, ctx.baseDir, ctx.stamps)) {
          await readInto(inc, blocks, aliases, { ...ctx, depth: ctx.depth + 1 });
        }
      }
      continue;
    }
    if (!KEPT_OPTIONS.has(d.key) || d.args.length === 0) continue;
    const block = blocks[blocks.length - 1];
    // First value wins inside a block too (ssh never overwrites an option once set).
    if (!block.opts.has(d.key)) block.opts.set(d.key, d.args[0]);
  }
}

/** What ssh would resolve for `alias` from the blocks alone (first value wins). */
function resolveAlias(alias: string, blocks: readonly Block[]): DiscoveredHost {
  const got = new Map<string, string>();
  for (const b of blocks) {
    const applies = b.match.kind === 'all' || (b.match.kind === 'host' && hostLineMatches(b.match.patterns, alias));
    if (!applies) continue;
    for (const [k, v] of b.opts) if (!got.has(k)) got.set(k, v);
  }
  const host: DiscoveredHost = { alias, hostname: (got.get('hostname') ?? alias).replace(/%h/g, () => alias).replace(/%%/g, '%') };
  const user = got.get('user');
  if (user) host.user = user;
  const port = got.get('port');
  if (port && /^\d+$/.test(port)) {
    const n = Number.parseInt(port, 10);
    if (n > 0 && n < 65536) host.port = n;
  }
  return host;
}

/** The SSH target an alias reaches: one entry per target. */
export function sshTargetKey(h: Pick<DiscoveredHost, 'hostname' | 'port' | 'user'>): string {
  return `${h.hostname.toLowerCase()}:${h.port ?? 22}:${h.user ?? ''}`;
}

/** Parse a config file's text (and its Includes) into the found hosts. Exported for tests. */
export async function parseSshConfigFile(sshConfigPath: string, stamps: ScanCacheEntry['stamps'] = []): Promise<Map<string, DiscoveredHost>> {
  const discovered = new Map<string, DiscoveredHost>();

  try {
    // Options before the first Host line apply to every host.
    const blocks: Block[] = [{ match: { kind: 'all' }, opts: new Map() }];
    const aliases: string[] = [];
    await readInto(sshConfigPath, blocks, aliases, { baseDir: sshDir(), stamps, depth: 0 });
    for (const alias of aliases) discovered.set(alias, resolveAlias(alias, blocks));

    // ── CX filters ──
    // 1. Drop git/code servers — no shell to run a session on.
    for (const [alias, h] of discovered) {
      if (isGitServerHost(h)) discovered.delete(alias);
    }
    // 2. Dedupe by SSH target (hostname, port, user) — one target, one entry. Prefer a
    //    human short alias ('olddev') over a self-referential FQDN entry (tool-generated,
    //    e.g. WSSH setup blocks where Host == HostName).
    const byTarget = new Map<string, DiscoveredHost>();
    for (const h of discovered.values()) {
      const key = sshTargetKey(h);
      const existing = byTarget.get(key);
      if (!existing) {
        byTarget.set(key, h);
        continue;
      }
      const existingIsShortAlias = existing.alias !== existing.hostname;
      const candidateIsShortAlias = h.alias !== h.hostname;
      if (candidateIsShortAlias && !existingIsShortAlias) byTarget.set(key, h);
    }
    // 3. FQDN-only entries (no human alias anywhere) still import — a real
    //    machine must never be silently dropped — but get an auto-generated
    //    short label so the UI isn't a wall of 50-char hostnames. The user
    //    can toggle off dead boxes in Settings.
    const result = new Map<string, DiscoveredHost>();
    for (const h of byTarget.values()) {
      if (h.alias === h.hostname && !h.label) h.label = shortLabelForFqdn(h.hostname);
      result.set(h.alias, h);
    }

    log.session.info('ssh-config-scanner: discovered hosts', {
      count: result.size,
      dropped: discovered.size - result.size,
    });
    return result;

  } catch (err) {
    // File not found or unreadable — not an error, just no discovered hosts
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      log.session.debug('ssh-config-scanner: no ~/.ssh/config found');
    } else {
      log.session.warn('ssh-config-scanner: failed to parse SSH config', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return discovered;
  }
}
