/**
 * Settings › Diagnostics › Voice Accuracy (experiment `stt_compare`): the user's
 * own recordings heard again by other speech-to-text engines, an AI judge's
 * guess of what was said (it reads the transcripts, it never listens), and each
 * engine's estimated errors against that guess. Groups: the estimated errors per
 * engine, the engines (state, switch, consent), the run (the pane's one main
 * action), and the recordings. Server: src/web/routes/stt-compare.ts.
 */
import { useState } from 'react';
import type { CompareEngines, CompareEngineRow, CompareProgress, CompareSummary } from '@/api/stt-compare';
import { SettingsGroup, SettingsLoadingRow, SettingsNotice, SettingsRow } from '../SettingsSection';
import { SectionCard } from '../inputs/SectionCard';
import { InlineConfirmButton } from '../inputs/InlineConfirmButton';
import { SettingsButton } from '../inputs/SettingsButton';
import { ToggleSwitch } from '../inputs/ToggleSwitch';
import { VoiceAccuracyEngines, showEngineRow } from './VoiceAccuracyEngines';
import { LowestTag, VoiceAccuracyTakes } from './VoiceAccuracyTakes';
import { useVoiceAccuracy } from './useVoiceAccuracy';
import { RUN_LAST, engineName, judgeBlocker, lastRunWords, pct, runButtonWords, runPlan, runPlanWords, summaryMetrics, summaryModel } from './voice-accuracy-model';
import '@/styles/settings-sections-addons.css';
import '@/styles/settings-sections-configure.css';
import '@/styles/voice-accuracy.css';
import { EmptyState } from '@/components/common/EmptyState';

export const VOICE_ACCURACY_BLURB =
  "Your saved dictations, heard again by other engines and compared. An AI reads each engine's direct transcript (it doesn't listen) and guesses what you said; " +
  'error rates are estimated against that guess, not against text a person checked.';

/** What runs now (the progress line). */
function labelOf(engines: CompareEngines | null, id: string): string {
  return engines?.engines.find((e) => e.id === id)?.label ?? id;
}

/** The engine's own name, without the model in use now (the summary names the recorded one). */
function nameOf(engines: CompareEngines | null, id: string): string {
  const row = engines?.engines.find((e) => e.id === id);
  return row ? engineName(row) : id;
}

/** Shown beside the judge's line while it cannot run: what still happens to the scores. */
export const JUDGE_OFF_HELP =
  'No new AI guesses until it runs. Scores still use the earlier guesses: a recording that has one is scored against it, also for engine texts that arrive later; a recording without one gets no estimated errors.';

const recordings = (n: number) => `${n} recording${n === 1 ? '' : 's'}`;

/** Why the AI judge does not run now, with the way to its setting; none while it runs. */
function JudgeLine({ judge }: { judge: CompareSummary['judge'] }) {
  const blocker = judgeBlocker(judge);
  if (!blocker) return null;
  return (
    <SettingsRow
      label={blocker.text}
      help={JUDGE_OFF_HELP}
      data-testid="va-judge-off"
      data-judge={judge.state}
      control={<SettingsButton variant="text" onClick={() => showEngineRow('judge')} data-testid="va-judge-fix">{blocker.fix}</SettingsButton>}
    />
  );
}

