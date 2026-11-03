/**
 * "How to update": this copy of Walnut cannot install a release by itself (a
 * root-owned npm prefix or file, a Homebrew keg), so the update notice shows
 * the exact command that updates it, with Copy. The app's own dialog
 * (ConfirmDialog: portalled, Esc closes, scroll lock), in its alert form.
 */
import { useState } from 'react';
import { copyTextRobust } from '@/utils/clipboard';
import { ConfirmDialog } from './ConfirmDialog';

export interface UpdateCommand { note: string | null; command: string }

function CommandRow({ cmd, index }: { cmd: UpdateCommand; index: number }) {
  const [copied, setCopied] = useState<'yes' | 'failed' | null>(null);
  const copy = () => {
    void copyTextRobust(cmd.command).then((r) => {
      setCopied(r === 'failed' ? 'failed' : 'yes');
      window.setTimeout(() => setCopied(null), 2000);
    });
  };
  return (
    <div className="how-to-update-row">
      {cmd.note && <p className="how-to-update-note">{cmd.note}</p>}
      <span className="setup-copy-wrap how-to-update-command">
        <code className="setup-command" data-testid={`how-to-update-command-${index}`}>{cmd.command}</code>
        <button type="button" className="setup-copy-btn ab-copy-btn" onClick={copy} data-testid={`how-to-update-copy-${index}`}
          aria-label="Copy command" title="Copy command">
          {copied === 'yes' ? 'Copied' : copied === 'failed' ? 'Select and copy' : 'Copy'}
        </button>
      </span>
    </div>
  );
}

export function HowToUpdateDialog({ version, commands, packageUrl, onClose }: {
  version: string | null;
  commands: UpdateCommand[];
  packageUrl: string | null;
  onClose: () => void;
}) {
  return <ConfirmDialog
    title={version ? `Update Walnut to ${version}` : 'Update Walnut'}
    confirmLabel="Done"
    onConfirm={onClose}
    onCancel={onClose}
    message={<div className="how-to-update" data-testid="how-to-update">
      <p>This copy of Walnut cannot update itself. Run this in a terminal, then restart Walnut:</p>
      {commands.length
        ? commands.map((cmd, i) => <CommandRow key={cmd.command} cmd={cmd} index={i} />)
        : <p>No package manager was found for this install{packageUrl ? <>; see <a href={packageUrl} target="_blank" rel="noreferrer">{packageUrl}</a></> : null}.</p>}
    </div>}
  />;
}
