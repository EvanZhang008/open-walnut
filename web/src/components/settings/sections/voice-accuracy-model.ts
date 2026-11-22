/**
 * Voice Accuracy's view model, kept free of React so it is tested on its own:
 * the words for each engine state and consent, the numbers as shown, the
 * marked lowest value, what a run will do, and whether the engine columns fit
 * the pane (when they do not, or on a phone, the recordings become a stacked
 * list: nothing scrolls sideways).
 */
import type { NoticeTone } from '@/components/common/NoticeCard';
import type {
  CompareEngineRow, CompareEngineState, CompareEngineSummary, CompareProgress, CompareResult, CompareRunState, CompareScore, CompareTake,
} from '@/api/stt-compare';

/** Half a percentage point: a lower value is marked only when it leads the next by this much. */
export const MARK_MARGIN = 0.005;

/** The matrix's recording column at its narrowest, one engine column, and the row's own padding and chevron. */
export const TAKE_COL_MIN = 240;
export const ENGINE_COL = 88;
const ROW_CHROME = 56;

/** The manual run's size (POST /run `last`). */
export const RUN_LAST = 20;

/** Whether `columns` engine columns fit beside the recording column in `width` px. */
export function matrixFits(width: number, columns: number): boolean {
  return width > 0 && width >= TAKE_COL_MIN + columns * ENGINE_COL + ROW_CHROME;
}

export type TakesLayout = 'matrix' | 'stacked';
export function takesLayout(width: number, columns: number, phone: boolean): TakesLayout {
  return !phone && matrixFits(width, columns) ? 'matrix' : 'stacked';
}

export const STATE_WORDS: Record<CompareEngineState, { word: string; tone: NoticeTone }> = {
  ready: { word: 'Ready', tone: 'ok' },
  off: { word: 'Off', tone: 'muted' },
  'needs-consent': { word: 'Upload not allowed', tone: 'warn' },
  'needs-key': { word: 'Needs a key', tone: 'warn' },
  'key-lacks-permission': { word: 'Key lacks permission', tone: 'error' },
  'quota-used': { word: 'Quota used up', tone: 'warn' },
  'may-cost': { word: 'Could cost money', tone: 'warn' },
  'not-installed': { word: 'Not ready', tone: 'muted' },
};

/** The state's words on an engine's row; a text engine's missing consent reads as sending, like its tick. */
export function stateWords(engine: Pick<CompareEngineRow, 'state' | 'sends'>): { word: string; tone: NoticeTone } {
  if (engine.state === 'needs-consent' && engine.sends === 'text') return { word: 'Sending not allowed', tone: 'warn' };
  return STATE_WORDS[engine.state];
}

export const RUN_WORDS: Record<Exclude<CompareRunState, 'done'>, string> = {
  queued: 'Queued',
  running: 'Running',
  failed: 'Failed',
};

/** A short column name; the full label rides on the header's title and each number's label. */
export function shortLabel(engine: Pick<CompareEngineRow, 'id' | 'label'>): string {
  switch (engine.id) {
    case 'in-use': return 'In use';
    case 'whisper-large-v2': return 'Whisper';
    case 'elevenlabs-scribe': return 'Scribe';
    case 'haiku-cleanup': return '+ Haiku';
    case 'judge': return 'AI judge';
    default: return engine.label;
  }
}

