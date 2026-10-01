/**
 * One list in the unsubscribe checklist (spec 10): a real checkbox inside a `<label>` (the whole row
 * toggles), the method in words, the mail count, and while a batch runs, that list's own outcome.
 *
 * A mailto the account cannot send is never tickable: it offers `Copy address` and a plain
 * `mailto:` link for the system mail app, and Walnut sends nothing.
 */
import { useEffect, useRef, useState } from 'react';
import { log } from '@/utils/log';
import { formatCount } from './mail-format';
import { CheckCircleIcon } from './mail-icons';
import {
  mailtoAddress, mailtoFromText, methodText, planItemKind, runStatusText, type PlanItem, type RunStatus,
} from './mail-unsub-plan-model';

export interface PlanRowRun {
  status: RunStatus;
  message?: string;
  url?: string;
}

function CopyAddress({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <button
      type="button"
      className="mail-text-btn"
      data-testid="mail-unsub-copy"
      onClick={() => {
        void navigator.clipboard?.writeText(address).then(() => {
          setCopied(true);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 1500);
        }, (error: unknown) => log.warn('mail', 'copy failed', { error: String(error) }));
      }}
    >
      {copied ? 'Copied' : 'Copy address'}
    </button>
  );
}

export function MailUnsubscribePlanRow({ item, ticked, onTick, disabled, run, fromAddress, onRetry, onFinishWithWalnut }: {
  item: PlanItem;
  ticked: boolean;
  onTick: (next: boolean) => void;
  /** The batch is running or over: nothing can be ticked any more. */
  disabled: boolean;
  run: PlanRowRun | null;
  /** The address a mailto sends from, said out loud (it goes out in the person's name). */
  fromAddress: string;
  onRetry: () => void;
  onFinishWithWalnut: () => void;
}) {
  const kind = planItemKind(item);
  const address = mailtoAddress(item.mailto);
  const tickable = kind === 'checkable';
  return (
    <li
      className="mail-unsub-item"
      data-testid="mail-unsub-item"
      data-method={item.method}
      data-list-key={item.listKey}
      data-kind={kind}
    >
      <label className="mail-unsub-label">
        <input
          type="checkbox"
          data-testid="mail-unsub-check"
          checked={tickable && ticked}
          disabled={!tickable || disabled}
          onChange={(event) => onTick(event.target.checked)}
        />
        <span className="mail-unsub-name" title={item.label}>{item.label}</span>
        <span className="mail-unsub-method" data-testid="mail-unsub-method">{methodText(item)}</span>
        <span className="mail-unsub-mails">{formatCount(item.mails)} {item.mails === 1 ? 'mail' : 'mails'}</span>
      </label>
      {item.method === 'mailto' && item.canSend && fromAddress && (
        <span className="mail-unsub-small" data-testid="mail-unsub-from">{mailtoFromText(fromAddress)}</span>
      )}
      {kind === 'cannot-send' && (
        <span className="mail-unsub-deadend">
          {address && <CopyAddress address={address} />}
          {item.mailto && (
            <a className="mail-text-btn" data-testid="mail-unsub-open-app" href={item.mailto.startsWith('mailto:') ? item.mailto : `mailto:${item.mailto}`}>
              Open in your mail app
            </a>
          )}
        </span>
      )}
      {kind === 'in-flight' && !run && <span className="mail-unsub-run" data-testid="mail-unsub-run">Unsubscribing…</span>}
      {run && (
        <span className="mail-unsub-run" data-testid="mail-unsub-run" data-status={run.status}>
          {run.status === 'done' && <CheckCircleIcon size={13} />}
          {run.status === 'failed' ? (
            <>
              <span>{run.message ?? 'Walnut could not unsubscribe from this list.'}</span>
              <button type="button" className="mail-text-btn" data-testid="mail-unsub-retry" onClick={onRetry}>Try again</button>
            </>
          ) : run.status === 'needs-human' ? (
            run.url ? (
              <a className="mail-text-btn" data-testid="mail-unsub-finish" href={run.url} target="_blank" rel="noopener noreferrer">
                Finish on the page
              </a>
            ) : (
              <button type="button" className="mail-text-btn" data-testid="mail-unsub-finish-walnut" onClick={onFinishWithWalnut}>
                Finish with Walnut
              </button>
            )
          ) : (
            <span>{runStatusText(run.status)}</span>
          )}
        </span>
      )}
    </li>
  );
}
