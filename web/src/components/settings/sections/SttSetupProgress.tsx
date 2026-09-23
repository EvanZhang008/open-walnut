/**
 * SSE-based setup progress component.
 * Runs a sequence of setup steps (brew install / model download),
 * showing live progress for each.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { startSetup, type SetupEvent } from '@/api/stt';
import { SettingsRow, SettingsTag } from '../SettingsSection';
import { SettingsButton } from '../inputs/SettingsButton';

interface SetupStep {
  action: string;
  params: Record<string, string>;
  label: string;
}

interface Props {
  steps: SetupStep[];
  onComplete: () => void;
  onCancel: () => void;
}

interface StepState {
  label: string;
  status: 'pending' | 'running' | 'done' | 'error';
  percent: number;
  message: string;
  logs: string[];
}

export function SttSetupProgress({ steps, onComplete, onCancel }: Props) {
  const [stepStates, setStepStates] = useState<StepState[]>(
    steps.map(s => ({ label: s.label, status: 'pending', percent: 0, message: '', logs: [] }))
  );
  const [currentIdx, setCurrentIdx] = useState(0);
  const [finished, setFinished] = useState(false);
  const [failed, setFailed] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const runningRef = useRef(false);

  const updateStep = useCallback((idx: number, update: Partial<StepState>) => {
    setStepStates(prev => prev.map((s, i) => i === idx ? { ...s, ...update } : s));
  }, []);

  useEffect(() => {
    if (runningRef.current) return;
    runningRef.current = true;

    const runSteps = async () => {
      for (let i = 0; i < steps.length; i++) {
        setCurrentIdx(i);
        updateStep(i, { status: 'running', percent: 0, message: 'Starting...' });

        const controller = new AbortController();
        abortRef.current = controller;

        let stepFailed = false;

        await startSetup(
          steps[i].action,
          steps[i].params,
          (event: SetupEvent) => {
            if (event.type === 'progress') {
              updateStep(i, {
                percent: event.percent ?? 0,
                message: event.message ?? '',
              });
            } else if (event.type === 'log') {
              setStepStates(prev => prev.map((s, idx) =>
                idx === i ? { ...s, logs: [...s.logs, event.message ?? ''] } : s
              ));
            } else if (event.type === 'done') {
              updateStep(i, { status: 'done', percent: 100, message: event.message ?? 'Done' });
            } else if (event.type === 'error') {
              updateStep(i, { status: 'error', message: event.message ?? 'Failed' });
              stepFailed = true;
            }
          },
          controller.signal,
        );

        abortRef.current = null;

        if (stepFailed) {
          setFailed(true);
          return;
        }

        // Ensure step is marked done if SSE didn't send explicit done event
        setStepStates(prev => {
          const s = prev[i];
          if (s.status === 'running') {
            return prev.map((st, idx) => idx === i ? { ...st, status: 'done', percent: 100 } : st);
          }
          return prev;
        });
      }

      setFinished(true);
    };

    runSteps();

    return () => {
      abortRef.current?.abort();
    };
  }, []); // Run once on mount

  const handleCancel = () => {
    abortRef.current?.abort();
    onCancel();
  };

  return (
    <div className="stt-setup-progress settings-rows-contents">
      {stepStates.map((step, i) => (
        <SettingsRow
          key={i}
          indent
          className={`stt-setup-step stt-step-${step.status}`}
          label={step.label}
          help={step.message && step.status !== 'pending' ? step.message : undefined}
          state={step.status === 'error' ? 'warning' : undefined}
          control={
            step.status === 'running' ? (
              <span className="settings-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={step.percent}>
                <span className="settings-progress-track stt-progress-bar-track">
                  <span className="settings-progress-fill stt-progress-bar-fill" style={{ width: `${step.percent}%` }} />
                </span>
                <span className="settings-progress-pct">{step.percent}%</span>
              </span>
            ) : (
              <SettingsTag tone={step.status === 'done' ? 'success' : step.status === 'error' ? 'warning' : 'neutral'}>
                {STEP_TAG[step.status]}
              </SettingsTag>
            )
          }
        />
      ))}
      <SettingsRow
        indent
        className="stt-setup-actions"
        label={finished ? 'Setup finished' : failed ? 'Setup stopped' : 'Setting up'}
        control={
          <span className="settings-control-cluster">
            {finished && <SettingsButton variant="primary" onClick={onComplete}>Done, apply config</SettingsButton>}
            {failed && <SettingsButton onClick={onComplete}>Retry</SettingsButton>}
            {!finished && <SettingsButton onClick={handleCancel}>Cancel</SettingsButton>}
          </span>
        }
      />
    </div>
  );
}

const STEP_TAG: Record<string, string> = {
  done: 'Done',
  error: 'Failed',
  running: 'Running',
  pending: 'Waiting',
};
