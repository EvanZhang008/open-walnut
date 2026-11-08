/**
 * The words of a host's Details (HostFleetVitals.tsx): pure, so each rule has a
 * unit test (web/src/__tests__/host-fleet-model.test.ts). Every reading may be
 * missing; a missing one says why in plain words instead of a dash.
 */
import type { FleetBucket, FleetHost } from '@/api/hosts-fleet';

export interface FleetRow { key: string; label: string; value: string; tone?: 'good' | 'warn' | 'bad' | 'muted'; title?: string }

const GB = 1024 ** 3;

export function gb(bytes: number | null | undefined): string | null {
  if (typeof bytes !== 'number' || !(bytes > 0)) return null;
  const v = bytes / GB;
  return `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10} GB`;
}

export function pct(share: number | null | undefined, digits = 0): string | null {
  if (typeof share !== 'number' || !Number.isFinite(share)) return null;
  const f = 10 ** digits;
  return `${Math.round(share * 100 * f) / f}%`;
}

/** 13 d, 5 h, 20 min, 40 s. */
export function span(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s >= 2 * 86400) return `${Math.round(s / 86400)} d`;
  if (s >= 2 * 3600) return `${Math.round(s / 3600)} h`;
  if (s >= 120) return `${Math.round(s / 60)} min`;
  return `${s} s`;
}

/** Recorded minutes in words: minutes under an hour, hours under a day, then days (src/core/hosts/fleet-model.ts recordedSpan). */
export function recordedSpan(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return m === 1 ? '1 minute' : `${m} minutes`;
  if (m < 1440) { const h = Math.round(m / 6) / 10; return h === 1 ? '1 hour' : `${h} hours`; }
  const d = Math.round(m / 144) / 10;
  return d === 1 ? '1 day' : `${d} days`;
}

export function usd(v: number): string {
  return `$${Math.round(v).toLocaleString('en-US')}`;
}

/** The local machine's name on Remote Hosts (the rest of the page says "this Mac" too). */
export const THIS_MAC = 'This Mac';

const KIND_LABEL: Record<FleetHost['connection']['kind'], string> = { local: THIS_MAC, 'ssh-tunnel': 'SSH tunnel', 'host-network': 'Host network', bridge: 'It connects in to this Mac' };

/** One cell per day: how much of the minutes the ledger covered the host was up. */
export function dayTone(b: FleetBucket): 'good' | 'warn' | 'bad' | 'none' {
  if (!b.minutes) return 'none';
  const share = b.up / b.minutes;
  return share >= 0.99 ? 'good' : share >= 0.9 ? 'warn' : 'bad';
}

/** Buckets end at the time of the reading, so a cell is named by the 24 hours (or the span) it ends. */
export function dayTitle(b: FleetBucket, bucketMinutes: number): string {
  const end = new Date(b.start + bucketMinutes * 60_000);
  const day = end.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const head = `${span(bucketMinutes * 60_000)} to ${day}`;
  if (!b.minutes) return `${head}: no record yet`;
  return `${head}: up ${pct(b.up / b.minutes, 1)}, linked ${pct(b.linked / b.minutes, 1)}`;
}

/**
 * The reading is stale because the host did not answer (a live read past its deadline, or a
 * cached card whose last read failed), not only because the cached card is old: an old card
 * says its age in its own line ("Read 2 h ago"), and is no host to look at.
 */
export function notAnswering(h: FleetHost): boolean {
  return !!h.now?.stale && (h.readAt === undefined || !!h.readError);
}

export function statusKind(h: FleetHost): 'connected' | 'failed' | 'off' | 'warn' {
  if (h.connection.connected) return notAnswering(h) || h.connection.unstable ? 'warn' : 'connected';
  return h.connection.phase === 'failed' ? 'failed' : 'off';
}

/** A capability the host could not tell yet, named first so the reader sees which one. */
const UNKNOWN_WORDS: Record<string, string> = {
  ios: 'iOS: not reported yet',
  browser: 'browser: not reported yet',
  mcp: 'MCP servers: not reported yet',
  // Not the daemon's word: the uptime ledger needs a day before it can say.
  'always-on': 'always on: known after a day of uptime records',
};

