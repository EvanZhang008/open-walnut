/**
 * What Walnut has learned about each execution host, so work moved there
 * starts with the right expectations: what kind of machine it is, what is
 * installed, where repositories live, which other hosts it can reach, and the
 * notes sessions left after setting things up.
 *
 * Three layers, each with its own writer:
 *   probed   — the host's daemon measured it (host.facts); refreshed on use.
 *   observed — Walnut saw it happen (a repo cloned at a path, a direct copy
 *              that worked or failed).
 *   notes    — a session wrote it down (host_note_add), newest per key wins.
 * Nothing here is required: a host with no profile can still take a transfer,
 * and that transfer is what fills the profile in.
 *
 * Stored as ~/.open-walnut/hosts/<alias>.json, which git-sync carries to the
 * companion. Machine facts only; never credentials or proxy values.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { WALNUT_HOME } from '../../constants.js';

export const HOST_PROFILES_DIR = path.join(WALNUT_HOME, 'hosts');
const MAX_NOTES = 50;
const MAX_REPO_PATHS = 100;
export const PROBE_MAX_AGE_MS = 7 * 24 * 3600_000;

export type HostKind = 'laptop' | 'public-cloud-vm' | 'private-cloud-vm' | 'dev-box' | 'unknown';

/** The daemon's host.facts reply (providers/host-facts-core.ts), as stored. */
export type HostFacts = import('../../providers/host-facts-core.js').HostFacts;

export interface HostNote { key: string; fact: string; evidence?: string; at: string; taskId?: string }

export interface HostProfile {
  host: string;
  kind: HostKind;
  kindReasons: string[];
  /** The user named the kind; probes no longer change it. */
  kindSetByUser?: boolean;
  userNote?: string;
  probed?: HostFacts;
  observed: {
    /** repo key (remote URL, else folder name) → path on this host. */
    repoPaths: Record<string, { path: string; at: string }>;
    /** other host alias → can this host copy files from it directly. */
    reaches: Record<string, { ok: boolean; at: string; error?: string }>;
  };
  notes: HostNote[];
  updatedAt: string;
}

const SAFE_ALIAS = /^[A-Za-z0-9._@-]{1,128}$/;

function profilePath(host: string): string {
  if (!SAFE_ALIAS.test(host)) throw Object.assign(new Error(`Invalid host alias: ${host}`), { status: 400, code: 'bad_host' });
  return path.join(HOST_PROFILES_DIR, `${host}.json`);
}

function emptyProfile(host: string): HostProfile {
  return { host, kind: 'unknown', kindReasons: [], observed: { repoPaths: {}, reaches: {} }, notes: [], updatedAt: new Date().toISOString() };
}

