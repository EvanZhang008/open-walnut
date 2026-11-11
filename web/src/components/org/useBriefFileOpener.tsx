/**
 * The Brief's file opener: the path's writers from the shaped text and its spans (never the link's
 * own attributes beyond its path), their machines read on the click only. A newer click, a new
 * letter or its sources, or unmount outdates a lookup still in flight. It reads the letter as last
 * committed, so a task list still in a transition never names a writer or a label.
 */
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Task } from '@open-walnut/core';
import { renderMarkdownWithRefs } from '@/utils/markdown';
import { useCommittedRef } from '@/hooks/useCommittedRef';
import { fetchSession, peekSessionRecord } from '@/api/sessions';
import { PathSourceChooser, type PathSourcePick } from '@/components/common/PathSourceChooser';
import { openFileAnywhere, type OpenFileRequest } from '@/utils/open-anywhere';
import { openFromSource, sourceFailureText, type AgentTextSource, type SourceFailReason } from '@/utils/agent-text-source';
import { log } from '@/utils/log';
import { boardHostChoices, type BoardResolvedSource } from '../board/board-model';
import { briefPathBlocks, briefPathWritersOf, writerTextSource } from './org-brief-sources';

/** No picture loads from a path whose machine is not known until the click reads its writer. */
export const BRIEF_RENDER = { inlineImages: false } as const;
const renderBlock = (raw: string) => renderMarkdownWithRefs(raw, undefined, undefined, BRIEF_RENDER);

export function useBriefFileOpener(ownerId: string | undefined, text: string, sources: unknown, tasks: readonly Task[]) {
  const sourceKey = useMemo(() => JSON.stringify([ownerId, text, sources]), [ownerId, text, sources]);
  const shown = useMemo(() => ({ ownerId, text, sources, sourceKey, tasks }), [ownerId, text, sources, sourceKey, tasks]);
  const latest = useCommittedRef(shown);
  const seq = useRef(0);
  const [choices, setChoices] = useState<{ req: OpenFileRequest; sourceKey: string; hosts: PathSourcePick[] | null } | null>(null);
  // Before paint: a click after a new letter or its sources never finishes an older lookup.
  useLayoutEffect(() => {
    setChoices(null);
    return () => { seq.current++; };
  }, [sourceKey]);
  const cancel = () => { seq.current++; setChoices(null); };

  const reopen = useRef<((path: string, line?: number, term?: undefined, endLine?: number) => void) | undefined>(undefined);
  const open = useCallback((path: string, line?: number, _term?: undefined, endLine?: number) => {
    const mine = ++seq.current;
    const { ownerId: taskId, text: shapedText, sources: spans, sourceKey: key } = latest.current;
    // Its letter and sources must still be the ones shown, not only its click the newest.
    const current = () => mine === seq.current && latest.current.sourceKey === key;
    const req: OpenFileRequest = { path, ...(line ? { line } : {}), ...(endLine ? { endLine } : {}) };
    setChoices(null);
    const fail = (reason: SourceFailReason, error: string) => {
      log.warn('org-brief', 'brief path not opened: its writer machine is unknown', { taskId, path, reason, error });
      if (current()) {
        openFileAnywhere({
          ...req, sourceFailure: sourceFailureText(reason), sourceReason: reason,
          ...(reason === 'lookup' ? { retry: () => reopen.current?.(path, line, undefined, endLine) } : {}),
        });
      }
    };
    const openVia = (src: AgentTextSource) => {
      void openFromSource(src, req, {
        lookup: { peek: peekSessionRecord, fetch: fetchSession },
        open: (r) => { if (current()) openFileAnywhere(r); },
        fail: ({ reason, error }) => fail(reason, error),
      });
    };
    const writers = briefPathWritersOf(shapedText, spans, briefPathBlocks(shapedText, renderBlock), path);
    // Any part whose writer Walnut did not record opens nothing: it may be the copy the user meant.
    if (!writers?.length || writers.some((w) => writerTextSource(w).unknownSource)) {
      fail('unrecorded', 'The writer of these words was not recorded.');
      return;
    }
    const bySource = new Map(writers.map((w) => [JSON.stringify(writerTextSource(w)), w] as const));
    if (bySource.size === 1) { openVia(writerTextSource(writers[0]!)); return; }
    // Every machine already known on this page and all the same: open there, no dialog flash.
    const peeked = [...bySource.values()].map((w) => (w.by === 'human' ? { host: '', label: '' } : peekSessionRecord(w.sessionId!) ? { host: peekSessionRecord(w.sessionId!)!.host, label: '' } : null));
    if (peeked.every(Boolean)) {
      const one = boardHostChoices(peeked as BoardResolvedSource[]);
      if (one.length === 1) { openVia({ host: one[0]!.host }); return; }
    }
    setChoices({ req, sourceKey: key, hosts: null });
    void (async () => {
      // The committed task list when the machines are read: a newer one only renames, never cancels.
      const labelOf = (by: string) => by === 'human' ? 'Your words' : by.startsWith('task:')
        ? `Words of ${latest.current.tasks.find((t) => t.id === by.slice(5))?.title ?? 'a task'}` : 'Words of an agent';
      let resolved: BoardResolvedSource[];
      try {
        resolved = await Promise.all([...bySource.values()].map(async (w): Promise<BoardResolvedSource> => {
          if (w.by === 'human') return { host: '', label: labelOf(w.by) };
          let record = peekSessionRecord(w.sessionId!);
          if (!record) {
            try { record = await fetchSession(w.sessionId!); } catch (err) { throw Object.assign(new Error(err instanceof Error ? err.message : String(err)), { reason: 'lookup' as const }); }
          }
          if (!record) throw Object.assign(new Error('session not found'), { reason: 'gone' as const });
          return { host: record.host, label: labelOf(w.by), ...(record.title ? { title: record.title } : {}) };
        }));
      } catch (err) {
        if (!current()) return;
        setChoices(null);
        fail((err as { reason?: SourceFailReason }).reason ?? 'lookup', err instanceof Error ? err.message : String(err));
        return;
      }
      if (!current()) return;
      // Writers on one machine open there; several machines ask.
      const hosts = boardHostChoices(resolved);
      if (hosts.length === 1) { setChoices(null); openVia({ host: hosts[0]!.host }); return; }
      setChoices((cur) => (cur?.req === req ? { ...cur, hosts: hosts.map((h) => ({ ...h, open: () => openVia({ host: h.host }) })) } : cur));
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => { reopen.current = open; }, [open]);

  const dialog = choices && choices.sourceKey === sourceKey ? (
    <PathSourceChooser
      path={choices.req.path}
      hosts={choices.hosts}
      onPick={() => setChoices(null)}
      onCancel={cancel}
      buttonTestId="org-brief-file-source"
    />
  ) : null;
  return { open, dialog };
}
