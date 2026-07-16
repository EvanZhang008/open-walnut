import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { log } from '../logging/index.js';

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
 *  'dev-dsk-jdoe-2b-2f7e54b8.us-west-2.example.com' → 'dev-dsk…2f7e54b8'
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
// INFO log line. Cache by (path, mtime): the file changing is the ONLY thing that
// can change the result.
const scanCache = new Map<string, { mtimeMs: number; result: Map<string, DiscoveredHost> }>();

/** Reset the scan cache (tests only). */
export function _resetScanCacheForTest(): void {
  scanCache.clear();
}

/**
 * Parse ~/.ssh/config and extract Host entries.
 * Returns a map of alias → host config. Cached by file mtime — call freely
 * from hot paths; a re-parse (and its log line) happens only when the file
 * actually changed.
 *
 * Customer-experience filters applied before returning:
 *  - git/code servers dropped (you can't run a Claude Code session on github)
 *  - one entry per machine: entries deduped by hostname, preferring a
 *    human-made short alias (Host olddev → HostName dev-dsk-…) over the raw FQDN
 *
 * Handles basic Host directives. Doesn't support all SSH config features
 * (includes, wildcards, Match blocks) — this is intentionally minimal for
 * zero-config discovery.
 */
export async function scanSshConfig(configPath?: string): Promise<Map<string, DiscoveredHost>> {
  const sshConfigPath = configPath ?? path.join(os.homedir(), '.ssh', 'config');

  let mtimeMs: number;
  try {
    mtimeMs = (await fs.stat(sshConfigPath)).mtimeMs;
  } catch {
    // No file → no discovered hosts. Cache under mtime 0 semantics not needed;
    // an empty map is cheap to rebuild and ENOENT stat is a single syscall.
    return new Map();
  }
  const cached = scanCache.get(sshConfigPath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.result;

  const result = await parseSshConfigFile(sshConfigPath);
  scanCache.set(sshConfigPath, { mtimeMs, result });
  return result;
}

async function parseSshConfigFile(sshConfigPath: string): Promise<Map<string, DiscoveredHost>> {
  const discovered = new Map<string, DiscoveredHost>();

  try {
    const content = await fs.readFile(sshConfigPath, 'utf-8');
    const lines = content.split('\n');

    let currentHost: DiscoveredHost | null = null;

    for (const rawLine of lines) {
      const line = rawLine.trim();

      // Skip comments and empty lines
      if (!line || line.startsWith('#')) continue;

      // Host directive
      if (line.match(/^Host\s+/i)) {
        // Save previous host
        if (currentHost && currentHost.hostname) {
          discovered.set(currentHost.alias, currentHost);
        }

        // Extract host alias (first word after Host, no wildcards)
        const hostMatch = line.match(/^Host\s+(\S+)/i);
        if (hostMatch) {
          const alias = hostMatch[1];
          // Skip wildcards
          if (alias.includes('*') || alias.includes('?')) {
            currentHost = null;
            continue;
          }
          currentHost = { alias, hostname: alias }; // Default hostname = alias
        }
        continue;
      }

      if (!currentHost) continue;

      // HostName
      const hostnameMatch = line.match(/^HostName\s+(\S+)/i);
      if (hostnameMatch) {
        currentHost.hostname = hostnameMatch[1];
        continue;
      }

      // User
      const userMatch = line.match(/^User\s+(\S+)/i);
      if (userMatch) {
        currentHost.user = userMatch[1];
        continue;
      }

      // Port
      const portMatch = line.match(/^Port\s+(\d+)/i);
      if (portMatch) {
        currentHost.port = Number.parseInt(portMatch[1], 10);
        continue;
      }
    }

    // Don't forget the last host
    if (currentHost && currentHost.hostname) {
      discovered.set(currentHost.alias, currentHost);
    }

    // ── CX filters ──
    // 1. Drop git/code servers — no shell to run a session on.
    for (const [alias, h] of discovered) {
      if (isGitServerHost(h)) discovered.delete(alias);
    }
    // 2. Dedupe by hostname — one machine, one entry. Prefer a human short
    //    alias ('olddev') over a self-referential FQDN entry (tool-generated,
    //    e.g. WSSH setup blocks where Host == HostName).
    const byHostname = new Map<string, DiscoveredHost>();
    for (const h of discovered.values()) {
      const key = h.hostname.toLowerCase();
      const existing = byHostname.get(key);
      if (!existing) {
        byHostname.set(key, h);
        continue;
      }
      const existingIsShortAlias = existing.alias !== existing.hostname;
      const candidateIsShortAlias = h.alias !== h.hostname;
      if (candidateIsShortAlias && !existingIsShortAlias) byHostname.set(key, h);
    }
    // 3. FQDN-only entries (no human alias anywhere) still import — a real
    //    machine must never be silently dropped — but get an auto-generated
    //    short label so the UI isn't a wall of 50-char hostnames. The user
    //    can toggle off dead boxes in Settings.
    const result = new Map<string, DiscoveredHost>();
    for (const h of byHostname.values()) {
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