/** Where an engine runs and what leaves this computer when it does. */
export function whereItRuns(engine: Pick<CompareEngineRow, 'id' | 'runsOn' | 'sends' | 'label'>): string {
  switch (engine.id) {
    case 'in-use':
      return engine.sends === 'nothing'
        ? 'The engine your dictation uses now. On this computer, nothing leaves it.'
        : 'The engine your dictation uses now, a cloud service: your recordings are uploaded to it again for the comparison.';
    case 'elevenlabs-scribe':
      return 'Your recordings are sent to ElevenLabs. Walnut uses only the included quota, keeps the last 10%, and uploads nothing while usage-based billing is on.';
    case 'haiku-cleanup':
      return "Fixes your terms in the In use engine's text. That text, your term list and up to 80 recent task titles go to the AI model Walnut uses.";
    case 'judge':
      return "Reads each engine's direct transcript, not the Haiku clean-up of it (it doesn't listen to the recordings), and writes its guess of what you said; the estimated errors are counted against that guess. Those transcripts, your term list and up to 80 recent task titles go to the AI model Walnut uses.";
    default:
      if (engine.sends === 'nothing') return 'On this computer, nothing leaves it.';
      return engine.sends === 'audio' ? `Your recordings are sent to ${engine.label}.` : `Texts and your term list go to ${engine.label}.`;
  }
}

/** The consent tick's words: what is sent, to whom, and why. Null for an engine that sends nothing. */
export function consentWords(engine: Pick<CompareEngineRow, 'id' | 'sends' | 'label'>): string | null {
  if (engine.sends === 'nothing') return null;
  switch (engine.id) {
    case 'in-use': return 'Allow uploading my recordings again to the cloud engine my dictation uses, to compare its text with the other engines';
    case 'elevenlabs-scribe': return 'Allow uploading my recordings to ElevenLabs, to compare its transcripts with the other engines';
    case 'haiku-cleanup': return "Allow sending the In use engine's text, my term list and up to 80 task titles to the AI model Walnut uses, so it can fix my terms in that text";
    case 'judge': return "Allow sending each engine's own text (its direct transcript, not the cleaned-up version), my term list and up to 80 task titles to the AI model Walnut uses, so it can guess what I said and estimate each engine's errors";
    default:
      return engine.sends === 'audio'
        ? `Allow uploading my recordings to ${engine.label}, to compare its transcripts with the other engines`
        : `Allow sending the texts and my term list to ${engine.label}, to compare its text with the other engines`;
  }
}

/** Where to get an ElevenLabs key. */
export const ELEVENLABS_KEYS_URL = 'https://elevenlabs.io/app/settings/api-keys';

/**
 * What the key needs, said before the user makes it: Speech to Text for the transcripts, and read
 * access to the user's subscription, which Walnut reads to check the free quota before every upload
 * (src/core/stt/compare/elevenlabs.ts checkQuota, GET /v1/user/subscription).
 */
export const ELEVENLABS_KEY_HINT =
  "Kept in Walnut's secrets on this computer, never synced. A free-plan key is enough. When you create it, give it Speech to Text and read access to User (Walnut reads the subscription to check the free quota before it uploads). ";

/** Why a typed API key cannot be saved (the server's own check), or null. */
export function keyProblem(value: string): string | null {
  if (!value) return 'Paste a key first.';
  if (/\s/.test(value) || value.length < 8 || value.length > 512) return 'That does not look like an API key.';
  return null;
}

export function pct(rate: number | null | undefined): string {
  return rate === null || rate === undefined ? '' : `${(rate * 100).toFixed(1)}%`;
}

export function wholePct(rate: number | null | undefined): string {
  return rate === null || rate === undefined ? '' : `${Math.round(rate * 100)}%`;
}

/** Engine time; an engine that edits another's text shows what it adds. */
export function seconds(ms: number | null | undefined, adds = false): string {
  if (ms === null || ms === undefined) return '';
  return `${adds ? '+' : ''}${(ms / 1000).toFixed(1)} s`;
}

/** One engine's numbers in the summary, each with its name: never a bare figure. */
export function summaryMetrics(row: CompareEngineSummary, adds: boolean): Array<{ label: string; value: string }> {
  const out: Array<{ label: string; value: string }> = [];
  if (row.cjk !== null) out.push({ label: 'Chinese', value: pct(row.cjk) });
  if (row.latin !== null) out.push({ label: 'English', value: pct(row.latin) });
  if (row.terms !== null) out.push({ label: 'Your terms recognized', value: wholePct(row.terms) });
  if (row.medianMs !== null) out.push({ label: adds ? 'Median extra time' : 'Median time', value: seconds(row.medianMs) });
  return out;
}

