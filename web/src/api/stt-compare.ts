/**
 * Voice Accuracy (experiment `stt_compare`): /api/stt/compare
 * (src/web/routes/stt-compare.ts). Every route answers 409 `experimental_off`
 * while the experiment is off; `isCompareOff` names that answer.
 */
import { apiGet, apiGetBlob, apiPost, apiPut } from './client';
import { ApiError } from './api-error';

const BASE = '/api/stt/compare';

export type CompareEngineState =
  | 'off' | 'needs-consent' | 'needs-key' | 'key-lacks-permission' | 'quota-used' | 'may-cost' | 'not-installed' | 'ready';
export type CompareRunState = 'queued' | 'running' | 'failed' | 'done';

export interface CompareEngineRow {
  id: string;
  /** What runs now: the configured engine and model. */
  label: string;
  /** The engine's own name, without the model in use now (older servers: absent). */
  name?: string;
  kind: 'engine' | 'judge';
  /** Where it runs: on the computer Walnut runs on, or a cloud service. */
  runsOn: 'local' | 'cloud';
  sends: 'nothing' | 'audio' | 'text';
  /** Post-processes this engine's text. */
  after?: string;
  state: CompareEngineState;
  detail?: string;
  /** What makes a not-ready engine ready: the Voice pane's setup, or the Whisper model's download. */
  fix?: 'set-up-dictation' | 'download-whisper';
  /** The model id it would use now (secondary detail). */
  model?: string;
  enabled: boolean;
  allow_upload: boolean;
  quota?: { tier: string; used: number; limit: number; left: number; overage: boolean };
}

export interface CompareEngines {
  engines: CompareEngineRow[];
  nightly: boolean;
  hasElevenLabsKey: boolean;
  /** Where that key comes from: saved here, the key in Settings > Voice, or none (older servers send nothing). */
  elevenLabsKeyFrom?: 'here' | 'voice' | null;
}

export interface CompareRates { mixed: number | null; cjk: number | null; latin: number | null; terms: number | null }
export interface CompareEngineSummary extends CompareRates {
  id: string;
  medianMs: number | null;
  takes: number;
  scoredTakes: number;
  /** The models its results were made with; more than one means the rate mixes them (older servers: absent). */
  models?: string[];
  /** Results among them that recorded no model (older servers: absent). */
  unrecorded?: number;
}
export interface CompareDay { day: string; takes: number; engines: Record<string, CompareRates>; best?: string }
/** One engine on one day, over every take it scored that day. */
export interface CompareTrendPoint extends CompareRates { takes: number; medianMs: number | null }
/** Only the engines that scored a take that day. */
export interface CompareTrendDay { day: string; engines: Record<string, CompareTrendPoint> }
export interface CompareSummary {
  takes: number;
  judged: number;
  sharedTakes: number;
  engines: CompareEngineSummary[];
  best?: string;
  byDay: CompareDay[];
  /** Every scored take by local day, oldest first, each engine alone (older servers: absent). */
  trend?: CompareTrendDay[];
  judge: { state: CompareEngineState; detail?: string };
  /** Dictations edited before they were sent, kept as training pairs (older servers: absent). */
  editedTakes?: number;
}

export interface CompareResult { text?: string; error?: string; ms: number; at: string; model?: string }
export interface CompareScore { edits: number; n: number; cjkEdits: number; cjkN: number; latEdits: number; latN: number; termsHit: number; termsNeed: number }
export interface CompareTake {
  id: string;
  source: 'web' | 'phone';
  at: string;
  durationSec?: number;
  format: string;
  /** What the user sent after this take. */
  sentText?: string;
  sentAt?: string;
  /** `recording-id`: the send named this recording (exact); `text-similarity`: a guess by text within 15 minutes. */
  sentMatch?: 'text-similarity' | 'recording-id';
  /** A similarity pairing's similarity, 0 to 1. */
  sentSimilarity?: number;
  /** Paired by recording id, and what was sent is not the engine's text: a training pair. */
  edited?: boolean;
  inUseText?: string;
  results: Record<string, CompareResult>;
  reference?: { text: string; judge: string; at: string };
  scores?: Record<string, CompareScore>;
  imported?: string;
  /** Per engine (and `judge`): the state in the last run that touched it. */
  run: Record<string, { state: CompareRunState; error?: string }>;
}
export interface CompareTakesPage { takes: CompareTake[]; nextCursor?: string; total: number }

export interface DiffSegment { op: 'same' | 'changed' | 'extra' | 'missing'; text: string; ref?: string }
/** One take with each engine's (and `sent`'s) word diff against the AI's guess. */
export interface CompareTakeDetail extends CompareTake { diffs: Record<string, DiffSegment[]> }

export interface CompareProgress {
  running: boolean;
  done: number;
  total: number;
  current?: string;
  engine?: string;
  startedAt?: string;
  finishedAt?: string;
  lastError?: string;
  /** The recordings the job planned to compare (servers before 2026-11-22: absent). */
  takes?: number;
  /** The recordings it actually compared (older servers: absent). */
  compared?: number;
  queued: number;
}

export interface CompareSettingsPatch {
  engines?: Record<string, { enabled?: boolean; allow_upload?: boolean }>;
  nightly?: boolean;
  /** An empty string removes the stored key. */
  elevenlabs_api_key?: string;
}

/** The experiment is off on the server (every route's 409). */
export function isCompareOff(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409 && (err.body as { error?: string } | undefined)?.error === 'experimental_off';
}

const quiet = { quietStatuses: [409] };

export const fetchCompareSummary = (engines?: string[]) =>
  apiGet<CompareSummary>(`${BASE}/summary`, engines?.length ? { engines: engines.join(',') } : undefined, quiet);
export const fetchCompareTakes = (limit = 50, cursor?: string) =>
  apiGet<CompareTakesPage>(`${BASE}/takes`, { limit: String(limit), ...(cursor ? { cursor } : {}) }, quiet);
export const fetchCompareTake = (id: string) => apiGet<CompareTakeDetail>(`${BASE}/takes/${encodeURIComponent(id)}`, undefined, quiet);
export const fetchCompareEngines = () => apiGet<CompareEngines>(`${BASE}/engines`, undefined, quiet);
export const saveCompareSettings = (patch: CompareSettingsPatch) => apiPut<CompareEngines>(`${BASE}/settings`, patch, quiet);
export const fetchCompareRun = () => apiGet<CompareProgress>(`${BASE}/run`, undefined, quiet);
export const startCompareRun = (req: { last?: number; takeIds?: string[]; engines?: string[]; force?: boolean }) =>
  apiPost<CompareProgress>(`${BASE}/run`, req, quiet);
/** Queues the judge again for one take (202); GET /run follows it like any run. */
export const judgeCompareTake = (id: string) => apiPost<CompareProgress>(`${BASE}/takes/${encodeURIComponent(id)}/judge`, {}, quiet);
/** Removes the compared takes, the stored key and the pane's settings (works with the experiment off). */
export const deleteCompareData = () => apiPost<CompareEngines>(`${BASE}/delete-data`, {}, quiet);

/** The edited dictations, one JSON line each (audio path, engine text, sent text), for the user to keep. */
export const fetchComparePairs = () => apiGetBlob(`${BASE}/pairs.jsonl`, { timeoutMs: 120_000 });

/** The take's recording, for the user's own Play button (never fetched before the click); null when it is no longer kept. */
export async function fetchCompareAudio(id: string, signal?: AbortSignal): Promise<Blob | null> {
  try {
    return await apiGetBlob(`${BASE}/takes/${encodeURIComponent(id)}/audio`, { signal, timeoutMs: 120_000 });
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}