function SummaryGroup({ summary, engines }: { summary: CompareSummary; engines: CompareEngines | null }) {
  const after = (id: string) => !!engines?.engines.find((e) => e.id === id)?.after;
  const shared = summary.sharedTakes;
  const comparable = summary.engines.length > 0 && shared > 0;
  return (
    <div data-testid="va-summary" data-layout="rows">
      <SettingsGroup
        heading="Estimated errors"
        description={comparable
          ? `Counted against earlier AI guesses of what you said, on the same ${recordings(shared)}. The AI reads the engines' transcripts only (it doesn't listen), and no person checked its guesses.`
          : "Counted against an AI's guess of what you said. The AI reads the engines' transcripts only (it doesn't listen), and no person checks its guesses."}
      >
        <JudgeLine judge={summary.judge} />
        {summary.engines.length === 0 && (
          <EmptyState
            size="row"
            title="No estimated errors yet"
            hint={summary.judge.state === 'ready'
              ? `Run a comparison below: Walnut hears up to ${RUN_LAST} recordings again and the AI judge estimates each engine's errors.`
              : 'They need the AI judge, which reads the engines\' transcripts and guesses what you said.'}
            testId="va-summary-empty"
          />
        )}
        {summary.engines.length > 0 && shared === 0 && (
          <SettingsRow
            label="Can't compare the engines yet."
            help="No recording has estimated errors from every engine shown, so there is nothing to put side by side."
            data-testid="va-summary-none-shared"
          />
        )}
        {comparable && summary.engines.map((row) => {
          const model = summaryModel(row);
          const metrics = summaryMetrics(row, after(row.id));
          const lowest = summary.best === row.id;
          return (
            <SettingsRow
              key={row.id}
              label={(
                <span className="va-summary-label">
                  <span>
                    {nameOf(engines, row.id)}
                    <span className="va-summary-model" data-testid="va-summary-model">{` · ${model.words}`}</span>
                  </span>
                  {model.mixed && <span className="badge badge-important" title={model.words}>Mixed models</span>}
                </span>
              )}
              help={(
                <span className="va-metrics">
                  {metrics.map((m) => (
                    <span key={m.label} className="va-metric"><span className="va-metric-label">{m.label}</span> {m.value}</span>
                  ))}
                </span>
              )}
              data-testid="va-summary-row"
              data-engine={row.id}
              control={(
                <span className="va-rate" data-marked={lowest ? 'true' : undefined}>
                  <span className="settings-visually-hidden">Estimated errors </span>
                  {pct(row.mixed)}
                  {lowest && <LowestTag />}
                </span>
              )}
            />
          );
        })}
      </SettingsGroup>
    </div>
  );
}

function progressLine(p: CompareProgress, engines: CompareEngines | null): string {
  const step = p.total > 0 ? `${Math.min(p.done + 1, p.total)} of ${p.total}` : 'Starting';
  const what = !p.engine ? '' : p.engine === 'judge' ? 'the AI judge' : engines?.engines.some((e) => e.id === p.engine) ? labelOf(engines, p.engine) : p.engine;
  return `Comparing: ${step}${what ? ` · ${what}` : ''}${p.queued > 0 ? ` · ${p.queued} more queued` : ''}`;
}

/** The first engine whose row says why it cannot run (the run's "nothing can run" link). */
function firstBlocked(engines: ReadonlyArray<CompareEngineRow>): string | undefined {
  return engines.find((e) => e.kind === 'engine' && e.state !== 'ready')?.id ?? engines.find((e) => e.kind === 'judge')?.id;
}

function RunGroup({ data }: { data: ReturnType<typeof useVoiceAccuracy> }) {
  const { engines, progress, save, run, runError, saveError, pollError } = data;
  const [nightly, setNightly] = useState<boolean | null>(null);
  const running = !!progress && (progress.running || progress.queued > 0);
  const plan = runPlan(engines?.engines ?? []);
  const blocked = plan.kind === 'nothing' ? firstBlocked(engines?.engines ?? []) : undefined;
  const last = running ? null : lastRunWords(progress);
  const flipNightly = async (on: boolean) => {
    setNightly(on);
    await save('nightly', { nightly: on });
    setNightly(null);
  };
  return (
    <SettingsGroup heading="Run" data-testid="va-run-group">
      <SettingsRow
        label={`Compare up to ${RUN_LAST} recordings not compared yet`}
        help={(
          <>
            <span data-testid="va-run-plan" data-plan={plan.kind}>{runPlanWords(plan)}</span>
            {blocked && (
              <>
                {' '}
                <SettingsButton variant="text" onClick={() => showEngineRow(blocked)} data-testid="va-run-fix">See the engines</SettingsButton>
              </>
            )}
          </>
        )}
        error={runError ? `Couldn't start it: ${runError}` : undefined}
        control={(
          <SettingsButton
            variant="primary"
            busy={running}
            busyLabel="Running..."
            holdFocus
            disabled={plan.kind === 'nothing'}
            onClick={() => void run()}
            data-testid="va-run"
          >
            {runButtonWords(plan)}
          </SettingsButton>
        )}
      />
      {running && progress && (
        <SettingsLoadingRow>
          <span className="va-progress" data-testid="va-progress">{progressLine(progress, engines)}</span>
          {pollError && <span className="va-progress" role="status" data-testid="va-poll-error">{` · Couldn't read how far it is (${pollError}); trying again`}</span>}
        </SettingsLoadingRow>
      )}
      {last && <SettingsNotice kind="info" role="status"><span data-testid="va-last-run">{last}</span></SettingsNotice>}
      {!running && progress?.finishedAt && progress.lastError && (
        <SettingsNotice kind="warn">{`The last run had a failure: ${progress.lastError}`}</SettingsNotice>
      )}
      <SettingsRow
        label="Compare automatically every night"
        htmlFor="va-nightly"
        help="At 3:00 on this computer's clock, the recordings of the last 24 hours, following each upload choice above."
        error={saveError?.row === 'nightly' ? `Couldn't save: ${saveError.text}` : undefined}
        control={<ToggleSwitch id="va-nightly" checked={nightly ?? engines?.nightly ?? false} onChange={(v) => void flipNightly(v)} data-testid="va-nightly" />}
      />
    </SettingsGroup>
  );
}

