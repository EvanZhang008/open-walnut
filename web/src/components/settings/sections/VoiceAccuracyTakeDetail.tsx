/**
 * One recording, opened in its dialog (VoiceAccuracyTakeDialog): Play recording
 * and Recalculate estimated errors at the top, then one engine's text at a time
 * (a switch that wraps, never scrolls, picks the engine, or what was probably
 * sent) beside the AI's guess of what was said, then the legend of the marks.
 * Each result is labelled by the model recorded on it, never the one in use now. The engine's text reads exactly as the
 * engine wrote it, spaces included, so a copy gives it back: a word heard wrong
 * or added is marked in place, and a word the guess has that the engine left
 * out is a caret at its place, listed under the text, never put into the line.
 * Read when it opens. The recording is fetched and played only on the user's
 * own click, never before, never by itself.
 */
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { NoticeStatus } from '@/components/common/NoticeCard';
import {
  fetchCompareAudio, fetchCompareTake,
  type CompareEngineRow, type CompareTakeDetail, type DiffSegment,
} from '@/api/stt-compare';
import { log } from '@/utils/log';
import { usePageView } from '@/utils/view-memory';
import { SettingsNotice } from '../SettingsSection';
import { SegmentedControl } from '../inputs/SegmentedControl';
import { SettingsButton } from '../inputs/SettingsButton';
import { showEngineRow } from './VoiceAccuracyEngines';
import { RUN_WORDS, engineName, judgeBlocker, judgeWords, resultModel, seconds, sentHeading, shortLabel } from './voice-accuracy-model';

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The caret that marks where the engine left words out (drawn by CSS, so a copy never takes it). */
const CARET = '\u2038';

/**
 * The engine's text with what differs from the AI's guess marked. The words are the engine's own,
 * in its order with its spaces; a missing stretch is an empty mark (its caret is CSS content), and
 * the missing words are listed under the text.
 */
export function DiffText({ segments, fallback, testId }: { segments: DiffSegment[] | undefined; fallback: string; testId?: string }) {
  if (!segments?.length) return <p className="va-detail-text" data-testid={testId}>{fallback}</p>;
  const missing = segments.filter((s) => s.op === 'missing' && s.ref);
  return (
    <>
      <p className="va-detail-text" data-testid={testId}>
        {segments.map((s, i) => {
          if (s.op === 'same') return <Fragment key={i}>{s.text}</Fragment>;
          if (s.op === 'missing') return <span key={i} className="va-diff-missing" role="img" aria-label={`Missing: ${s.ref ?? ''}`} title={`Missing: ${s.ref ?? ''}`} />;
          if (s.op === 'extra') return <mark key={i} className="va-diff va-diff-extra" title="Extra: not in the AI's guess">{s.text}</mark>;
          return <mark key={i} className="va-diff va-diff-wrong" title={`Differs from the AI's guess: ${s.ref ?? ''}`}>{s.text}</mark>;
        })}
      </p>
      {missing.length > 0 && (
        <p className="va-detail-note" data-testid="va-missing-list">
          {`Missing (${CARET}): ${missing.map((s) => s.ref).join(' · ')}`}
        </p>
      )}
    </>
  );
}

/** What each mark means, in shape as well as colour. */
export function DiffLegend() {
  return (
    <p className="va-legend" data-testid="va-diff-legend">
      <span className="va-legend-item"><mark className="va-diff va-diff-wrong">word</mark> differs from the AI&apos;s guess</span>
      <span className="va-legend-item"><mark className="va-diff va-diff-extra">word</mark> extra, not in the guess</span>
      <span className="va-legend-item"><span className="va-diff-missing" aria-hidden="true" /> missing, listed under the text</span>
    </p>
  );
}