export async function readHostProfile(host: string): Promise<HostProfile> {
  try {
    const raw = JSON.parse(await fs.readFile(profilePath(host), 'utf8')) as Partial<HostProfile>;
    const base = emptyProfile(host);
    return {
      ...base, ...raw, host,
      observed: { repoPaths: { ...(raw.observed?.repoPaths ?? {}) }, reaches: { ...(raw.observed?.reaches ?? {}) } },
      notes: Array.isArray(raw.notes) ? raw.notes : [],
      kindReasons: Array.isArray(raw.kindReasons) ? raw.kindReasons : [],
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyProfile(host);
    throw err;
  }
}

const chains = new Map<string, Promise<unknown>>();

/** Read-modify-write one host's profile, serialized per host, written atomically. */
export async function updateHostProfile(host: string, mutate: (p: HostProfile) => void): Promise<HostProfile> {
  const run = (chains.get(host) ?? Promise.resolve()).then(async () => {
    const profile = await readHostProfile(host);
    mutate(profile);
    profile.updatedAt = new Date().toISOString();
    await fs.mkdir(HOST_PROFILES_DIR, { recursive: true });
    const file = profilePath(host);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(profile, null, 2)}\n`, 'utf8');
    await fs.rename(tmp, file);
    return profile;
  });
  chains.set(host, run.catch(() => undefined));
  return run;
}

/** Name the kind of machine from what the probe saw. Generic signals only. */
export function classifyHost(facts: HostFacts): { kind: HostKind; reasons: string[] } {
  const reasons: string[] = [];
  const platform = facts.os?.platform;
  if (facts.cloud?.imds) {
    const where = [facts.cloud.provider, facts.cloud.instanceType, facts.cloud.region].filter(Boolean).join(' ');
    reasons.push(`cloud instance metadata answers${where ? ` (${where})` : ''}`);
    if (facts.cloud.hasPublicIpv4) {
      reasons.push('it has a public IPv4 address');
      return { kind: 'public-cloud-vm', reasons };
    }
    reasons.push('no public IPv4 address');
    if (facts.proxyEnv?.http || facts.proxyEnv?.https) reasons.push('traffic goes through a proxy');
    return { kind: 'private-cloud-vm', reasons };
  }
  if (platform === 'darwin' || platform === 'win32') {
    reasons.push(`${platform === 'darwin' ? 'macOS' : 'Windows'} without cloud metadata`);
    return { kind: 'laptop', reasons };
  }
  if (platform === 'linux') {
    const domain = facts.fqdn && facts.fqdn.includes('.') ? facts.fqdn.split('.').slice(1).join('.') : '';
    if (domain) reasons.push(`its name is in the ${domain} domain`);
    if (facts.proxyEnv?.http || facts.proxyEnv?.https) reasons.push('traffic goes through a proxy');
    if (facts.internet?.github === false) reasons.push('github.com is not reachable directly');
    if (domain || reasons.length > 0) return { kind: 'dev-box', reasons };
    reasons.push('Linux without cloud metadata');
    return { kind: 'unknown', reasons };
  }
  return { kind: 'unknown', reasons: ['not enough signals yet'] };
}

export async function recordProbedFacts(host: string, facts: HostFacts): Promise<HostProfile> {
  return updateHostProfile(host, (p) => {
    p.probed = { ...facts, probedAt: facts.probedAt ?? new Date().toISOString() };
    if (!p.kindSetByUser) {
      const { kind, reasons } = classifyHost(facts);
      p.kind = kind;
      p.kindReasons = reasons;
    }
  });
}

export function probeIsStale(profile: HostProfile, now = Date.now()): boolean {
  const at = Date.parse(profile.probed?.probedAt ?? '');
  return !Number.isFinite(at) || now - at > PROBE_MAX_AGE_MS;
}

/** A stable key for a repository: its first remote URL without credentials, else its folder name. */
export function repoKey(remoteUrl: string | undefined, folder: string): string {
  if (remoteUrl) {
    return remoteUrl.trim().replace(/\/\/[^@/]+@/, '//').replace(/\.git$/, '').toLowerCase();
  }
  return `dir:${folder}`;
}

export async function recordRepoPath(host: string, key: string, repoPath: string): Promise<void> {
  await updateHostProfile(host, (p) => {
    p.observed.repoPaths[key] = { path: repoPath, at: new Date().toISOString() };
    const keys = Object.keys(p.observed.repoPaths);
    if (keys.length > MAX_REPO_PATHS) {
      keys.sort((a, b) => p.observed.repoPaths[a].at.localeCompare(p.observed.repoPaths[b].at));
      for (const k of keys.slice(0, keys.length - MAX_REPO_PATHS)) delete p.observed.repoPaths[k];
    }
  });
}

export async function recordReach(host: string, fromHost: string, ok: boolean, error?: string): Promise<void> {
  await updateHostProfile(host, (p) => {
    p.observed.reaches[fromHost] = { ok, at: new Date().toISOString(), ...(error ? { error: error.slice(0, 300) } : {}) };
  });
}

export async function addHostNote(host: string, note: Omit<HostNote, 'at'>): Promise<HostProfile> {
  const key = note.key.trim().toLowerCase().slice(0, 80);
  const fact = note.fact.trim().slice(0, 600);
  if (!key || !fact) throw new Error('A host note needs a key and a fact');
  return updateHostProfile(host, (p) => {
    p.notes = p.notes.filter((n) => n.key !== key);
    p.notes.push({ key, fact, ...(note.evidence ? { evidence: note.evidence.trim().slice(0, 600) } : {}), at: new Date().toISOString(), ...(note.taskId ? { taskId: note.taskId } : {}) });
    if (p.notes.length > MAX_NOTES) p.notes = p.notes.slice(p.notes.length - MAX_NOTES);
  });
}

const GIB = 1024 ** 3;

/** A few lines for a session's first message: what it is about to work on. */
export function hostProfileSummary(profile: HostProfile, label: string): string {
  const lines: string[] = [];
  const f = profile.probed;
  const kindText: Record<HostKind, string> = {
    'laptop': 'a personal computer',
    'public-cloud-vm': 'a cloud VM with a public address',
    'private-cloud-vm': 'a cloud VM on a private network',
    'dev-box': 'a managed development machine',
    'unknown': 'a machine Walnut has not classified yet',
  };
  lines.push(`Host "${label}" is ${kindText[profile.kind]}${profile.kindReasons.length ? ` (${profile.kindReasons.join('; ')})` : ''}.`);
  if (profile.userNote) lines.push(`The user says: ${profile.userNote}`);
  if (f) {
    const os = f.os?.prettyName || [f.os?.platform, f.os?.release].filter(Boolean).join(' ');
    const size = [f.cpus ? `${f.cpus} CPUs` : '', f.memBytes ? `${Math.round(f.memBytes / GIB)} GB RAM` : '',
      f.diskFreeBytes ? `${Math.round(f.diskFreeBytes / GIB)} GB free disk` : ''].filter(Boolean).join(', ');
    lines.push(`System: ${[os, f.arch].filter(Boolean).join(' ')}${size ? `, ${size}` : ''}. Home: ${f.home ?? 'unknown'}.`);
    const tools = Object.entries(f.tools ?? {});
    const have = tools.filter(([, v]) => v).map(([k, v]) => `${k} ${String(v).replace(/^[^0-9]*/, '').split(/\s/)[0] || ''}`.trim());
    const missing = tools.filter(([, v]) => !v).map(([k]) => k);
    if (have.length) lines.push(`Installed: ${have.join(', ')}.`);
    if (missing.length) lines.push(`Not found on PATH: ${missing.join(', ')}.`);
    if (f.proxyEnv?.http || f.proxyEnv?.https) lines.push('A proxy is configured in the environment.');
    if (f.internet?.github === false) lines.push('github.com did not answer directly from this host.');
    if (f.uptimeSec && f.uptimeSec > 3 * 86400) lines.push(`It has been up for ${Math.floor(f.uptimeSec / 86400)} days (likely always on).`);
  } else {
    lines.push('No probe of this host yet: check what is installed before relying on it.');
  }
  const repos = Object.entries(profile.observed.repoPaths).slice(-8).map(([k, v]) => `${k.replace(/^dir:/, '')} at ${v.path}`);
  if (repos.length) lines.push(`Known repositories: ${repos.join('; ')}.`);
  const notes = profile.notes.slice(-12).map((n) => `- ${n.key}: ${n.fact}`);
  if (notes.length) lines.push('Notes from earlier sessions on this host:', ...notes);
  return lines.join('\n');
}
