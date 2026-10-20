/**
 * The Qwen3-ASR row: the server installs the voice model by itself
 * (src/core/stt/auto-setup.ts), so this row only says where that stands. While
 * it installs, the status is read every few seconds for the progress bar.
 */

import { useEffect } from 'react';
import type { QwenSetupStatus } from '@/api/stt';
import { SettingsRow, SettingsTag } from '../SettingsSection';
import { SettingsButton } from '../inputs/SettingsButton';
import { refreshSttStatus } from '@/hooks/useSttStatus';

const POLL_MS = 3_000;

interface Props {
  setup: QwenSetupStatus | null;
  /** The configured engine is qwen and answers. */
  ready: boolean;
  onStart: () => void;
}

export function SttQwenRow({ setup, ready, onStart }: Props) {
  const installing = setup?.state === 'installing';
  useEffect(() => {
    if (!installing) return;
    const timer = setInterval(refreshSttStatus, POLL_MS);
    return () => clearInterval(timer);
  }, [installing]);

  if (ready) {
    return (
      <SettingsRow
        indent
        label="Voice model"
        data-testid="stt-qwen-row"
        data-state="ready"
        help={setup?.runtime ? `Runs on this server (${setup.runtime}).` : 'Runs on this server.'}
        control={<SettingsTag tone="success">Ready</SettingsTag>}
      />
    );
  }
  if (installing) {
    const pct = setup?.percent;
    return (
      <SettingsRow
        indent
        label="Installing the voice model"
        data-testid="stt-qwen-row"
        data-state="installing"
        help={setup?.message ?? 'Downloading in the background. Dictation turns on when it finishes.'}
        control={
          <span className="settings-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined}>
            <span className="settings-progress-track">
              <span className="settings-progress-fill" style={{ width: `${pct ?? 0}%` }} />
            </span>
            <span className="settings-progress-pct">{pct === undefined ? '' : `${pct}%`}</span>
          </span>
        }
      />
    );
  }
  if (setup?.state === 'failed') {
    return (
      <SettingsRow
        indent
        label="The voice model did not install"
        data-testid="stt-qwen-row"
        data-state="failed"
        state="warning"
        help={`${setup.error ?? 'The install stopped.'} Walnut tries again on its own.`}
        control={<SettingsButton variant="primary" data-testid="stt-qwen-retry" onClick={onStart}>Retry now</SettingsButton>}
      />
    );
  }
  return (
    <SettingsRow
      indent
      label="Voice model"
      data-testid="stt-qwen-row"
      data-state={setup?.state ?? 'idle'}
      help="Walnut downloads Qwen3-ASR to this server and turns dictation on."
      control={<SettingsButton variant="primary" data-testid="stt-qwen-start" onClick={onStart}>Install</SettingsButton>}
    />
  );
}