/** What a task can use this host for (capabilities.ts on the server): iOS, the user's browser, tools, MCP servers. */
export function canDoRow(h: FleetHost): FleetRow | null {
  const c = h.capabilities;
  if (!c) return null;
  const parts: string[] = [];
  if (c.ios) parts.push(c.ios.runtimes.length ? `iOS (${c.ios.xcode}, ${c.ios.runtimes.join(', ')})` : `${c.ios.xcode}, no iOS simulator runtime`);
  const relayed = c.browsers.filter((b) => b.relay).map((b) => b.name);
  if (relayed.length) parts.push(`your browser (${relayed.join(', ')})`);
  if (c.alwaysOn) parts.push('always on');
  if (c.tags.includes('docker')) parts.push('docker');
  if (c.mcp.length) parts.push(`${c.mcp.length} MCP server${c.mcp.length === 1 ? '' : 's'}`);
  for (const t of c.declared) if (!['cloud', 'local', 'always-on'].includes(t)) parts.push(t);
  const unknown = c.unknown.filter((u) => u !== 'system').map((u) => UNKNOWN_WORDS[u] ?? `${u}: not reported yet`);
  const value = [...parts, ...unknown].join(', ') || 'Nothing beyond its system';
  const title = [
    c.tags.length ? `A task asks for a host by tag (host "@ios"). This one's tags: ${c.tags.join(', ')}` : '',
    c.mcp.length ? `MCP: ${c.mcp.map((m) => (m.plugin ? `${m.name} (${m.plugin})` : m.offered ? `${m.name} (offered to other hosts)` : m.name)).join(', ')}` : '',
    c.clis.length ? `Tools: ${c.clis.join(', ')}` : '',
  ].filter(Boolean).join('\n');
  return { key: 'can', label: 'Can do', value, tone: parts.length ? undefined : 'muted', ...(title ? { title } : {}) };
}

/**
 * The facts table under a host's Details. Each fact is said once on the page (2026-11-04 review:
 * the system line, sessions, spend and the reboot warning each showed two or three times): the
 * system is the Details' first line, CPU and memory are its rings, sessions and spend its two
 * numbers, a problem is its row's line or the Details' problem list, and Walnut on the host is in
 * "This host". What is left is said here.
 */
export function fleetRows(h: FleetHost, now: number): FleetRow[] {
  const rows: FleetRow[] = [];
  const can = canDoRow(h);
  if (can) rows.push(can);
  if (h.now) {
    const n = h.now;
    const parts = [span(n.uptimeSec * 1000), n.load ? `load ${n.load[0]}` : null].filter(Boolean);
    rows.push({ key: 'now', label: 'Up for', value: parts.join(', ') + (n.stale ? ` (last reading, ${span(now - n.at)} ago)` : ''), tone: n.stale ? 'muted' : undefined });
  } else {
    rows.push({ key: 'now', label: 'Up for', tone: 'muted', value: h.daemon && !h.daemon.vitals ? 'Its session helper is older than this view (it updates on the next connect)' : h.connection.connected ? 'No reading yet' : 'Not connected' });
  }
  const week = h.history?.windows.find((w) => w.days === 7);
  if (week && week.online !== null) {
    const days = week.minutes / 1440;
    const over = days >= 6.95 ? 'the last 7 days' : `the ${recordedSpan(week.minutes)} recorded`;
    const extra = [week.downs ? `${week.downs} down` : null, week.drops ? `${week.drops} link drops` : null, (week.daemonStarts ?? 0) > 1 ? `session helper started ${week.daemonStarts} times` : null].filter(Boolean);
    rows.push({ key: 'online', label: 'Online', value: `${pct(week.online, 1)} of ${over}` + (extra.length ? `, ${extra.join(', ')}` : ''), tone: week.online >= 0.99 ? 'good' : week.online >= 0.9 ? 'warn' : 'bad' });
  } else {
    rows.push({ key: 'online', label: 'Online', tone: 'muted', value: h.history ? 'Recording started; a share shows after the first minutes' : 'No record yet' });
  }
  const c = h.connection;
  // "SSH tunnel: connected 20 min, 38 ms" (the way first, then how it is going).
  const link = [c.connected ? (c.since ? `connected ${span(now - c.since)}` : 'connected') : c.phaseLabel, c.rttMs ? `${c.rttMs} ms` : null].filter(Boolean).join(', ');
  rows.push({
    key: 'connection', label: 'Connection',
    value: (link ? `${KIND_LABEL[c.kind]}: ${link}` : KIND_LABEL[c.kind])
      + (!c.connected && c.error ? ` (${c.error})` : ''),
    tone: c.connected ? undefined : 'bad',
  });
  if (h.daemon) {
    const d = h.daemon;
    // Not starting after a reboot is a problem, said once on its row or in the problem list.
    // How it starts (crontab, a systemd user service) is the server's word: kept for the tooltip.
    const reboot = !h.local && d.startsAfterReboot ? 'starts by itself after a reboot' : null;
    const value = [d.version ? `build ${d.version.replace(/^walnut-daemon-/, '')}` : 'build not reported yet', reboot].filter(Boolean).join(', ');
    const how = !h.local && d.startsAfterReboot && d.reboot ? `\nAfter a reboot: ${d.reboot.replace(/`/g, '')}` : '';
    // "Walnut helper Version 0123456789ab" read as jargon (2026-11-05 review): what it does, then its build.
    rows.push({ key: 'daemon', label: 'Session helper', value: value.charAt(0).toUpperCase() + value.slice(1), title: `The small program Walnut runs on the host to start and keep its sessions${how}` });
  }
  return rows;
}
