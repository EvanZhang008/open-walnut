/**
 * Voice Accuracy's data: the engines (state, consent, switches), the summary,
 * the takes and the runner's progress. GET /run is polled only while a run is
 * going; a read that fails is tried again later and later (pollDelay), never
 * given up on, so the pane recovers by itself; when the run ends, everything is
 * read again once. A write answers with the engines as they are now, so a switch
 * or a tick shows the server's state.
 */
import { useEffect, useRef, useState } from 'react';
import { useLeanCallback } from '@/hooks/useLeanCallback';
import {
  deleteCompareData, fetchCompareEngines, fetchCompareRun, fetchCompareSummary, fetchCompareTakes, isCompareOff,
  judgeCompareTake, saveCompareSettings, startCompareRun,
  type CompareEngines, type CompareProgress, type CompareSettingsPatch, type CompareSummary, type CompareTake,
} from '@/api/stt-compare';
import { log } from '@/utils/log';
import { RUN_LAST } from './voice-accuracy-model';

export const TAKES_PAGE = 50;
export const POLL_MS = 1500;
/** The longest wait between two reads of a run whose reads keep failing. */
export const POLL_MAX_MS = 15_000;

/** The wait before the next read of the run, after `failures` reads in a row failed. */
export function pollDelay(failures: number): number {
  return Math.min(POLL_MAX_MS, POLL_MS * 2 ** Math.max(0, failures));
}
/** The server's page cap (GET /takes?limit). */
export const REFRESH_MAX = 200;

type Page = { takes: CompareTake[]; total: number; nextCursor?: string };

/** Newest first, as the server lists them. */
const newerFirst = (a: CompareTake, b: CompareTake) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id);

/**
 * A fresh read of the newest takes over the list shown: the fresh ones replace
 * theirs, and the loaded ones older than the read's last are kept, with the
 * cursor that pages past them.
 */
