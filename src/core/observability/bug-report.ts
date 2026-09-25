/**
 * Bug-report bundle — session-agnostic sibling of captureBundle() (bundle.ts).
 *
 * Where captureBundle freezes evidence for ONE session into a directory, this
 * builds a single pasteable PLAIN-TEXT diagnostic for the whole app: version,
 * system/daemon health, masked config, recent server log, warn/error lines,
 * forwarded browser-console lines, and recent incidents. It is what the
 * Settings → Bug Report button and `curl /api/bug-report` return.
 *
 * Contract: NEVER throws, never leaks secrets. Every section collector is
 * individually try/caught — a failure renders as "(unavailable: reason)".
 * The final text passes through redactSensitiveText() because config values
 * and incident summaries never went through writeLogEntry's write-time
 * redaction.
 */

import fs from 'node:fs';
import path from 'node:path';
import { CLOUD_MODE, LOG_DIR } from '../../constants.js';
import { redactSensitiveText } from '../../logging/index.js';
import { redactConfig } from '../config-redact.js';
import { getVersion } from '../version.js';
import { getBuildInfo } from '../../lib/build-info.js';
import { recentLogFiles, lineTimeMs, tailFile, grepFileLines } from './bundle.js';
import type { CollectOptions } from '../diagnostics/doctor.js';
import { maskHostIdentitiesInText, redactDiagnostics, type HostIdentity } from '../diagnostics/redact.js';

const DEFAULT_WINDOW_MINS = 30;
/** Caps per section — keep the whole artifact pasteable. */
const SERVER_LOG_MAX_LINES = 1200;
const SERVER_LOG_MAX_BYTES = 250 * 1024;
const FILTERED_MAX_LINES = 300;
const IOS_TAIL_LINES = 100;
const MAX_INCIDENTS = 10;
/** Whole-report byte budget; the largest section gets middle-truncated over this. */
const TOTAL_MAX_BYTES = 450 * 1024;

export interface BugReportOpts {
  windowMins?: number;
  /** Injected by the route (web layer owns getSystemHealth — core must not import it). */
  systemHealth?: unknown;
  /** Doctor probes the web layer owns (terminal dtach, served web assets); see routes/diagnostics.ts. */
  diagnostics?: CollectOptions;
}

/** Build the full diagnostic text. Resolves always; never rejects. */
export async function buildBugReportText(opts?: BugReportOpts): Promise<string> {
  const windowMins = clampWindow(opts?.windowMins);
  const notes: string[] = [];
  const sections: Array<{ name: string; body: string }> = [];

  const add = (name: string, fn: () => string | Promise<string>): Promise<void> =>
    Promise.resolve()
      .then(fn)
      .then(body => {
        const trimmed = body.trim();
        if (trimmed.length === 0) {
          notes.push(`${name}: empty`);
          sections.push({ name, body: '(empty)' });
        } else {
          sections.push({ name, body: trimmed });
        }
      })
      .catch(err => {
        const reason = err instanceof Error ? err.message : String(err);
        notes.push(`${name}: ${reason}`);
        sections.push({ name, body: `(unavailable: ${reason})` });
      });

  // One host table for the whole bundle, so `[host:2]` names the same host in every section.
  const hostTable = configuredHostIdentities();
  try {
    const cutoffMs = Date.now() - windowMins * 60_000;
    const recent = recentLogFiles();

    await add('meta', async () => metaSection(windowMins, opts?.diagnostics, await hostTable));
    await add('system health', () => systemHealthSection(opts?.systemHealth));
    await add('process health', () => processHealthSection());
    await add('config (secrets masked)', () => configSection());
    await add('recent server log', async () =>
      capLines(await scanDatedLogs(recent, cutoffMs, () => true), SERVER_LOG_MAX_LINES, SERVER_LOG_MAX_BYTES));
    await add('recent warnings/errors', async () =>
      capLines(
        await scanDatedLogs(recent, cutoffMs, l => l.includes('"level":"warn"') || l.includes('"level":"error"')),
        FILTERED_MAX_LINES,
      ));
    await add('browser console (forwarded)', async () =>
      capLines(await scanDatedLogs(recent, cutoffMs, l => l.includes('"subsystem":"browser"')), FILTERED_MAX_LINES));
    await add('ios client logs (tail)', () => iosLogsSection());
    await add('recent incidents', () => incidentsSection());
  } catch (err) {
    // Even orchestration failing must not throw — the caller is debugging.
    notes.push(`bundle orchestration error: ${err instanceof Error ? err.message : String(err)}`);
  }

  sections.push({ name: 'collection notes', body: notes.length > 0 ? notes.join('\n') : '(all sections collected cleanly)' });

  let text = [
    'WALNUT DIAGNOSTIC BUNDLE (server)',
    ...sections.map(s => `\n=== ${s.name} ===\n${s.body}`),
  ].join('\n');

  text = enforceTotalBudget(text);
  text = maskHostIdentitiesInText(text, await hostTable);
  return redactSensitiveText(text);
}