export function takeRate(score: CompareScore | undefined): number | null {
  return score && score.n > 0 ? score.edits / score.n : null;
}

/** The id whose value is lowest by at least MARK_MARGIN, if one is. */
export function markedLowest(values: ReadonlyArray<{ id: string; value: number | null }>): string | undefined {
  const ranked = values.filter((v) => v.value !== null).sort((a, b) => a.value! - b.value!);
  if (ranked.length < 2) return undefined;
  return ranked[1]!.value! - ranked[0]!.value! >= MARK_MARGIN ? ranked[0]!.id : undefined;
}

export interface TakeCell {
  /** What the cell says: the rate, a run state, or that it has not run. */
  text: string;
  /** Set when the cell is a state, not a number: drawn as the shared status (a dot and its word). */
  status?: NoticeTone;
  /** The engine's time under it. */
  sub?: string;
  tone?: 'error' | 'muted';
  /** The failure, for its title and the detail. */
  error?: string;
}

/** One engine's cell for a recording: a live run state wins over what is stored. */
export function takeCell(take: CompareTake, engine: { id: string; after?: string }): TakeCell {
  const run = take.run[engine.id];
  if (run && run.state !== 'done') {
    return run.state === 'failed'
      ? { text: RUN_WORDS.failed, tone: 'error', status: 'error', error: run.error }
      : { text: RUN_WORDS[run.state], tone: 'muted', status: 'live' };
  }
  const result = take.results[engine.id];
  if (!result) return { text: 'Not run', tone: 'muted', status: 'muted' };
  if (result.text === undefined) return { text: RUN_WORDS.failed, tone: 'error', status: 'error', error: result.error };
  const rate = takeRate(take.scores?.[engine.id]);
  return { text: rate === null ? 'Not judged' : pct(rate), sub: seconds(result.ms, !!engine.after), ...(rate === null ? { tone: 'muted' as const, status: 'muted' as const } : {}) };
}

/** The recording's own words for its row, and where they come from: what was sent, else what Walnut wrote then. */
export function takeText(take: CompareTake): { source: typeof SENT_SOURCE | 'Engine text'; text: string } {
  if (take.sentText !== undefined) return { source: SENT_SOURCE, text: take.sentText };
  return { source: 'Engine text', text: take.inUseText ?? take.results['in-use']?.text ?? '' };
}

/** Why the AI judge cannot run now, in words, and what turns it on; null when it can. */
export function judgeBlocker(judge: Pick<CompareEngineRow, 'state'> | undefined): { text: string; fix: string } | null {
  if (!judge || judge.state === 'ready') return null;
  if (judge.state === 'off') return { text: 'The AI judge is off.', fix: 'Turn it on' };
  if (judge.state === 'needs-consent') return { text: "Sending texts to the AI judge isn't allowed.", fix: "Review what's sent" };
  return { text: `The AI judge isn't ready (${STATE_WORDS[judge.state].word.toLowerCase()}).`, fix: 'See the AI judge' };
}

export type RunPlan =
  | { kind: 'hear'; engines: string[]; judge: boolean }
  | { kind: 'judge-only' }
  | { kind: 'nothing'; why: string };

/** What the manual run will do with the engines as they are now. */
export function runPlan(engines: ReadonlyArray<CompareEngineRow>): RunPlan {
  const ready = engines.filter((e) => e.kind === 'engine' && e.state === 'ready');
  const judge = engines.find((e) => e.kind === 'judge')?.state === 'ready';
  if (ready.length) return { kind: 'hear', engines: ready.map((e) => e.label), judge };
  if (judge) return { kind: 'judge-only' };
  return { kind: 'nothing', why: 'No engine is ready and the AI judge is off, so nothing can run.' };
}