function PlayRecording({ takeId }: { takeId: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [gone, setGone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    if (!url) return;
    // The click that fetched it plays it, once it is in the page; a browser that refuses still shows its controls.
    void audioRef.current?.play().catch(() => {});
    return () => URL.revokeObjectURL(url);
  }, [url]);
  const play = async () => {
    if (url) { void audioRef.current?.play().catch(() => {}); return; }
    setBusy(true);
    setError(null);
    try {
      const blob = await fetchCompareAudio(takeId);
      if (!blob) {
        setGone(true);
        log.info('voice-accuracy', 'recording no longer available', { takeId });
        return;
      }
      setUrl(URL.createObjectURL(blob));
      log.info('voice-accuracy', 'recording played', { takeId });
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <SettingsButton onClick={() => void play()} busy={busy} busyLabel="Loading..." disabled={gone} data-testid="va-play">Play recording</SettingsButton>
      {gone && <span className="va-detail-note" role="status" data-testid="va-audio-gone">Recording is no longer available</span>}
      {url && <audio ref={audioRef} src={url} controls preload="none" data-testid="va-audio" />}
      {error && <span className="va-detail-note" role="alert">{`Couldn't play it: ${error}`}</span>}
    </>
  );
}

const SENT = 'sent';
const isString = (v: unknown): v is string => typeof v === 'string';

interface Props {
  takeId: string;
  /** The engine columns, in order. */
  engines: CompareEngineRow[];
  /** The AI judge's row: whether errors can be estimated again now. */
  judge: CompareEngineRow | undefined;
  /** Changes when the recording changed in the list (a run moved it), so the detail reads it again. */
  version: string;
  /** Why the last Retry on this recording could not start, shown beside the engine's Retry. */
  retryError?: string;
  onRetry(engineId: string): void;
  /** Queue the judge again (a run like any other); null when queued, else why not. */
  onJudge(): Promise<string | null>;
  /** Takes the user to the AI judge's row in the pane (the dialog closes first). */
  onShowJudge?(): void;
}

function EngineText({ take, engine, retryError, onRetry }: { take: CompareTakeDetail; engine: CompareEngineRow; retryError?: string; onRetry(engineId: string): void }) {
  const result = take.results[engine.id];
  const run = take.run[engine.id];
  const score = take.scores?.[engine.id];
  const failed = run?.state === 'failed' || (result && result.text === undefined && (!run || run.state === 'done'));
  const live = run && (run.state === 'queued' || run.state === 'running');
  return (
    <div className="va-detail-block" data-testid={`va-detail-${engine.id}`}>
      <span className="va-detail-head">
        <span>{engineName(engine)}</span>
        {score && <span>{`${score.edits} estimated error${score.edits === 1 ? '' : 's'}`}</span>}
        {result?.text !== undefined && <span>{seconds(result.ms, !!engine.after)}</span>}
        {live && <NoticeStatus tone="live" whole>{RUN_WORDS[run.state as 'queued' | 'running']}</NoticeStatus>}
        {failed && <NoticeStatus tone="error" whole>{RUN_WORDS.failed}</NoticeStatus>}
        {result && <span className="va-detail-head-quiet" data-testid="va-result-model">{resultModel(result)}</span>}
        {!live && (failed || !result) && engine.state === 'ready' && (
          <SettingsButton onClick={() => onRetry(engine.id)} data-testid={`va-retry-${engine.id}`}>{failed ? 'Retry' : 'Run'}</SettingsButton>
        )}
      </span>
      {retryError && <p className="va-error" role="alert" data-testid="va-retry-error">{retryError}</p>}
      {result?.text !== undefined
        ? <DiffText segments={take.diffs[engine.id]} fallback={result.text} testId="va-engine-text" />
        : <p className="va-detail-note">{failed ? (run?.error ?? result?.error ?? 'It failed.') : live ? 'Waiting for its turn.' : 'Not run on this recording yet.'}</p>}
    </div>
  );
}

export function VoiceAccuracyTakeDetail({ takeId, engines, judge, version, retryError, onRetry, onJudge, onShowJudge }: Props) {
  const [take, setTake] = useState<CompareTakeDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [judging, setJudging] = useState(false);
  // Which text is shown is a view choice, kept like the pane's other ones.
  const [picked, setPicked] = usePageView<string>('settings-voice-accuracy', 'detailText', engines[0]?.id ?? SENT, isString);
  const load = useCallback(async () => {
    try {
      setTake(await fetchCompareTake(takeId));
      setError(null);
    } catch (err) {
      setError(message(err));
    }
  }, [takeId]);
  useEffect(() => { void load(); }, [load, version]);

  const recalculate = async () => {
    setJudging(true);
    setError(null);
    const refused = await onJudge();
    if (refused) setError(`Couldn't recalculate it: ${refused}`);
    setJudging(false);
  };

  if (!take) {
    return error
      ? <SettingsNotice kind="error" role="alert">{`Couldn't read this recording: ${error}`}</SettingsNotice>
      : <p className="va-detail-note">Reading this recording...</p>;
  }

  const options = [
    ...engines.map((e) => ({ value: e.id, label: shortLabel(e), title: e.label, testId: `va-show-${e.id}` })),
    { value: SENT, label: 'Probably sent', title: 'What you probably sent, matched by text', testId: 'va-show-sent' },
  ];
  const shown = options.some((o) => o.value === picked) ? picked : options[0]!.value;
  const engine = engines.find((e) => e.id === shown);
  const blocker = judgeBlocker(judge);
  const judgeLive = take.run.judge?.state === 'queued' || take.run.judge?.state === 'running';
  const judgeFailed = take.run.judge?.state === 'failed' ? take.run.judge.error : undefined;
  return (
    <div className="va-detail" data-testid="va-take-detail" data-take={take.id}>
      <div className="va-detail-bar">
        <div className="va-detail-actions">
          <PlayRecording takeId={take.id} />
          <SettingsButton
            onClick={() => void recalculate()}
            busy={judging || judgeLive}
            busyLabel={judgeLive && take.run.judge?.state === 'queued' ? 'Queued...' : 'Recalculating...'}
            disabled={!!blocker}
            data-testid="va-judge-again"
          >
            Recalculate estimated errors
          </SettingsButton>
          {blocker && (
            <span className="va-detail-note" data-testid="va-judge-reason">
              {`${blocker.text} `}
              <SettingsButton variant="text" onClick={() => (onShowJudge ? onShowJudge() : showEngineRow('judge'))} data-testid="va-judge-fix-detail">{blocker.fix}</SettingsButton>
            </span>
          )}
          {judgeFailed && <span className="va-detail-note" role="alert">{`The judge failed: ${judgeFailed}`}</span>}
        </div>
        <SegmentedControl<string> value={shown} onChange={setPicked} aria-label="Show the text of" options={options} wrap />
      </div>
      <div className="va-detail-pair">
        {engine
          ? <EngineText take={take} engine={engine} retryError={retryError} onRetry={onRetry} />
          : (
            <div className="va-detail-block" data-testid="va-detail-sent">
              <span
                className="va-detail-head"
                data-testid="va-sent-heading"
                title={take.sentSimilarity !== undefined ? `Paired by how alike the texts are (${Math.round(take.sentSimilarity * 100)}% alike), within 15 minutes of the recording; not by the recording itself.` : undefined}
              >
                {take.sentText !== undefined ? sentHeading(take) : 'What you sent'}
              </span>
              {take.sentText !== undefined
                ? <DiffText segments={take.diffs.sent} fallback={take.sentText} testId="va-engine-text" />
                : <p className="va-detail-note" data-testid="va-sent-none">No message you sent was matched to this recording.</p>}
            </div>
          )}
        <div className="va-detail-block">
          <span className="va-detail-head">
            <span>AI&apos;s guess of what you said</span>
            {take.reference && <span className="va-detail-head-quiet" data-testid="va-reference-by">{judgeWords(take.reference.judge)}</span>}
          </span>
          <p className="va-detail-text" data-testid="va-reference">{take.reference?.text ?? 'Not judged yet.'}</p>
        </div>
      </div>
      {take.reference && <DiffLegend />}
      {error && <SettingsNotice kind="error" role="alert">{error}</SettingsNotice>}
    </div>
  );
}
