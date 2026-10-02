/**
 * Words for what a session costs its machine (the heavy pill, the kebab rows,
 * the Machine readout). Pure; unit tested in tests/web/resource-format.test.ts.
 */

/** `1.8 GB`, `640 MB`, `12 MB`: whole MB under a GB, one decimal above. */
export function formatMemory(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb >= 10 ? gb.toFixed(0) : gb.toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

/** `85%`, `120%` (more than one core), `—` before the second sample. */
export function formatCpu(pct: number | null | undefined): string {
  if (pct == null || !Number.isFinite(pct)) return '—';
  return `${Math.round(pct)}%`;
}

/** The pill text: memory, plus CPU when it is the reason. */
export function heavyPillText(row: { rssBytes: number; cpuPct: number | null }, heavyCpuPct = 100): string {
  const mem = formatMemory(row.rssBytes);
  if (row.cpuPct != null && row.cpuPct >= heavyCpuPct) return `${mem} · ${formatCpu(row.cpuPct)} CPU`;
  return mem;
}

/** `3 processes`, `1 process`. */
export function formatProcCount(n: number): string {
  return `${n} ${n === 1 ? 'process' : 'processes'}`;
}

/** The host row's sentence: `9 sessions · 6.2 GB · 140% CPU`. */
export function hostTotalsText(t: { sessions: number; rssBytes: number; cpuPct: number | null }): string {
  if (t.sessions === 0) return 'No sessions running';
  const parts = [`${t.sessions} ${t.sessions === 1 ? 'session' : 'sessions'}`, formatMemory(t.rssBytes)];
  if (t.cpuPct != null) parts.push(`${formatCpu(t.cpuPct)} CPU`);
  return parts.join(' · ');
}

/** Why a host has no reading, in the words the row shows. */
export function hostReasonText(reason: 'not_connected' | 'daemon_needs_upgrade' | 'error' | 'sampling' | undefined, error?: string): string {
  switch (reason) {
    case 'not_connected': return 'Not connected';
    case 'daemon_needs_upgrade': return 'Reconnect this host to update its daemon';
    case 'error': return error ? `No reading: ${error}` : 'No reading';
    case 'sampling': return 'Reading…';
    default: return '';
  }
}

/** The note beside a host whose newest sample failed but whose last good rows still show. */
export function staleReadingText(error?: string): string {
  return error ? `Last reading shown, the newest failed: ${error}` : 'Last reading shown, the newest failed';
}
