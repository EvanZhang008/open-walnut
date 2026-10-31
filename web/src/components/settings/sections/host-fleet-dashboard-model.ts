/**
 * What the fleet dashboard draws (HostFleetGroup.tsx, HostFleetCard.tsx,
 * HostFleetTopology.tsx): the summary, each card's one problem line, its 12 hour
 * timeline, gauges and chips, and where each node sits in the diagram. Pure, so
 * each rule has a unit test (tests/web/host-fleet-dashboard-model.test.ts).
 * Shows a host's label only, never its alias.
 */
import type { FleetHost } from '@/api/hosts-fleet';
import { gb, pct, span } from './host-fleet-model';

export type Tone = 'good' | 'warn' | 'bad' | 'muted';

const GB = 1024 ** 3;
/** Under this much free disk a host reads red: a build or a clone may not fit. */
export const DISK_LOW_BYTES = 20 * GB;
export const TIMELINE_MS = 12 * 3_600_000;

/** A host the dashboard draws as a full card: this computer, or one Walnut is connected to now. */
export function isLive(h: FleetHost): boolean {
  return h.local || h.connection.connected;
}

export interface FleetSummary { online: number; total: number; sessions: number | null; spendUsd: number | null; problems: number }

export function fleetSummary(hosts: FleetHost[], now: number): FleetSummary {
  let sessions: number | null = null;
  let spendUsd: number | null = null;
  for (const h of hosts) {
    if (h.sessions.running !== null) sessions = (sessions ?? 0) + h.sessions.running;
    if (h.spend) spendUsd = (spendUsd ?? 0) + h.spend.last30dUsd;
  }
  return {
    online: hosts.filter(isLive).length,
    total: hosts.length,
    sessions,
    spendUsd,
    // A grey note (a laptop, no Walnut server there) is no problem to count.
    problems: hosts.filter((h) => !isLive(h) || problemsOf(h, now).some((p) => p.tone === 'warn' || p.tone === 'bad')).length,
  };
}

export interface Problem {
  key: 'server' | 'reboot' | 'disk' | 'stale' | 'uptime' | 'long-running';
  /** A few words for the card. */
  text: string;
  /** The whole sentence, for the tooltip. */
  detail: string;
  tone: Tone;
  /** What the button does, when Walnut can fix it from here. */
  action?: { kind: 'boot-start'; label: 'Set up' | 'Check again' };
}

function rebootProblem(h: FleetHost): Problem | null {
  const d = h.daemon;
  if (h.local || !d || d.startsAfterReboot) return null;
  const b = d.bootStart ?? null;
  const detail = d.reboot ?? 'Its daemon does not start by itself after a reboot';
  if (b?.setupRunning) return { key: 'reboot', text: 'Setting up start after a reboot', detail, tone: 'muted' };
  const text = 'Daemon does not come back after a reboot';
  // The host's keeper says what a press can do (BootStartNext); an older server says nothing, so no button.
  // Only an SSH host has a keeper; the cloud box runs its own service.
  const next = h.connection.kind === 'ssh-tunnel' && h.connection.connected ? b?.next ?? null : null;
  if (!next) return { key: 'reboot', text, detail, tone: 'warn' };
  return { key: 'reboot', text, detail, tone: 'warn', action: { kind: 'boot-start', label: next === 'install' ? 'Set up' : 'Check again' } };
}

