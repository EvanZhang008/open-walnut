/**
 * The Brief's file opener: the path's writers from the shaped text and its spans (never the link's
 * own attributes beyond its path), their machine read on the click only. One writer opens from its
 * machine first; a writer Walnut did not record, or writers on several machines, look the path up
 * on every machine (the writing task's, else the Brief owner's, first) and open it from the one
 * that has it: never a question to the person (2026-11-23, Evan: "Why walnut not auto pic the host
 * it need me to pick"). A newer click, a new letter or its sources, or unmount outdates a lookup
 * still in flight. It reads the letter as last committed.
 */
import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import { renderMarkdownWithRefs } from '@/utils/markdown';
import { useCommittedRef } from '@/hooks/useCommittedRef';
import { fetchSession, peekSessionRecord } from '@/api/sessions';
import { openFileAnywhere, type OpenFileRequest } from '@/utils/open-anywhere';
import { anywhereRequest, openFromSource } from '@/utils/agent-text-source';
import { log } from '@/utils/log';
import { briefPathBlocks, briefPathWritersOf, writerTextSource } from './org-brief-sources';

/** No picture loads from a path whose machine is not known until the click reads its writer. */
export const BRIEF_RENDER = { inlineImages: false } as const;
const renderBlock = (raw: string) => renderMarkdownWithRefs(raw, undefined, undefined, BRIEF_RENDER);

export function useBriefFileOpener(ownerId: string | undefined, text: string, sources: unknown) {
  const sourceKey = useMemo(() => JSON.stringify([ownerId, text, sources]), [ownerId, text, sources]);
  const shown = useMemo(() => ({ ownerId, text, sources, sourceKey }), [ownerId, text, sources, sourceKey]);
  const latest = useCommittedRef(shown);
  const seq = useRef(0);
  // Before paint: a click after a new letter or its sources never finishes an older lookup.
  useLayoutEffect(() => () => { seq.current++; }, [sourceKey]);

  const open = useCallback((path: string, line?: number, _term?: undefined, endLine?: number) => {
    const mine = ++seq.current;
    const { ownerId: taskId, text: shapedText, sources: spans, sourceKey: key } = latest.current;
    // Its letter and sources must still be the ones shown, not only its click the newest.
    const current = () => mine === seq.current && latest.current.sourceKey === key;
    const req: OpenFileRequest = { path, ...(line ? { line } : {}), ...(endLine ? { endLine } : {}) };
    const writers = briefPathWritersOf(shapedText, spans, briefPathBlocks(shapedText, renderBlock), path) ?? [];
    const bySource = new Map(writers.map((w) => [JSON.stringify(writerTextSource(w)), w] as const));
    const only = bySource.size === 1 ? writers[0]! : undefined;
    if (only && !writerTextSource(only).unknownSource) {
      void openFromSource(writerTextSource(only), req, {
        lookup: { peek: peekSessionRecord, fetch: fetchSession },
        open: (r) => { if (current()) openFileAnywhere(r.anywhere && taskId && !r.taskId ? { ...r, taskId } : r); },
      });
      return;
    }
    // No recorded writer, or several: every machine is asked, a writing task's first.
    const writerTask = writers.map((w) => (w.by.startsWith('task:') ? w.by.slice(5) : '')).find(Boolean);
    log.info('org-brief', 'brief path with no single writer: looking on every machine', { taskId, path, writers: bySource.size });
    // Each recorded writer's session (the person's words: the primary) is asked first of all.
    const hints = writers.map((w) => (w.by === 'human' ? '__local__' : w.sessionId ?? '')).filter(Boolean);
    openFileAnywhere(anywhereRequest({ unknownSource: true, ...((writerTask || taskId) ? { taskId: writerTask || taskId } : {}) }, req, hints));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return { open };
}
