/**
 * The file opener for agent text whose source is known (utils/agent-text-source.ts),
 * handed to useEntityClickHandler as its `onFileOpen`. No source: undefined, so the
 * handler keeps its own default. The session record is read on the click, never on
 * mount. A lookup still in flight opens nothing once a newer click came, the surface
 * unmounted, or its source changed: a late answer must not pop a viewer elsewhere.
 */
import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import { fetchSession, peekSessionRecord } from '@/api/sessions';
import { log } from '@/utils/log';
import { openFileAnywhere } from '@/utils/open-anywhere';
import { anywhereRequest, openFromSource, renderContextOf, sessionTextSource, sourceHostOf, sourceSessionId, type AgentTextSource, type RenderContext } from '@/utils/agent-text-source';

export interface AgentFileOpener {
  onFileOpen?: (path: string, line?: number, term?: undefined, endLine?: number) => void;
  /** Known remote host, for relative paths (they render only when the host is known). */
  fileHost?: string;
  fileSessionId?: string;
  /** What the renderer may use now (no request): cwd, image host, whether pictures load. */
  render: RenderContext;
  /** The writer is unknown: every path, a relative one included, goes to onFileOpen (every machine is asked). */
  refusesAll?: true;
}

const NO_SOURCE: AgentFileOpener = { render: { images: true } };

export function useAgentFileOpener(src: AgentTextSource | undefined): AgentFileOpener {
  const s = sourceHostOf(src);
  const kind = s.kind;
  const host = s.kind === 'host' ? s.host : undefined;
  const sid = s.kind === 'session' ? s.sessionId : undefined;
  const fileSessionId = sourceSessionId(src);
  // A Map read of the record this page already holds; never a request.
  const { cwd: renderCwd, host: renderHost, images } = renderContextOf(src, peekSessionRecord);
  // The hint task of an unknown writer is part of its identity: a click must not act on a source
  // object from an earlier render.
  const hintTask = kind === 'unknown' ? (src?.taskId || src?.task?.id || '') : '';
  const taskId = src?.task?.id;
  const seq = useRef(0);
  const sourceKey = `${kind}|${host ?? ''}|${sid ?? ''}|${hintTask}|${taskId ?? ''}`;
  // The source the surface shows now, set at commit: a passive effect ran too late, so an answer
  // landing between the new source's commit and its cleanup still opened the old source's file.
  const shown = useRef(sourceKey);
  // Unmount or a new source: whatever lookup is in flight is no longer this surface's.
  useLayoutEffect(() => {
    shown.current = sourceKey;
    return () => { seq.current++; };
  }, [sourceKey]);
  const onFileOpen = useCallback((path: string, line?: number, _term?: undefined, endLine?: number) => {
    const mine = ++seq.current;
    const live = () => mine === seq.current && shown.current === sourceKey;
    const req = { path, ...(line ? { line } : {}), ...(endLine ? { endLine } : {}) };
    // An unknown writer: every machine is asked, its task's first; never a question to the person.
    if (kind === 'unknown') {
      log.info('file-open', 'path of an unrecorded writer: looking on every machine', { path, taskId: hintTask });
      openFileAnywhere(anywhereRequest({ unknownSource: true, ...(hintTask ? { taskId: hintTask } : {}) }, req));
      return;
    }
    const source = kind === 'host' ? { host: host ?? '' } : sid ? { sessionId: sid } : undefined;
    void openFromSource(source, req, {
      lookup: { peek: peekSessionRecord, fetch: fetchSession },
      open: (r) => {
        if (r.anywhere) log.info('file-open', 'path of a session Walnut cannot read now: looking on every machine', { sessionId: sid ?? '', path });
        if (live()) openFileAnywhere(r.anywhere && taskId && !r.taskId ? { ...r, taskId } : r);
      },
    });
  }, [kind, host, sid, hintTask, taskId, sourceKey]);
  return useMemo(() => kind === 'none' ? NO_SOURCE : {
    onFileOpen,
    ...(host ? { fileHost: host } : {}),
    ...(fileSessionId ? { fileSessionId } : {}),
    render: { ...(renderCwd ? { cwd: renderCwd } : {}), ...(renderHost ? { host: renderHost } : {}), images },
    ...(kind === 'unknown' ? { refusesAll: true as const } : {}),
  }, [kind, onFileOpen, host, fileSessionId, renderCwd, renderHost, images]);
}

/** A session timeline's render context from its own host; render only, clicks keep the panel's onFileOpen. */
export function useSessionTextRender(p: { sessionId?: string; sessionHost?: string; sessionCwd?: string }): RenderContext {
  return useAgentFileOpener(sessionTextSource(p, peekSessionRecord)).render;
}