/** Every problem of a live host, the one to show first. */
export function problemsOf(h: FleetHost, now: number): Problem[] {
  const out: Problem[] = [];
  const sv = h.server;
  if (sv?.enabled && sv.phase !== 'running') {
    out.push({ key: 'server', text: `Walnut server ${sv.phaseLabel}`, detail: sv.message ? `Its Walnut server is ${sv.phaseLabel}: ${sv.message}` : `Its Walnut server is ${sv.phaseLabel}`, tone: sv.phase === 'failed' ? 'bad' : 'warn' });
  }
  const reboot = rebootProblem(h);
  if (reboot) out.push(reboot);
  // The daemon's reading says 0 for a full disk; the profile's 0 only means not known.
  const disk = freeDiskBytes(h);
  const measured = !!h.now?.disk && h.now.disk.totalBytes > 0;
  if (typeof disk === 'number' && (disk > 0 || measured) && disk < DISK_LOW_BYTES) {
    out.push({ key: 'disk', text: `Disk almost full: ${size(disk)} free`, detail: `Only ${size(disk)} of disk is free; a build or a clone may not fit`, tone: 'bad' });
  }
  if (h.now?.stale) {
    out.push({ key: 'stale', text: `Last reading ${span(now - h.now.at)} ago`, detail: `The host did not answer in time; this is its reading from ${span(now - h.now.at)} ago`, tone: 'muted' });
  }
  const week = h.history?.windows.find((w) => w.days === 7);
  // A day of record at least, as the long-running verdict asks: an hour with one drop says little.
  if (week && week.online !== null && week.minutes >= 1440 && week.online < 0.95) {
    out.push({ key: 'uptime', text: `Up ${pct(week.online)} of the last 7 days`, detail: `Up ${pct(week.online, 1)} of the last 7 days, ${week.downs} times down`, tone: 'warn' });
  }
  // The long-running verdict repeats the reboot reason; it adds a line only for what it alone says.
  const fit = h.placement.longRunning;
  if (!fit.ok && !out.some((p) => p.key === 'reboot')) {
    const reasons = fit.reasons.filter((r) => !/does not start by itself after a reboot/.test(r));
    if (reasons.length) {
      out.push({ key: 'long-running', text: h.system?.kind === 'laptop' ? 'Laptop: not for jobs that must keep running' : 'Not for jobs that must keep running', detail: reasons.join(' '), tone: 'muted' });
    }
  }
  return out;
}

