/**
 * The in-place walkthrough for an SSH host Walnut cannot sign in to or set up (first-run-model's
 * walkthroughOf): a lead sentence and numbered steps, each command with Copy. One component for
 * the first-run dialog and Settings › Remote Hosts, so both say the same (2026-11-11 review:
 * Settings showed only "Could not connect" where the dialog walked the person through).
 */
import { useEffect, useState } from 'react';
import { copyTextRobust } from '@/utils/clipboard';
import { fetchSshKey } from '@/api/first-run';
import type { SshKey, Walkthrough } from '@/components/first-run/first-run-model';
import '@/styles/ssh-walkthrough.css';

export function CopyCommand({ command, testId }: { command: string; testId?: string }) {
  const [copied, setCopied] = useState<'yes' | 'failed' | null>(null);
  const copy = () => {
    void copyTextRobust(command).then((r) => {
      setCopied(r === 'failed' ? 'failed' : 'yes');
      window.setTimeout(() => setCopied(null), 2000);
    });
  };
  return (
    <span className="fr-command">
      <code data-testid={testId}>{command}</code>
      <button type="button" tabIndex={0} className="fr-copy" onClick={copy} aria-label={`Copy ${command}`}>
        {copied === 'yes' ? 'Copied' : copied === 'failed' ? 'Select and copy' : 'Copy'}
      </button>
    </span>
  );
}

/** `testIdPrefix`: the commands are `<prefix>-command-<alias>-<i>` (first-run by default). */
export function WalkthroughSteps({ walk, alias, testIdPrefix = 'first-run' }: { walk: Walkthrough; alias: string; testIdPrefix?: string }) {
  return (
    <div className="fr-walk" data-testid={`${testIdPrefix}-walk-${alias}`}>
      <div className="fr-walk-lead">{walk.lead}</div>
      {walk.steps.length > 0 && <ol className="fr-walk-steps">
        {walk.steps.map((s, i) => (
          <li key={i}>
            <span>{s.text}</span>
            {s.command && <CopyCommand command={s.command} testId={`${testIdPrefix}-command-${alias}-${i}`} />}
          </li>
        ))}
      </ol>}
    </div>
  );
}

/** The key ssh signs in to a host with, read once while a sign-in walkthrough shows (null: unknown). */
export function useSshKey(alias: string, wanted: boolean): SshKey | null {
  const [key, setKey] = useState<SshKey | null>(null);
  useEffect(() => {
    if (!wanted) return;
    let live = true;
    fetchSshKey(alias).then((k) => { if (live) setKey(k); }).catch(() => {});
    return () => { live = false; };
  }, [alias, wanted]);
  return key;
}