/**
 * Every configured remote host, in config order: the bundle masks each one's
 * REAL hostname and username across the WHOLE text with an ordinal marker
 * (`[host:1]`, `[user:1]`), because log lines mention real DNS names (ssh,
 * daemon connect lines) that the config-section masking can't reach. The
 * marker never carries the alias: an alias can itself be the FQDN or an IP (an
 * ssh-config `Host build-7.corp.example.com`), and such an alias is masked too
 * (see diagnostics/redact.ts). Best-effort: config unreadable → no hosts.
 */
async function configuredHostIdentities(): Promise<HostIdentity[]> {
  try {
    const { getConfig } = await import('../config-manager.js');
    const hosts = (await getConfig()).hosts ?? {};
    return Object.entries(hosts)
      .filter(([alias]) => alias !== '__local__')
      .map(([alias, host]) => {
        const h = host as { hostname?: string; user?: string };
        return { alias, ...(h.hostname ? { hostname: h.hostname } : {}), ...(h.user ? { user: h.user } : {}) };
      });
  } catch {
    return [];
  }
}

function clampWindow(v: number | undefined): number {
  if (v === undefined || !Number.isFinite(v)) return DEFAULT_WINDOW_MINS;
  return Math.min(1440, Math.max(5, Math.floor(v)));
}

// ── sections ──

async function metaSection(windowMins: number, diagnostics: CollectOptions | undefined, hosts: HostIdentity[]): Promise<string> {
  return [
    `version: ${getVersion()}`,
    `build: ${JSON.stringify(getBuildInfo())}`,
    `mode: ${CLOUD_MODE ? 'REPLICA (cloud)' : 'LIVE'}`,
    `generatedAt: ${new Date().toISOString()}`,
    `node: ${process.version} (${process.platform}/${process.arch})`,
    `uptimeSec: ${Math.round(process.uptime())}`,
    `logDir: ${LOG_DIR}`,
    `windowMins: ${windowMins}`,
    'diagnostics:',
    (await diagnosticsText(diagnostics, hosts)).split('\n').map(l => `  ${l}`).join('\n'),
  ].join('\n');
}

/**
 * The `open-walnut doctor` block, redacted (the same text Settings copies), so
 * a bug report answers which build, claude, node and hosts without a follow-up.
 * Its own failure stays inside this line: the rest of meta must still render.
 */
async function diagnosticsText(opts: CollectOptions | undefined, hosts: HostIdentity[]): Promise<string> {
  try {
    const { collectDiagnostics } = await import('../diagnostics/doctor.js');
    const { renderDiagnosticsText } = await import('../diagnostics/render.js');
    return renderDiagnosticsText(redactDiagnostics(await collectDiagnostics(opts), { hosts }));
  } catch (err) {
    return `(unavailable: ${err instanceof Error ? err.message : String(err)})`;
  }
}

async function systemHealthSection(injected: unknown): Promise<string> {
  const parts: string[] = [];
  if (injected !== undefined) {
    parts.push(JSON.stringify(injected, null, 2));
  }
  // Daemon pool state — lazy import so core never hard-depends on providers
  // being loadable (same pattern as captureHostConnectivity in bundle.ts).
  try {
    const { getDaemonPoolStatus, getDaemonDisconnectedSince } = await import('../../providers/daemon-connection.js');
    const pool = getDaemonPoolStatus().map(s => ({
      ...s,
      disconnectedSince: getDaemonDisconnectedSince(s.host)
        ? new Date(getDaemonDisconnectedSince(s.host)!).toISOString()
        : null,
    }));
    parts.push(`daemon pool: ${JSON.stringify(pool, null, 2)}`);
  } catch (err) {
    parts.push(`daemon pool: (unavailable: ${err instanceof Error ? err.message : String(err)})`);
  }
  return parts.join('\n');
}

async function processHealthSection(): Promise<string> {
  const { processHealthSnapshot } = await import('./process-health.js');
  return processHealthSnapshot();
}