/** The full sentence of every problem, for the line's tooltip. */
export function problemTitle(list: Problem[]): string {
  return list.map((p) => p.detail.replace(/`/g, '')).join('\n');
}

export interface Segment { from: number; to: number; tone: 'good' | 'warn' | 'bad' | 'none'; title: string }

function clock(t: number): string {
  return new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/**
 * The last 12 hours as runs of one state: up and linked (good), up while Walnut had no link
 * (warn), down (bad), before the record began (none). `from`/`to` are shares of the width.
 * Built from the ledger's exact outages, so a 3 minute drop shows where it was.
 */
export function timeline(h: FleetHost, now: number): Segment[] {
  const hist = h.history;
  const end = h.now?.at ?? now;
  const start = end - TIMELINE_MS;
  const at = (t: number) => Math.min(1, Math.max(0, (t - start) / TIMELINE_MS));
  if (!hist || hist.coverageFrom === null || hist.coverageFrom >= end) {
    return [{ from: 0, to: 1, tone: 'none', title: 'No record for the last 12 hours yet' }];
  }
  // The daemon lists its newest 20 outages: with that many, the time before the oldest is not known here.
  const listed = hist.outages.length >= 20 ? Math.min(...hist.outages.map((o) => o.from)) : -Infinity;
  const cov = Math.max(start, hist.coverageFrom, listed);
  const marks = hist.outages
    .filter((o) => o.to > cov && o.from < end)
    .map((o) => ({ from: Math.max(o.from, cov), to: Math.min(o.to, end), kind: o.kind }))
    .sort((a, b) => a.from - b.from);
  const out: Segment[] = [];
  if (cov > start) out.push({ from: 0, to: at(cov), tone: 'none', title: cov === listed ? `Too many drops to show before ${clock(cov)}` : `No record before ${clock(cov)}` });
  let cursor = cov;
  for (const m of marks) {
    const from = Math.max(m.from, cursor);
    if (m.to <= from) continue;
    if (from > cursor) out.push({ from: at(cursor), to: at(from), tone: 'good', title: `${clock(cursor)} to ${clock(from)}: up and linked` });
    out.push({
      from: at(from), to: at(m.to), tone: m.kind === 'down' ? 'bad' : 'warn',
      title: `${clock(from)} to ${clock(m.to)}: ${m.kind === 'down' ? 'down' : 'up, but Walnut had no link'} (${span(m.to - from)})`,
    });
    cursor = m.to;
  }
  if (end > cursor) out.push({ from: at(cursor), to: 1, tone: 'good', title: `${clock(cursor)} to ${clock(end)}: up and linked` });
  return out;
}

export interface Gauge { key: 'cpu' | 'mem' | 'gpu' | 'disk'; label: string; share: number | null; tone: Tone; title: string; sub?: string; subLow?: boolean }

function load(share: number | null): Tone {
  if (share === null) return 'muted';
  return share >= 0.9 ? 'bad' : share >= 0.75 ? 'warn' : 'good';
}

/** Free disk: the daemon's own reading of HOME's disk, else the host's profile (an older daemon). */
export function freeDiskBytes(h: FleetHost): number | null {
  const d = h.now?.disk;
  if (d && d.totalBytes > 0) return d.freeBytes;
  const b = h.system?.diskFreeBytes;
  return typeof b === 'number' && b > 0 ? b : null;
}


function size(bytes: number): string {
  const tb = bytes / (1024 * GB);
  return tb >= 1 ? `${Math.round(tb * 10) / 10} TB` : gb(bytes) ?? '0 GB';
}

export function diskFree(h: FleetHost): { text: string; low: boolean } | null {
  const b = freeDiskBytes(h);
  return b === null ? null : { text: size(b), low: b < DISK_LOW_BYTES };
}

/** CPU, memory, GPU (a host that has one) and disk, each as a share in use. */
export function gauges(h: FleetHost): Gauge[] {
  const n = h.now;
  const cpu = n?.cpuUtil ?? null;
  const mem = n && n.memAvailBytes !== null && n.memTotalBytes > 0 ? 1 - n.memAvailBytes / n.memTotalBytes : null;
  const out: Gauge[] = [
    { key: 'cpu', label: 'CPU', share: cpu, tone: load(cpu), title: cpu === null ? 'No CPU reading' : `CPU ${pct(cpu)} busy${n?.load ? `, load ${n.load[0]}` : ''}${n ? ` on ${n.cpus} CPUs` : ''}` },
    { key: 'mem', label: 'Memory', share: mem, tone: load(mem), title: mem === null || !n ? 'No memory reading' : `${gb(n.memTotalBytes - (n.memAvailBytes ?? 0))} of ${gb(n.memTotalBytes)} in use` },
  ];
  if (typeof n?.gpuUtil === 'number') out.push({ key: 'gpu', label: 'GPU', share: n.gpuUtil, tone: load(n.gpuUtil), title: `GPU ${pct(n.gpuUtil)} busy` });
  const d = n?.disk && n.disk.totalBytes > 0 ? n.disk : null;
  const free = diskFree(h);
  const used = d ? 1 - d.freeBytes / d.totalBytes : null;
  out.push({
    key: 'disk', label: 'Disk', share: used,
    // Red goes by what is left, not the share: 10% of a 4 TB disk is plenty.
    tone: used === null ? 'muted' : free?.low ? 'bad' : used >= 0.9 ? 'warn' : 'good',
    title: d ? `${size(d.totalBytes - d.freeBytes)} of ${size(d.totalBytes)} in use, ${size(d.freeBytes)} free` : free ? `${free.text} free (its daemon does not report the disk size yet)` : 'No disk reading',
    ...(free ? { sub: `${free.text} free`, subLow: free.low } : {}),
  });
  return out;
}

export interface Spark { key: 'cpu' | 'mem' | 'gpu' | 'sessions'; label: string; values: Array<number | null>; max: number; value: string; title: string }

/** The small charts of the last 12 hours: CPU, memory, GPU (a host that has one), sessions open. */
export function sparks(h: FleetHost): Spark[] {
  const r = h.history?.recent;
  if (!r || !r.cpu.length) return [];
  // The rings say now; a chart's number says the most of its 12 hours, so the two never read as one value.
  const peak = (list: Array<number | null>) => list.reduce<number>((m, v) => (v !== null && v > m ? v : m), 0);
  const share = (key: Spark['key'], label: string, list: Array<number | null>): Spark => ({
    key, label, values: list, max: 1, value: list.some((v) => v !== null) ? `max ${pct(peak(list))}` : '?',
    title: `${label} over the last 12 hours, in ${r.stepMinutes} minute steps: peak ${pct(peak(list)) ?? '?'}`,
  });
  const out = [share('cpu', 'CPU', r.cpu), share('mem', 'Memory', r.mem)];
  if (r.gpu) out.push(share('gpu', 'GPU', r.gpu));
  // Sessions read null where the host was down, so the line breaks there as the others do.
  const sessions = r.sessions.map((v, i) => (r.up[i] > 0 ? v : null));
  const most = peak(sessions);
  out.push({ key: 'sessions', label: 'Sessions', values: sessions, max: Math.max(1, most), value: `max ${most}`, title: `Most sessions open at once in each ${r.stepMinutes} minutes of the last 12 hours: up to ${most}` });
  return out;
}

/**
 * An SVG path for a spark (viewBox 0 0 100 h): the line, broken where a value is missing,
 * and the area under it. A lone point between gaps is a short flat stroke, so it shows.
 */
export function sparkPaths(values: Array<number | null>, max: number, height = 20): { line: string; area: string } {
  const n = values.length;
  if (!n) return { line: '', area: '' };
  const step = 100 / n;
  const y = (v: number) => Math.round((height - 1 - (Math.min(max, Math.max(0, v)) / max) * (height - 2)) * 100) / 100;
  const x = (i: number) => Math.round((i * step + step / 2) * 100) / 100;
  const runs: Array<Array<[number, number]>> = [];
  let cur: Array<[number, number]> = [];
  values.forEach((v, i) => {
    if (v === null) { if (cur.length) runs.push(cur); cur = []; return; }
    cur.push([x(i), y(v)]);
  });
  if (cur.length) runs.push(cur);
  let line = '';
  let area = '';
  for (const run of runs) {
    const pts = run.length === 1 ? [[run[0][0] - step / 2, run[0][1]], [run[0][0] + step / 2, run[0][1]]] as Array<[number, number]> : run;
    line += `M${pts.map((p) => `${p[0]} ${p[1]}`).join(' L')} `;
    area += `M${pts[0][0]} ${height} L${pts.map((p) => `${p[0]} ${p[1]}`).join(' L')} L${pts[pts.length - 1][0]} ${height} Z `;
  }
  return { line: line.trim(), area: area.trim() };
}

/** What the host is, in one line: system, CPUs, memory. */
export function systemLine(h: FleetHost): string {
  const s = h.system;
  if (!s) return h.connection.connected ? 'Not probed yet' : 'Not probed yet (it is, once the host connects)';
  return [s.os, s.arch, s.cpus ? `${s.cpus} CPUs` : null, gb(s.memBytes)].filter(Boolean).join(' · ') || 'Probed, nothing reported';
}

export interface Chip { key: string; text: string; title?: string; tone?: 'muted' }

export function roleChips(h: FleetHost): Chip[] {
  const out: Chip[] = [];
  if (h.local) out.push({ key: 'primary', text: 'Primary', title: 'The Walnut that leads: it keeps the tasks and links every host' });
  if (h.connection.kind === 'bridge') out.push({ key: 'cloud', text: 'Cloud', title: 'The cloud companion: it connects in over a bridge' });
  if (h.capabilities?.alwaysOn) out.push({ key: 'always-on', text: 'Always on', title: 'Up all of its recorded time: fit for work that must keep running' });
  if (h.server?.enabled && h.server.program === 'replica') out.push({ key: 'replica', text: 'Replica', title: 'Runs a copy of Walnut that serves while the Mac is away' });
  return out;
}

export function capabilityChips(h: FleetHost): Chip[] {
  const c = h.capabilities;
  if (!c) return [];
  const out: Chip[] = [];
  if (c.ios) {
    out.push(c.ios.runtimes.length
      ? { key: 'ios', text: 'iOS simulator', title: `${c.ios.xcode}: ${c.ios.runtimes.join(', ')}` }
      : { key: 'ios', text: 'Xcode', title: `${c.ios.xcode}, no iOS simulator runtime`, tone: 'muted' });
  }
  const relayed = c.browsers.filter((b) => b.relay).map((b) => b.name);
  if (relayed.length) out.push({ key: 'browser', text: 'Browser', title: `Your browser through the relay: ${relayed.join(', ')}` });
  if (c.tags.includes('docker')) out.push({ key: 'docker', text: 'Docker' });
  if (c.mcp.length) out.push({ key: 'mcp', text: `MCP × ${c.mcp.length}`, title: c.mcp.map((m) => (m.plugin ? `${m.name} (${m.plugin})` : m.name)).join(', ') });
  for (const t of c.declared) if (!['cloud', 'local', 'always-on'].includes(t)) out.push({ key: `tag:${t}`, text: t, title: 'A tag set in its config' });
  for (const u of c.unknown) if (u !== 'system' && u !== 'always-on') out.push({ key: `unknown:${u}`, text: `${u === 'mcp' ? 'MCP' : u === 'ios' ? 'iOS' : u}?`, title: 'Not reported yet', tone: 'muted' });
  return out;
}

/** How Walnut reaches the host, for the line in the diagram. */
export function linkLabel(h: FleetHost): string {
  const c = h.connection;
  if (!c.connected) return c.kind === 'bridge' ? 'Not connected in' : 'Not connected';
  const kind = c.kind === 'bridge' ? 'Bridge' : 'SSH tunnel';
  return c.rttMs ? `${kind} · ${c.rttMs} ms` : kind;
}

/** Why a host is not connected, in a few words (the full error is the title). */
export function offlineLine(h: FleetHost): string {
  const c = h.connection;
  if (c.kind === 'bridge') return 'Waits for it to connect in';
  return c.phaseLabel || 'Not connected';
}

export interface TopoNode { host: string; x: number; y: number; side: 'left' | 'right' | 'centre'; live: boolean }

export const TOPO = { width: 760, nodeW: 150, nodeH: 46, rowGap: 64, pad: 16 } as const;

/** The primary in the centre; every other host on the left and right, half each, top to bottom in order. */
export function topologyLayout(hosts: FleetHost[]): { height: number; centre: TopoNode | null; nodes: TopoNode[] } {
  const primary = hosts.find((h) => h.local) ?? null;
  const others = hosts.filter((h) => h !== primary);
  const left = others.filter((_, i) => i % 2 === 0);
  const right = others.filter((_, i) => i % 2 === 1);
  const rows = Math.max(1, left.length, right.length);
  const height = Math.max(150, TOPO.pad * 2 + (rows - 1) * TOPO.rowGap + TOPO.nodeH);
  const column = (list: FleetHost[], side: 'left' | 'right') => {
    const span = (list.length - 1) * TOPO.rowGap;
    const top = height / 2 - span / 2;
    const x = side === 'left' ? TOPO.pad + TOPO.nodeW / 2 : TOPO.width - TOPO.pad - TOPO.nodeW / 2;
    return list.map((h, i) => ({ host: h.host, x, y: top + i * TOPO.rowGap, side, live: isLive(h) }));
  };
  return {
    height,
    centre: primary ? { host: primary.host, x: TOPO.width / 2, y: height / 2, side: 'centre', live: true } : null,
    nodes: [...column(left, 'left'), ...column(right, 'right')],
  };
}

/** A label that fits a diagram node. */
export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}