export function runPlanWords(plan: RunPlan): string {
  switch (plan.kind) {
    case 'hear': {
      const n = plan.engines.length;
      const who = `${n} engine${n === 1 ? '' : 's'} (${plan.engines.join(', ')})`;
      return plan.judge
        ? `Hears them again with ${who}, then the AI judge estimates the errors. Runs in the background and waits while you dictate; a failed engine is tried again.`
        : `Hears them again with ${who}. The AI judge can't run, so it makes no new guesses: a recording that already has one is scored against it, the others get no estimated errors. Runs in the background and waits while you dictate.`;
    }
    case 'judge-only':
      return "No engine is ready, so this run only asks the AI judge again where a recording has new texts.";
    case 'nothing':
      return plan.why;
  }
}

/** The run's main button: a run that can only ask the AI judge says so. */
export function runButtonWords(plan: RunPlan): string {
  return plan.kind === 'judge-only' ? 'Estimate errors' : 'Run comparison';
}

const recordingsWord = (n: number) => `${n} recording${n === 1 ? '' : 's'}`;

/** What the last run did, in place, once it has ended: the recordings it really compared, not the planned ones; null while none has. */
export function lastRunWords(p: CompareProgress | null): string | null {
  if (!p || p.running || p.queued > 0 || !p.finishedAt || p.takes === undefined) return null;
  if (p.takes === 0) return 'The last run found nothing to compare: every recording is already compared by the engines that are ready.';
  // Servers before `compared` existed count the planned recordings.
  const done = p.compared ?? p.takes;
  if (done < p.takes) return `The last run compared ${done} of the ${recordingsWord(p.takes)} it planned; the rest were stopped or skipped.`;
  return `The last run compared ${recordingsWord(done)}.`;
}

/** An engine's own name, without the model in use now (an older server sends only the label). */
export function engineName(engine: Pick<CompareEngineRow, 'label' | 'name'>): string {
  return engine.name ?? engine.label;
}

/**
 * Which model a summary row's results were made with, as recorded on them (never the one in use
 * now): one model, mixed models (unrecorded ones counted as one more kind), or not recorded.
 */
export function summaryModel(row: Pick<CompareEngineSummary, 'models' | 'unrecorded'>): { words: string; mixed: boolean } {
  const models = row.models ?? [];
  const unknown = (row.unrecorded ?? 0) > 0;
  const kinds = models.length + (unknown ? 1 : 0);
  if (kinds === 0 || (!models.length && unknown)) return { words: 'model not recorded', mixed: false };
  if (kinds === 1) return { words: models[0]!, mixed: false };
  return { words: `mixed models: ${[...models, ...(unknown ? ['model not recorded'] : [])].join(', ')}`, mixed: true };
}

/** The model one result was made with, as recorded on it. */
export function resultModel(result: Pick<CompareResult, 'model'>): string {
  return result.model ? `Made with ${result.model}` : 'Model not recorded';
}

/** Who wrote the AI's guess (`unknown` is a guess whose judge recorded no model). */
export function judgeWords(judge: string): string {
  return judge && judge !== 'unknown' ? `by ${judge}, not checked by a person` : 'model not recorded, not checked by a person';
}

const clock = (iso: string | undefined) => {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }) : '';
};

/**
 * The heading of what was sent: a guess by text, never stated as fact. Walnut pairs a person's
 * send with a dictation by how alike their texts are, within 15 minutes, not by the recording.
 */
export function sentHeading(take: Pick<CompareTake, 'sentAt'>): string {
  const at = clock(take.sentAt);
  return `Probably what you sent (matched by text${at ? `, ${at}` : ''})`;
}

/** The row preview's source: what was probably sent, else what Walnut wrote then. */
export const SENT_SOURCE = 'Probably sent';
