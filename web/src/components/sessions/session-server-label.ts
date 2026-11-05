/** How a listed server is named and aged in the session's Web view (SessionServerList.tsx). */
import type { SessionServer } from '@/api/session-servers';

/** When a listed server's process started on this tab's clock, if known. */
export function serverStartedAt(s: { startedAtMs?: number | null; ageSec: number | null }, now = Date.now()): number | null {
  if (typeof s.startedAtMs === 'number') return s.startedAtMs;
  return typeof s.ageSec === 'number' && Number.isFinite(s.ageSec) ? now - s.ageSec * 1000 : null;
}

/** How long a listed server has run, from its start (so it is right however old the list is). */
export function serverAge(s: { startedAtMs?: number | null; ageSec: number | null }, now = Date.now()): number | null {
  const at = serverStartedAt(s, now);
  return at === null ? null : Math.max(0, Math.floor((now - at) / 1000));
}

export function formatAge(sec: number | null): string {
  if (sec === null || sec < 0) return '';
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86_400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86_400)}d`;
}

/** The short name a chip shows: the script a runtime runs (`vite`, `http.server`), else the process name. */
export function serverLabel(s: Pick<SessionServer, 'name' | 'command'>): string {
  const argv = s.command.split(/\s+/).filter(Boolean);
  const runtime = /^(node|bun|deno|python[\d.]*|ruby|php|java|npx|npm|pnpm|yarn|uv|uvx)$/;
  const bin = (argv[0] ?? '').split('/').pop() ?? '';
  if (argv.length > 1 && runtime.test(bin)) {
    const m = argv.indexOf('-m');
    if (m > 0 && argv[m + 1]) return argv[m + 1]!;
    // Inline code (`python3 -c ...`, `node -e ...`) has no script name: the runtime is the name.
    const inline = argv.findIndex((a) => a === '-c' || a === '-e' || a === '--eval' || a === '-p' || a === '--print');
    const first = argv.findIndex((a, i) => i > 0 && !a.startsWith('-'));
    if (inline > 0 && (first < 0 || inline < first)) return s.name || bin;
    const script = first > 0 ? argv[first] : undefined;
    if (script) {
      const parts = script.split('/').filter(Boolean);
      const base = parts.pop() ?? script;
      // node_modules/.bin/vite, node_modules/vite/bin/vite.js: the package is the name.
      const pkg = parts.lastIndexOf('node_modules');
      if (pkg >= 0 && parts[pkg + 1] && parts[pkg + 1] !== '.bin') return parts[pkg + 1]!;
      return base.replace(/\.(m?js|cjs|ts|py)$/, '');
    }
  }
  return s.name || (argv[0] ?? '').split('/').pop() || 'server';
}

/**
 * The command line a row shows: long absolute paths cut to their meaningful tail
 * (`…/vite/bin/vite.js` from inside node_modules, else the last two segments), so
 * the arguments that tell servers apart stay in view. The full line is the title.
 */
/** Inline code past this reads as its start; the row then cuts it to its width. */
const INLINE_CODE_MAX = 72;

export function shortCommand(command: string): string {
  // Inline code (`python3 -c ...`, `node -e ...`) reads as its first words: the whole of it
  // is the row's title and its Copy button.
  const inline = /^(\S+ (?:-c|-e|--eval)) ([\s\S]+)$/.exec(command);
  if (inline) {
    // The host quotes it as a shell would ('...'); a line break shows as a return mark.
    const code = inline[2]!.replace(/^'([\s\S]*)'$/, '$1').trim().replace(/\s*\n\s*/g, ' \u23CE ').replace(/\s+/g, ' ');
    return `${shortCommand(inline[1]!)} "${code.length > INLINE_CODE_MAX ? `${code.slice(0, INLINE_CODE_MAX).trimEnd()}…` : code}"`;
  }
  return command.replace(/\s+/g, ' ').split(' ').map((arg) => {
    if (!arg.startsWith('/')) return arg;
    const parts = arg.split('/').filter(Boolean);
    const pkg = parts.lastIndexOf('node_modules');
    const tail = pkg >= 0 && pkg < parts.length - 1 ? parts.slice(pkg + 1) : parts.slice(-2);
    return tail.length < parts.length ? `…/${tail.join('/')}` : arg;
  }).join(' ');
}

/** It answers as a web page (or has not answered yet), so the Web view can show it. */
export const openable = (s: { kind: string }): boolean => s.kind !== 'other';

/** The one way the menu, its Open group and the phone rows count a session's servers:
 *  "3 web servers" (what Web preview opens), else "1 other server", else null (none). */
export function serversSummary(servers: readonly { kind: string }[]): string | null {
  const web = servers.filter(openable).length;
  const other = servers.length - web;
  if (web > 0) return `${web} web server${web === 1 ? '' : 's'}`;
  if (other > 0) return `${other} other server${other === 1 ? '' : 's'}`;
  return null;
}
