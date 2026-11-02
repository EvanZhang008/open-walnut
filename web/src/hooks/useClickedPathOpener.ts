/**
 * The one way a clicked path is opened: look it up first (session's host, then
 * the user's other hosts), then hand the viewer WHERE it is.
 *
 * A session on one host often names a file on another (a Mac handoff, a video
 * recorded on the Mac). Opening every path on the session's host sent those
 * clicks to a folder that does not exist there, and the Files panel healed it to
 * `/` (2026-11-01). Every surface that opens a clicked path in a viewer goes
 * through this hook; `tests/web/clicked-path-sinks.test.ts` fails on one that
 * does not.
 */
import { useCallback, useRef } from 'react';
import { locatePath } from '@/api/files';
import { log } from '@/utils/log';

export interface ClickedPathTarget {
  path: string;
  /** Host to open it on (absent = this machine). */
  host?: string;
  /** It lives on a host other than the one the click came from. */
  elsewhere: boolean;
  /** No host has it: the hosts asked, for a plain "couldn't find" line. */
  missing?: { checked: string[] };
  line?: number;
  endLine?: number;
  term?: string;
}

export interface ClickedPathContext {
  /** The host the clicked text came from (a session's host). */
  host?: string;
  cwd?: string;
  sessionId?: string;
}

/** The sentence a viewer shows for a path no host has. */
export function missingPathLine(path: string, checked: readonly string[]): string {
  const where = checked.length <= 1
    ? (checked[0] ?? 'this machine')
    : `${checked.slice(0, -1).join(', ')} or ${checked[checked.length - 1]}`;
  return `Couldn't find ${path} on ${where}.`;
}

/** Locate `path` and build the target a viewer opens. */
export async function locateClickedPath(
  path: string,
  ctx: ClickedPathContext,
  pos: { line?: number; endLine?: number; term?: string } = {},
): Promise<ClickedPathTarget> {
  const fromHost = ctx.host && ctx.host !== '__local__' ? ctx.host : undefined;
  const r = await locatePath(path, { host: fromHost, cwd: ctx.cwd, sessionId: ctx.sessionId });
  const host = r.host && r.host !== '__local__' ? r.host : undefined;
  if (r.elsewhere) log.info('file-open', 'clicked path found on another host', { path: r.path, fromHost: fromHost ?? 'local', host: host ?? 'local' });
  // The click's own position wins; else whatever the reference carried.
  const line = pos.line ?? r.line;
  const endLine = pos.line !== undefined ? pos.endLine : r.endLine;
  return {
    path: r.path,
    ...(host ? { host } : {}),
    elsewhere: host !== fromHost,
    ...(r.missing ? { missing: { checked: r.checked ?? [] } } : {}),
    ...(line !== undefined ? { line } : {}),
    ...(endLine !== undefined ? { endLine } : {}),
    ...(pos.term ? { term: pos.term } : {}),
  };
}

/**
 * `(path, line?, term?, endLine?) => void` for a click; `open` gets the located
 * target. A newer click wins over a lookup still in flight.
 */
export function useClickedPathOpener(
  open: (target: ClickedPathTarget) => void,
  ctx: ClickedPathContext,
): (path: string, line?: number, term?: string, endLine?: number) => void {
  const seq = useRef(0);
  const openRef = useRef(open);
  openRef.current = open;
  const { host, cwd, sessionId } = ctx;
  return useCallback((path: string, line?: number, term?: string, endLine?: number) => {
    const mine = ++seq.current;
    void locateClickedPath(path, { host, cwd, sessionId }, { line, endLine, term }).then((target) => {
      if (mine === seq.current) openRef.current(target);
    });
  }, [host, cwd, sessionId]);
}
