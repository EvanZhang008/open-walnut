import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { createElement } from '../../web/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../web/node_modules/react-dom/server.node.js';
import type { HostStatus } from '../../web/src/api/hosts';
import type { SetupEvent } from '../../web/src/api/stt';
import type { SttSetupJob } from '../../web/src/components/settings/sections/stt-setup-job';

const hostState = vi.hoisted(() => ({ status: undefined as HostStatus | undefined }));
vi.mock('@/hooks/useHostStatus', () => ({ serverNow: () => 1000, useHostStatus: () => hostState.status }));
vi.mock('@/api/stt', () => ({ startSetup: vi.fn() }));

import { HostConnectSteps } from '../../web/src/components/sessions/path-selector/HostConnectSteps';
import { SttSetupProgress } from '../../web/src/components/settings/sections/SttSetupProgress';
import { clearSttSetupJob, getSttSetupJob, startSttSetupJob } from '../../web/src/components/settings/sections/stt-setup-job';
import { stepsFromPhase } from '../../web/src/utils/host-connect';

const noAction = () => {};
const documentOf = (element: Parameters<typeof renderToStaticMarkup>[0]) => parseHTML(renderToStaticMarkup(element)).document;
const jobOf = (percent: number | null, status: 'running' | 'done' | 'error' = 'running'): SttSetupJob => ({
  id: 1, kind: 'setup', engine: 'mlx', steps: [{ action: 'download_mlx_model', params: {}, label: 'Download model' }],
  states: [{ label: 'Download model', status, percent, message: 'Preparing the model' }],
  status: status === 'running' ? 'running' : status === 'done' ? 'done' : 'failed',
});

afterEach(() => { hostState.status = undefined; clearSttSetupJob(); });

describe('host connect stage progress', () => {
  it.each([['queued', 0], ['install-runtime', 2], ['upload', 3], ['connected', 7]])(
    'the phase %s shows %s completed steps, never guessed download bytes', (phase, completed) => {
      hostState.status = {
        host: 'buildbox', label: 'Build box', hostname: 'build.example.com', connected: phase === 'connected',
        phase: phase as HostStatus['phase'], phaseLabel: `Stage: ${phase}`, steps: stepsFromPhase(phase),
        phaseElapsedMs: 0, connectElapsedMs: 0, at: 1000,
      };
      const document = documentOf(createElement(HostConnectSteps, { hostKey: 'buildbox', label: 'Build box' }));
      const bar = document.querySelector('[role="progressbar"]')!;
      expect(document.querySelectorAll('[role="progressbar"]').length).toBe(1);
      expect(Number(bar.getAttribute('aria-valuenow'))).toBeCloseTo(completed / 7 * 100);
      expect(bar.getAttribute('aria-valuetext')).toBe(`${completed} of 7 steps complete`);
      expect(bar.getAttribute('aria-label')).toContain('Connecting to Build box:');
      expect(document.querySelectorAll('[data-status="done"]').length).toBe(completed);
    },
  );

  it('counts the host-reported stages rather than assuming the fallback chain length', () => {
    hostState.status = {
      host: 'buildbox', label: 'Build box', hostname: 'build.example.com', connected: false,
      phase: 'tunnel', phaseLabel: 'Opening tunnel', at: 1000, phaseElapsedMs: 0, connectElapsedMs: 0,
      steps: [{ phase: 'ssh', label: 'SSH', status: 'done' }, { phase: 'tunnel', label: 'Tunnel', status: 'active' }],
    };
    const document = documentOf(createElement(HostConnectSteps, { hostKey: 'buildbox', label: 'Build box' }));
    const bar = document.querySelector('[role="progressbar"]')!;
    expect(bar.getAttribute('aria-valuenow')).toBe('50');
    expect(bar.getAttribute('aria-valuetext')).toBe('1 of 2 steps complete');
    expect(bar.getAttribute('aria-label')).toBe('Connecting to Build box: Opening tunnel');
  });

  it('uses the list-dirs phase before pushed status arrives', () => {
    const document = documentOf(createElement(HostConnectSteps, {
      hostKey: 'buildbox', label: 'Build box', pending: { phase: 'upload', label: 'Uploading daemon', elapsedMs: 3000 },
    }));
    expect(document.querySelector('[role="progressbar"]')?.getAttribute('aria-valuetext')).toBe('3 of 7 steps complete');
    expect(document.querySelector('.setup-progress-label')?.textContent).toBe('Uploading daemon');
  });
});

describe('voice setup progress', () => {
  it.each([null, 0, 42])('a running voice step with percent %s is named and unknown only when unmeasured', (percent) => {
    const document = documentOf(createElement(SttSetupProgress, { job: jobOf(percent), onRetry: noAction, onCancel: noAction }));
    const bar = document.querySelector('[role="progressbar"]')!;
    expect(bar.getAttribute('aria-label')).toBe('Download model');
    expect(bar.getAttribute('aria-valuenow')).toBe(percent === null ? null : String(percent));
    expect(document.querySelector('[data-step-status="running"] .setup-progress')?.getAttribute('data-progress'))
      .toBe(percent === null ? 'unknown' : 'known');
  });

  it.each(['done', 'error'] as const)('a settled %s step has no running bar', (status) => {
    const document = documentOf(createElement(SttSetupProgress, { job: jobOf(100, status), onRetry: noAction, onCancel: noAction }));
    expect(document.querySelector('[role="progressbar"]')).toBeNull();
    expect(document.querySelector('[data-step-status]')?.textContent).toContain(status === 'done' ? 'Done' : 'Failed');
  });

  it('the client job stays unknown until an actual percent arrives, preserves it on heartbeats, and retries unknown', async () => {
    let emit!: (event: SetupEvent) => void;
    let finish!: () => void;
    const runner = vi.fn<NonNullable<Parameters<typeof startSttSetupJob>[1]>>((_action, _params, callback) => {
      emit = callback;
      return new Promise<void>((resolve) => { finish = resolve; });
    });
    const init = { kind: 'model' as const, engine: 'mlx', steps: jobOf(null).steps };
    startSttSetupJob(init, runner);
    expect(getSttSetupJob()?.states[0].percent).toBeNull();
    emit({ type: 'progress', message: 'Downloading model' });
    expect(getSttSetupJob()?.states[0].percent).toBeNull();
    emit({ type: 'progress', percent: 25 });
    emit({ type: 'progress', message: 'Still downloading' });
    expect(getSttSetupJob()?.states[0].percent).toBe(25);
    emit({ type: 'error', message: 'Connection closed' });
    finish();
    await Promise.resolve();
    expect(getSttSetupJob()?.status).toBe('failed');
    startSttSetupJob(init, runner);
    expect(getSttSetupJob()?.states[0].percent).toBeNull();
    emit({ type: 'done', message: 'Downloaded' });
    finish();
    await Promise.resolve();
    expect(getSttSetupJob()?.status).toBe('done');
    expect(getSttSetupJob()?.states[0].percent).toBe(100);
  });
});