export function mergeRefreshed(prev: Page, fresh: Page): Page {
  const last = fresh.takes[fresh.takes.length - 1];
  if (!last || prev.takes.length <= fresh.takes.length || !fresh.nextCursor) return fresh;
  const seen = new Set(fresh.takes.map((t) => t.id));
  const tail = prev.takes.filter((t) => !seen.has(t.id) && newerFirst(last, t) < 0);
  return { takes: [...fresh.takes, ...tail], total: fresh.total, nextCursor: tail.length ? prev.nextCursor : fresh.nextCursor };
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export interface VoiceAccuracyData {
  /** The experiment is off on the server. */
  off: boolean;
  loading: boolean;
  error: string | null;
  engines: CompareEngines | null;
  summary: CompareSummary | null;
  takes: CompareTake[];
  total: number;
  nextCursor?: string;
  progress: CompareProgress | null;
  /** The last read of the run's progress failed (the poll keeps trying); null once one works. */
  pollError: string | null;
  /** The last settings write that failed, by row (`engine:<id>`, `nightly`, `key`). */
  saveError: { row: string; text: string } | null;
  save(row: string, patch: CompareSettingsPatch): Promise<boolean>;
  /**
   * Queue a run. Null when queued, else why not: a run of named recordings (a row's Retry) leaves
   * the refusal to its row; the pane's own run shows it in the Run group (`runError`).
   */
  run(req?: { takeIds?: string[]; engines?: string[]; force?: boolean }): Promise<string | null>;
  /** Queue the judge again for one take; the run's poll follows it. Null when queued, else why not. */
  judge(takeId: string): Promise<string | null>;
  /** Remove everything Voice Accuracy kept (also with the experiment off). */
  deleteData(): Promise<boolean>;
  runError: string | null;
  more(): Promise<void>;
  reload(): Promise<void>;
}

export function useVoiceAccuracy(): VoiceAccuracyData {
  const [off, setOff] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [engines, setEngines] = useState<CompareEngines | null>(null);
  const [summary, setSummary] = useState<CompareSummary | null>(null);
  const [page, setPage] = useState<{ takes: CompareTake[]; total: number; nextCursor?: string }>({ takes: [], total: 0 });
  const [progress, setProgress] = useState<CompareProgress | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<{ row: string; text: string } | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const live = useRef(true);
  // Set again on every mount: StrictMode (development) unmounts and mounts once more, and a flag
  // only ever cleared would drop every answer after that, leaving the first read's spinner forever.
  useEffect(() => { live.current = true; return () => { live.current = false }; }, []);

  const fail = useLeanCallback((err: unknown) => {
    if (!live.current) return;
    if (isCompareOff(err)) { setOff(true); return; }
    setError(message(err));
  }, []);

  const reload = useLeanCallback(async () => {
    try {
      const [e, s, t] = await Promise.all([fetchCompareEngines(), fetchCompareSummary(), fetchCompareTakes(TAKES_PAGE)]);
      if (!live.current) return;
      setOff(false);
      setError(null);
      setEngines(e);
      setSummary(s);
      setPage({ takes: t.takes, total: t.total, nextCursor: t.nextCursor });
    } catch (err) {
      fail(err);
    } finally {
      if (live.current) setLoading(false);
    }
  }, [fail]);

  // The takes shown, read again while a run fills them: at most one read of REFRESH_MAX, and the
  // takes loaded past it (Show more) are kept as they are, so the list never shrinks under the user.
  const refreshTakes = useLeanCallback(async (count: number) => {
    const t = await fetchCompareTakes(Math.min(REFRESH_MAX, Math.max(TAKES_PAGE, count)));
    if (live.current) setPage((prev) => mergeRefreshed(prev, t));
  }, []);

  useEffect(() => {
    void reload();
    void fetchCompareRun().then((p) => { if (live.current) setProgress(p) }, () => {});
  }, [reload]);

  // Poll only while a run is going; one full read when it ends.
  const running = progress?.running === true || (progress?.queued ?? 0) > 0;
  const shownCount = useRef(0);
  shownCount.current = page.takes.length;
  useEffect(() => {
    if (!running) return;
    let stop = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      let p: CompareProgress;
      try {
        p = await fetchCompareRun();
      } catch (err) {
        if (stop || !live.current) return;
        if (isCompareOff(err)) { fail(err); return; }
        // The run goes on on the server: read it again later, and later after each failure.
        failures++;
        log.warn('voice-accuracy', 'reading the run failed; trying again', { failures, error: message(err) });
        setPollError(message(err));
        timer = setTimeout(() => void tick(), pollDelay(failures));
        return;
      }
      if (stop || !live.current) return;
      if (failures) log.info('voice-accuracy', 'reading the run works again', { failures });
      failures = 0;
      setPollError(null);
      setProgress(p);
      if (p.running || p.queued > 0) {
        await refreshTakes(shownCount.current).catch(() => {});
        if (!stop) timer = setTimeout(() => void tick(), POLL_MS);
      } else {
        log.info('voice-accuracy', 'comparison run ended', { done: p.done, total: p.total, compared: p.compared ?? null, lastError: p.lastError ?? null });
        void reload();
      }
    };
    timer = setTimeout(() => void tick(), POLL_MS);
    return () => { stop = true; clearTimeout(timer); };
  }, [running, reload, refreshTakes, fail]);

  const save = useLeanCallback(async (row: string, patch: CompareSettingsPatch) => {
    setSaveError(null);
    try {
      const next = await saveCompareSettings(patch);
      if (!live.current) return true;
      setEngines(next);
      log.info('voice-accuracy', 'settings saved', { row });
      // A switch or a consent changes what the summary can show (the judge's line).
      void fetchCompareSummary().then((s) => { if (live.current) setSummary(s) }, () => {});
      return true;
    } catch (err) {
      if (isCompareOff(err)) { fail(err); return false; }
      log.warn('voice-accuracy', 'settings save failed', { row, error: message(err) });
      if (live.current) setSaveError({ row, text: message(err) });
      return false;
    }
  }, [fail]);

  const run = useLeanCallback(async (req: { takeIds?: string[]; engines?: string[]; force?: boolean } = {}): Promise<string | null> => {
    const named = !!req.takeIds?.length;
    if (!named) setRunError(null);
    try {
      const p = await startCompareRun(req.takeIds ? req : { last: RUN_LAST, ...req });
      log.info('voice-accuracy', 'comparison run queued', { takeIds: req.takeIds ?? null, engines: req.engines ?? null });
      if (!live.current) return null;
      // The job starts a moment after it is queued: it reads as running at once, and the poll says how far.
      setProgress({ ...p, running: true, ...(p.running ? {} : { done: 0, total: 0, engine: undefined, lastError: undefined }) });
      if (req.takeIds) {
        const ids = new Set(req.takeIds);
        setPage((prev) => ({
          ...prev,
          takes: prev.takes.map((t) => (ids.has(t.id)
            ? { ...t, run: { ...t.run, ...Object.fromEntries((req.engines ?? []).map((e) => [e, { state: 'queued' as const }])) } }
            : t)),
        }));
      }
      return null;
    } catch (err) {
      if (isCompareOff(err)) { fail(err); return message(err); }
      log.warn('voice-accuracy', 'comparison run refused', { named, error: message(err) });
      if (live.current && !named) setRunError(message(err));
      return message(err);
    }
  }, [fail]);

  const judge = useLeanCallback(async (takeId: string): Promise<string | null> => {
    try {
      const p = await judgeCompareTake(takeId);
      log.info('voice-accuracy', 'judge again queued', { takeId });
      if (live.current) setProgress({ ...p, running: true, ...(p.running ? {} : { done: 0, total: 0, engine: undefined, lastError: undefined }) });
      return null;
    } catch (err) {
      if (isCompareOff(err)) { fail(err); return message(err); }
      log.warn('voice-accuracy', 'judge again refused', { takeId, error: message(err) });
      return message(err);
    }
  }, [fail]);

  const deleteData = useLeanCallback(async (): Promise<boolean> => {
    setSaveError(null);
    try {
      const next = await deleteCompareData();
      log.info('voice-accuracy', 'comparison data deleted');
      if (!live.current) return true;
      setEngines(next);
      setPage({ takes: [], total: 0 });
      void reload();
      return true;
    } catch (err) {
      log.warn('voice-accuracy', 'deleting comparison data failed', { error: message(err) });
      if (live.current) setSaveError({ row: 'delete', text: message(err) });
      return false;
    }
  }, [reload]);

  const more = useLeanCallback(async () => {
    if (!page.nextCursor) return;
    try {
      const t = await fetchCompareTakes(TAKES_PAGE, page.nextCursor);
      if (live.current) setPage((prev) => ({ takes: [...prev.takes, ...t.takes], total: t.total, nextCursor: t.nextCursor }));
    } catch (err) {
      fail(err);
    }
  }, [page.nextCursor, fail]);

  return {
    off, loading, error, engines, summary, takes: page.takes, total: page.total, nextCursor: page.nextCursor,
    progress, pollError, saveError, save, run, judge, deleteData, runError, more, reload,
  };
}
