/**
 * Open in Chrome (2026-11-17, the user: "any time it can jump there"): one click in the task's
 * Browser view brings Chrome to the front on the task's tab, live, idle or in the replay. With no
 * tab left (the agent closed it), the page of the replay step shown (else the last one) opens
 * again in Walnut's agent window and comes forward. The server takes it from a person's click
 * only (POST /api/v1/browser/view/reveal) and reads the address from the task's own replay.
 */
import { useEffect, useState } from 'react';
import { apiPost } from '@/api/client';
import { ApiError } from '@/api/api-error';
import { log } from '@/utils/log';

export function BrowserRevealButton({ taskId, tab, device, step, testId = 'session-browser-reveal' }: {
  taskId: string;
  /** The task's tab now: brought to the front. */
  tab?: number;
  device?: string;
  /** With no tab: the replay step whose page opens again (default the last with an address). */
  step?: string;
  testId?: string;
}) {
  const [phase, setPhase] = useState<'idle' | 'opening' | 'done'>('idle');
  const [trouble, setTrouble] = useState<string | null>(null);
  /** More than one browser and none the task used lately: the person picks one. */
  const [choices, setChoices] = useState<string[]>([]);
  useEffect(() => {
    if (phase !== 'done') return undefined;
    const t = window.setTimeout(() => setPhase('idle'), 2500);
    return () => window.clearTimeout(t);
  }, [phase]);
  const reveal = async (inBrowser?: string) => {
    setPhase('opening');
    setTrouble(null);
    setChoices([]);
    const where = inBrowser ?? device;
    try {
      const out = await apiPost<{ tab?: number; reopened?: boolean }>('/api/v1/browser/view/reveal', {
        task: taskId, ...(tab !== undefined ? { tab } : {}), ...(where ? { device: where } : {}), ...(tab === undefined && step ? { step } : {}),
      });
      log.info('session-panel', 'browser view reveal', { taskId, tab: out?.tab ?? tab, device: where, reopened: out?.reopened === true });
      setPhase('done');
    } catch (err) {
      const body = err instanceof ApiError ? err.body as { code?: string; devices?: unknown } | undefined : undefined;
      const devices = body?.code === 'which_browser' && Array.isArray(body.devices) ? body.devices.filter((x): x is string => typeof x === 'string') : [];
      if (devices.length) setChoices(devices);
      else setTrouble(err instanceof Error ? err.message : String(err));
      setPhase('idle');
    }
  };
  return (
    <>
      <button type="button" className="session-browser-btn" onClick={() => { void reveal(); }} disabled={phase === 'opening'}
        title={tab !== undefined ? 'Bring this tab to the front in Chrome' : 'Open this page again in Chrome and bring it to the front'}
        data-testid={testId}>{phase === 'opening' ? 'Opening…' : phase === 'done' ? 'Opened in Chrome' : 'Open in Chrome'}</button>
      {choices.length > 0 && (
        <span className="session-browser-reveal-choices" data-testid={`${testId}-choices`}>
          Which browser?
          {choices.map((d) => (
            <button key={d} type="button" className="session-browser-btn" onClick={() => { void reveal(d); }}>{d}</button>
          ))}
        </span>
      )}
      {trouble && <span className="session-browser-reveal-trouble" role="alert" data-testid={`${testId}-trouble`}>{trouble}</span>}
    </>
  );
}
