/**
 * Crash report builder — 100% client-side, synchronous, zero network.
 *
 * Built ON the crash screen, so every section is individually try/caught and
 * nothing here may import anything that can fail loudly. The report is meant
 * to be pasted into a chat/issue by a user who cannot open DevTools — it must
 * carry enough to diagnose without any server-side access.
 */

// Relative imports (not `@/` alias) so the node-env vitest config can resolve
// this module — same convention as browser-logger.ts.
import { wsClient } from '../api/ws';
import { getRecentEntries } from './browser-logger';
import { getAppInfo } from './app-info';
import { redactText } from './redact';

const MAX_STACK_CHARS = 4000;
const MAX_REPORT_BYTES = 100 * 1024;

export interface CrashReportInput {
  error: unknown;
  componentStack?: string | null;
}

/** Build the pasteable crash report text. Never throws. */
export function buildCrashReport(input: CrashReportInput): string {
  const sections: string[] = ['WALNUT CRASH REPORT'];

  const add = (name: string, fn: () => string) => {
    let body: string;
    try {
      body = fn().trim() || '(empty)';
    } catch (err) {
      body = `(unavailable: ${err instanceof Error ? err.message : String(err)})`;
    }
    sections.push(`\n=== ${name} ===\n${body}`);
  };

  add('crash', () => {
    const err = input.error;
    const stack = err instanceof Error ? (err.stack ?? `${err.name}: ${err.message}`) : String(err);
    return [
      `time: ${new Date().toISOString()}`,
      `error: ${stack.slice(0, MAX_STACK_CHARS)}`,
      input.componentStack ? `componentStack:${input.componentStack.slice(0, MAX_STACK_CHARS)}` : 'componentStack: (not captured)',
    ].join('\n');
  });

  add('environment', () => {
    const info = getAppInfo();
    return [
      `url: ${window.location.href}`,
      `userAgent: ${navigator.userAgent}`,
      `viewport: ${window.innerWidth}x${window.innerHeight} @${window.devicePixelRatio}x`,
      `language: ${navigator.language}`,
      `secureContext: ${window.isSecureContext}`,
      `online: ${navigator.onLine}`,
      info
        ? `server: v${info.version ?? '?'} ${info.mode ?? '?'} (cached${info.serverTime ? `, serverTime ${info.serverTime}` : ''})`
        : 'server: (unknown — status never fetched)',
    ].join('\n');
  });

  add('connection', () => {
    const lc = wsClient.lastClose;
    return [
      `ws: ${wsClient.state}`,
      lc ? `lastClose: code=${lc.code} (${lc.codeDesc}) reason=${lc.reason} at=${lc.at}` : 'lastClose: (none this page load)',
      // Presence boolean ONLY — never the value. Worded to dodge the redaction
      // regex ("token:" followed by a value would itself get [REDACTED]).
      `has deviceToken stored = ${localStorage.getItem('walnut.deviceToken') ? 'yes' : 'no'}`,
    ].join('\n');
  });

  add('crash history', () => {
    const raw = sessionStorage.getItem('open-walnut-crash-log');
    if (!raw) return '(no prior crashes this tab)';
    const times = JSON.parse(raw);
    if (!Array.isArray(times)) return '(unreadable)';
    return times.map((t: number) => new Date(t).toISOString()).join('\n');
  });

  // Key names + value byte-lengths ONLY. A 0-length or oddly-truncated value
  // is exactly the "JSON.parse: unexpected end of data" smoking gun, and key
  // names can't leak secrets (values never included).
  add('storage snapshot (walnut keys: name=bytes)', () => {
    const lines: string[] = [];
    const scan = (store: Storage, label: string) => {
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        if (!k || !(k.startsWith('open-walnut-') || k.startsWith('walnut'))) continue;
        const v = store.getItem(k);
        lines.push(`${label} ${k}=${v === null ? 'null' : v.length}`);
      }
    };
    scan(localStorage, 'local');
    scan(sessionStorage, 'session');
    return lines.length > 0 ? lines.sort().join('\n') : '(no walnut keys)';
  });

  add('recent console (oldest first)', () => {
    const entries = getRecentEntries();
    if (entries.length === 0) return '(no entries)';
    return entries
      .map((e) => {
        const t = e.time.slice(11, 19); // HH:MM:SS from ISO
        const dup = e.count && e.count > 1 ? ` (x${e.count})` : '';
        const args = e.args ? ` | ${e.args}` : '';
        return `[${t} ${e.level}] ${e.message}${args}${dup}`;
      })
      .join('\n');
  });

  let text = sections.join('\n');
  if (text.length > MAX_REPORT_BYTES) {
    text = `${text.slice(0, MAX_REPORT_BYTES)}\n[... truncated for size ...]`;
  }
  try {
    return redactText(text);
  } catch {
    return text; // redaction failing must not lose the report
  }
}

/**
 * Opportunistic server probe to append to a crash report. Resolves ALWAYS
 * (never rejects) — with a live-status section or an unreachable note.
 */
export async function fetchServerEnrichment(): Promise<string> {
  const header = '\n=== server (live probe) ===\n';
  try {
    const res = await fetch('/api/v1/status', { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return `${header}(HTTP ${res.status})`;
    const data = await res.json();
    return `${header}${JSON.stringify(data)}`;
  } catch (err) {
    return `${header}(unreachable: ${err instanceof Error ? err.message : String(err)})`;
  }
}
