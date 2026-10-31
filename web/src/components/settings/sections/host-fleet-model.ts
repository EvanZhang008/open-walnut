/**
 * The words on a fleet card (HostFleetGroup.tsx): pure, so each rule has a
 * unit test (web/src/__tests__/host-fleet-model.test.ts). Every reading may be
 * missing; a missing one says why in plain words instead of a dash.
 */
import type { FleetBucket, FleetHost } from '@/api/hosts-fleet';

export interface FleetRow { key: string; label: string; value: string; tone?: 'good' | 'warn' | 'bad' | 'muted' }

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

export function usd(v: number): string {
  return `$${Math.round(v).toLocaleString('en-US')}`;
}

const KIND_LABEL: Record<FleetHost['connection']['kind'], string> = { local: 'This computer', 'ssh-tunnel': 'SSH tunnel', bridge: 'Bridge (it connects in)' };

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

export function statusKind(h: FleetHost): 'connected' | 'failed' | 'off' | 'warn' {
  if (h.connection.connected) return h.now?.stale ? 'warn' : 'connected';
  return h.connection.phase === 'failed' ? 'failed' : 'off';
}

export function fleetRows(h: FleetHost, now: number): FleetRow[] {
  const rows: FleetRow[] = [];
  const s = h.system;
  rows.push({
    key: 'system', label: 'System',
    value: s ? [s.os, s.arch, s.cpus ? `${s.cpus} CPUs` : null, gb(s.memBytes), gb(s.diskFreeBytes) ? `${gb(s.diskFreeBytes)} disk free` : null].filter(Boolean).join(' · ') || 'Probed, nothing reported'
      : 'Not probed yet (it is, once the host connects)',
    tone: s ? undefined : 'muted',
  });
  if (h.now) {
    const n = h.now;
    const parts = [
      n.cpuUtil === null ? null : `CPU ${pct(n.cpuUtil)}`,
      n.load ? `load ${n.load[0]}` : null,
      n.memAvailBytes === null ? null : `${gb(n.memAvailBytes)} of ${gb(n.memTotalBytes)} memory free`,
      `up ${span(n.uptimeSec * 1000)}`,
    ].filter(Boolean);
    rows.push({ key: 'now', label: 'Now', value: parts.join(' · ') + (n.stale ? ` (last reading, ${span(now - n.at)} ago)` : ''), tone: n.stale ? 'muted' : undefined });
  } else {
    rows.push({ key: 'now', label: 'Now', tone: 'muted', value: h.daemon && !h.daemon.vitals ? 'Its daemon is older than this view (it upgrades on the next connect)' : h.connection.connected ? 'No reading yet' : 'Not connected' });
  }
  const week = h.history?.windows.find((w) => w.days === 7);
  if (week && week.online !== null) {
    const days = week.minutes / 1440;
    const over = days >= 6.95 ? 'the last 7 days' : `the ${days >= 1 ? `${Math.round(days * 10) / 10} days` : `${Math.round(week.minutes / 60)} hours`} recorded`;
    const extra = [week.downs ? `${week.downs} down` : null, week.drops ? `${week.drops} link drops` : null, (week.daemonStarts ?? 0) > 1 ? `daemon started ${week.daemonStarts} times` : null].filter(Boolean);
    rows.push({ key: 'online', label: 'Online', value: `${pct(week.online, 1)} of ${over}` + (extra.length ? ` · ${extra.join(' · ')}` : ''), tone: week.online >= 0.99 ? 'good' : week.online >= 0.9 ? 'warn' : 'bad' });
  } else {
    rows.push({ key: 'online', label: 'Online', tone: 'muted', value: h.history ? 'Recording started; a share shows after the first minutes' : 'No record yet' });
  }
  rows.push({ key: 'sessions', label: 'Sessions', value: h.sessions.running === null ? 'Not known now' : `${h.sessions.running} open`, tone: h.sessions.running === null ? 'muted' : undefined });
  rows.push({ key: 'spend', label: 'Spend, 30 days', value: h.spend ? `${usd(h.spend.last30dUsd)} at list price (not a bill)` : 'Not counted yet', tone: h.spend ? undefined : 'muted' });
  const c = h.connection;
  rows.push({
    key: 'connection', label: 'Connection',
    value: [KIND_LABEL[c.kind], c.connected ? (c.since ? `connected ${span(now - c.since)}` : 'connected') : c.phaseLabel, c.rttMs ? `${c.rttMs} ms` : null].filter(Boolean).join(' · ')
      + (!c.connected && c.error ? ` (${c.error})` : ''),
    tone: c.connected ? undefined : 'bad',
  });
  if (h.server) {
    const sv = h.server;
    rows.push({
      key: 'server', label: 'Walnut server',
      value: sv.enabled ? [sv.program === 'replica' ? 'Replica' : sv.program === 'fallback' ? 'Plain host server (fallback)' : sv.program ? 'Plain host server' : null, sv.phase, sv.build, sv.phone ? `phone tunnel ${sv.phone}` : null].filter(Boolean).join(' · ') : 'Off',
      tone: !sv.enabled ? 'muted' : sv.phase === 'running' ? undefined : 'warn',
    });
  }
  if (h.daemon) {
    const d = h.daemon;
    const reboot = h.local ? null : d.startup === 'service' ? 'starts after a reboot' : 'does not start by itself after a reboot';
    rows.push({ key: 'daemon', label: 'Daemon', value: [d.version ? `build ${d.version.replace(/^walnut-daemon-/, '')}` : null, d.runtime, reboot].filter(Boolean).join(' · '), tone: reboot && d.startup !== 'service' ? 'warn' : undefined });
  }
  return rows;
}
