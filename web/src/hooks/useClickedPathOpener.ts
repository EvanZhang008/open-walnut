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
import { useCallback, useLayoutEffect, useRef } from 'react';
import { locatePath } from '@/api/files';
import { log } from '@/utils/log';

export interface ClickedPathTarget {
  path: string;
  /** Host to open it on (absent = this machine). */
  host?: string;
  /** It lives on a host other than the one the click came from. */
  elsewhere: boolean;
  /** No host has it: the hosts asked, for a plain "couldn't find" line, and those that did not answer. */
  missing?: { checked: string[]; unreachable?: string[] };
  line?: number;
  endLine?: number;
  term?: string;
  /** performance.now() of the click that asked for it: the open is timed from there (file-open). */
  clickedAt?: number;
}

export interface ClickedPathContext {
  /** The host the clicked text came from (a session's host). */
  host?: string;
  cwd?: string;
  sessionId?: string;
  sourceOnly?: boolean;
  /** The writer's machine is unknown: every machine is asked (files-locate.ts `anywhere`). */
  anywhere?: boolean;
  /** With `anywhere`: the task the words belong to, whose machines are asked first. */
  taskId?: string;
  /** With `anywhere`: the sessions that wrote the words ('__local__' the person), asked first of all. */
  hintSessions?: readonly string[];
}

/** The sentence a viewer shows for a path no host has. */
export function missingPathLine(path: string, checked: readonly string[], anywhere = false, unreachable: readonly string[] = []): string {
  // A relative path whose writer is unknown has no folder to be read against: no machine was asked.
  if (anywhere && !/^(\/|~(\/|$))/.test(path)) return `Couldn't open ${path}: it is a relative path, and Walnut does not know which session's folder it is in.`;
  if (anywhere) {
    const list = (names: readonly string[]) => names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
    const silent = unreachable.length ? `${list(unreachable)} did not answer, so the file may be there.` : '';
    if (!checked.length) return silent ? `Couldn't look for ${path}: ${silent}` : `Couldn't look for ${path}: no machine could be asked.`;
    return `Couldn't find ${path} on ${list(checked)}.${silent ? ` ${silent}` : ''}`;
  }
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
  const fromHost = ctx.host && !['__local__', 'local'].includes(ctx.host) ? ctx.host : undefined;
  const r = await locatePath(path, {
    host: fromHost, cwd: ctx.cwd, sessionId: ctx.sessionId, sourceOnly: ctx.sourceOnly,
    ...(ctx.anywhere ? { anywhere: true, ...(ctx.taskId ? { taskId: ctx.taskId } : {}), ...(ctx.hintSessions?.length ? { hintSessions: ctx.hintSessions } : {}) } : {}),
  });
  const host = r.host && r.host !== '__local__' ? r.host : undefined;
  if (r.elsewhere) log.info('file-open', 'clicked path found on another host', { path: r.path, fromHost: fromHost ?? 'local', host: host ?? 'local' });
  // The click's own position wins; else whatever the reference carried.
  const line = pos.line ?? r.line;
  const endLine = pos.line !== undefined ? pos.endLine : r.endLine;
  return {
    path: r.path,
    ...(host ? { host } : {}),
    elsewhere: host !== fromHost,
    ...(r.missing ? { missing: { checked: r.checked ?? [], ...(r.unreachable?.length ? { unreachable: r.unreachable } : {}) } } : {}),
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
  const { host, cwd, sessionId, sourceOnly } = ctx;
  useLayoutEffect(() => () => { seq.current++; }, [host, cwd, sessionId, sourceOnly]);
  return useCallback((path: string, line?: number, term?: string, endLine?: number) => {
    const mine = ++seq.current;
    const clickedAt = performance.now();
    void locateClickedPath(path, { host, cwd, sessionId, sourceOnly }, { line, endLine, term }).then((target) => {
      if (mine === seq.current) openRef.current({ ...target, clickedAt });
    });
  }, [host, cwd, sessionId, sourceOnly]);
}
