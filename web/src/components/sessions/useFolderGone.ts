/**
 * Whether a draft's folder is gone on its host, asked before Start (2026-11-23: a project's own
 * folder had been deleted on the Mac; the task was made, its session never started, and the draft
 * said nothing). The host answers through list-dirs: `exists: false` only for a folder that is not
 * there (ENOENT); a host that does not answer, or any other failure, reads as "not known", so the
 * draft never blocks on a guess. The server checks again at Start (quickStartSession), which is the
 * real gate; this only says it sooner. Asked uncached, and again when the window comes back (a
 * folder made again meanwhile frees Start at once).
 */
import { useEffect, useReducer, useState } from 'react';
import { listDirs } from '@/api/sessions';

export function useFolderGone(cwd: string | null | undefined, host: string | null | undefined, on: boolean): boolean {
  const key = on && cwd && cwd !== '~' && !cwd.startsWith('~/') ? `${host ?? ''}\n${cwd}` : '';
  const [gone, setGone] = useState<{ key: string; gone: boolean }>({ key: '', gone: false });
  const [nonce, again] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!key) return;
    window.addEventListener('focus', again);
    return () => window.removeEventListener('focus', again);
  }, [key]);
  useEffect(() => {
    if (!key || !cwd) return;
    const ac = new AbortController();
    const dir = cwd.endsWith('/') ? cwd : `${cwd}/`;
    listDirs(dir, host, { signal: ac.signal, depth: 1 })
      .then((l) => { if (!ac.signal.aborted) setGone({ key, gone: !l.pending && !l.hostError && l.exists === false }); })
      .catch(() => { if (!ac.signal.aborted) setGone({ key, gone: false }); });
    return () => ac.abort();
  }, [key, cwd, host, nonce]);
  return !!key && gone.key === key && gone.gone;
}