async function configSection(): Promise<string> {
  const { getConfig } = await import('../config-manager.js');
  // Masked ALWAYS (unlike GET /api/config which only masks in cloud mode):
  // a bug report is destined for a public chat/issue, not a trusted LAN UI.
  return JSON.stringify(maskHostIdentity(redactConfig(await getConfig())), null, 2);
}

/**
 * Bug-report-only extra pass: mask remote-host `hostname`/`user` values.
 * Host ALIASES (the config keys, e.g. "clouddev") stay visible — they're what
 * log lines reference — but real DNS names / usernames are private-ish and
 * not needed to debug from a pasted report. Not part of SECRET_FIELDS because
 * the settings UI legitimately displays them on the trusted LAN.
 */
function maskHostIdentity(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskHostIdentity);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = (k === 'hostname' || k === 'user') && typeof v === 'string' && v.length > 0
        ? '[MASKED]'
        : maskHostIdentity(v);
    }
    return out;
  }
  return value;
}

function iosLogsSection(): string {
  const dir = path.join(LOG_DIR, 'ios-client');
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.log'));
  } catch {
    return '(no ios client logs)';
  }
  // Most recent 2 files by mtime.
  const picked = files
    .map(f => path.join(dir, f))
    .map(f => ({ f, mtime: safeMtime(f) }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 2)
    .map(x => x.f);
  if (picked.length === 0) return '(no ios client logs)';
  return picked
    .map(f => `### ${f} (last ${IOS_TAIL_LINES} lines)\n${tailFile(f, IOS_TAIL_LINES)}`)
    .join('\n\n');
}

async function incidentsSection(): Promise<string> {
  const { listIncidents } = await import('./incidents.js');
  const incidents = await listIncidents();
  if (incidents.length === 0) return '(none)';
  return incidents
    .slice(-MAX_INCIDENTS)
    .map(i => JSON.stringify({
      id: i.id, status: i.status, createdAt: new Date(i.createdAt).toISOString(),
      trigger: i.trigger, label: i.label, summary: i.summary,
      sessionId: i.sessionId, ...(i.bundlePath ? { bundlePath: i.bundlePath } : {}),
    }))
    .join('\n');
}

// ── log scanning (grepDatedLogs without the sessionId filter) ──

// Streamed (grepFileLines) — the dated logs run 40-60MB and a readFileSync
// here froze the event loop (and every in-flight request) for the whole read.
async function scanDatedLogs(files: string[], cutoffMs: number, keep: (line: string) => boolean): Promise<string> {
  const out: string[] = [];
  for (const file of files) {
    const hits = await grepFileLines(file, (line) => {
      if (line.length === 0 || !keep(line)) return false;
      // A line whose time we can't parse is KEPT (don't drop evidence).
      const t = lineTimeMs(line);
      return !(t !== null && t < cutoffMs);
    });
    out.push(...hits);
  }
  return out.join('\n');
}

function safeMtime(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/** Keep head+tail when over the caps — errors cluster at the end, context at the start. */
function capLines(text: string, maxLines: number, maxBytes?: number): string {
  let lines = text.split('\n');
  if (lines.length > maxLines) {
    const head = Math.floor(maxLines / 3);
    const tail = maxLines - head;
    lines = [
      ...lines.slice(0, head),
      `[... truncated ${lines.length - maxLines} lines for size ...]`,
      ...lines.slice(-tail),
    ];
  }
  let result = lines.join('\n');
  if (maxBytes !== undefined && Buffer.byteLength(result, 'utf-8') > maxBytes) {
    // Byte-level middle cut as the final guard (single huge lines).
    const half = Math.floor(maxBytes / 2);
    result = `${result.slice(0, half)}\n[... truncated for size ...]\n${result.slice(-half)}`;
  }
  return result;
}

/** If the whole report exceeds the budget, middle-truncate the largest section. */
function enforceTotalBudget(text: string): string {
  if (Buffer.byteLength(text, 'utf-8') <= TOTAL_MAX_BYTES) return text;
  const overshoot = Buffer.byteLength(text, 'utf-8') - TOTAL_MAX_BYTES;
  // Split on section headers, find the largest body, cut its middle.
  const parts = text.split(/(?=\n=== )/);
  let largest = 0;
  for (let i = 1; i < parts.length; i++) {
    if (parts[i].length > parts[largest].length) largest = i;
  }
  const p = parts[largest];
  const keep = Math.max(1024, p.length - overshoot - 64);
  const half = Math.floor(keep / 2);
  parts[largest] = `${p.slice(0, half)}\n[... truncated for total size ...]\n${p.slice(-half)}`;
  return parts.join('');
}