/** A read that failed: what went wrong and the way to read it again (never a spinner left running). */
function LoadError({ error, reload }: { error: string; reload: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const again = async () => {
    setBusy(true);
    try { await reload(); } finally { setBusy(false); }
  };
  return (
    <SettingsNotice
      kind="error"
      role="alert"
      action={<SettingsButton busy={busy} busyLabel="Reading..." onClick={() => void again()} data-testid="va-load-retry">Try again</SettingsButton>}
    >
      {`Couldn't read it: ${error}`}
    </SettingsNotice>
  );
}

/** The limits of what Voice Accuracy keeps (store.ts MAX_TAKES, voice-retention.ts). */
export const DATA_LIMITS =
  'At most 500 compared recordings, on this computer only; past that the oldest comparison is dropped. While the experiment is on, the recordings it compares are kept past your voice retention setting; once it is off, they follow that setting again.';

/** Removes everything Voice Accuracy kept; shown with the experiment off too, so turning it off can leave nothing behind. */
function DeleteGroup({ data }: { data: ReturnType<typeof useVoiceAccuracy> }) {
  const [done, setDone] = useState(false);
  return (
    <SettingsGroup heading="Your data" data-testid="va-data-group">
      <SettingsRow
        label="What is kept"
        help={DATA_LIMITS}
        data-testid="va-data-limits"
      />
      <SettingsRow
        label="Delete comparison data"
        help={done
          ? 'Deleted. Your recordings themselves are kept as before.'
          : "Removes the engines' texts, the estimated errors, the ElevenLabs key and these settings. Your recordings stay."}
        error={data.saveError?.row === 'delete' ? `Couldn't delete it: ${data.saveError.text}` : undefined}
        control={(
          <InlineConfirmButton
            label="Delete"
            confirmLabel="Confirm delete"
            onConfirm={async () => { setDone(await data.deleteData()); }}
            data-testid="va-delete-data"
          />
        )}
      />
    </SettingsGroup>
  );
}

export function VoiceAccuracySection() {
  const data = useVoiceAccuracy();
  const { off, loading, error, engines, summary } = data;
  const columns: CompareEngineRow[] = engines?.engines.filter((e) => e.kind === 'engine') ?? [];
  const judge = engines?.engines.find((e) => e.kind === 'judge');
  return (
    <SectionCard id="voice-accuracy" title="Voice Accuracy" description={VOICE_ACCURACY_BLURB}>
      {off && (
        <SettingsNotice kind="info" role="status">Voice Accuracy is an experiment that is off. Turn it on in Settings › Experimental.</SettingsNotice>
      )}
      {!off && loading && !engines && <SettingsLoadingRow>Reading your compared recordings...</SettingsLoadingRow>}
      {!off && error && <LoadError error={error} reload={data.reload} />}
      {!off && summary && <SummaryGroup summary={summary} engines={engines} />}
      {!off && engines && <VoiceAccuracyEngines engines={engines} saveError={data.saveError} save={data.save} reload={data.reload} />}
      {!off && engines && <RunGroup data={data} />}
      {!off && engines && summary && (
        <VoiceAccuracyTakes
          takes={data.takes}
          total={data.total}
          hasMore={!!data.nextCursor}
          byDay={summary.byDay}
          engines={columns}
          judge={judge}
          onMore={() => void data.more()}
          onRetry={(takeId, engineId) => data.run({ takeIds: [takeId], engines: [engineId] })}
          onJudge={data.judge}
        />
      )}
      {!loading && <DeleteGroup data={data} />}
    </SectionCard>
  );
}
