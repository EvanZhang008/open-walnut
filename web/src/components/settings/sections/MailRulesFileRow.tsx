/**
 * The top of Settings > Mail rules: where the rules file is, and what is wrong with it.
 *
 * The path is the server's own `path.join(dataDir, 'sort-rules.yaml')`, never one the console built,
 * in monospace and selectable, with `Copy path` beside it. A file that does not exist yet says so and
 * offers `Create rules file` (a commented example, `POST /rules/init`); one that exists opens in
 * Walnut's own file viewer, so a person editing it by hand never has to find a dot folder.
 */
import { useEffect, useRef, useState } from 'react';
import type { MailRulesResponse } from '@/api/mail-groups';
import { FileViewer } from '@/components/common/FileViewer';
import { log } from '@/utils/log';
import { SettingsNotice } from '../SettingsSection';
import { SettingsButton } from '../inputs/SettingsButton';
import { InlineConfirmButton } from '../inputs/InlineConfirmButton';
import { COPY, fileErrorSentence, isMissingFileError } from './mail-rules-model';

async function writeClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  try { document.execCommand('copy'); } finally { area.remove(); }
}

function CopyPathButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <SettingsButton
      variant="text"
      reserve={['Copy path', 'Copied']}
      data-testid="mail-rules-copy-path"
      onClick={() => {
        writeClipboard(text).then(
          () => {
            setCopied(true);
            clearTimeout(timer.current);
            timer.current = setTimeout(() => setCopied(false), 1500);
          },
          (error: unknown) => log.warn('settings', 'copy of the rules path failed', { error: String(error) }),
        );
      }}
    >
      {copied ? 'Copied' : 'Copy path'}
    </SettingsButton>
  );
}

export interface MailRulesFileRowProps {
  rules: MailRulesResponse;
  busy: string | null;
  onCreate: () => void;
  onReload: () => void;
  onRestore: () => void;
  onBuiltinOnly: () => void;
}

export function MailRulesFileRow({ rules, busy, onCreate, onReload, onRestore, onBuiltinOnly }: MailRulesFileRowProps) {
  const [viewing, setViewing] = useState(false);
  const missing = isMissingFileError(rules.error);
  return (
    <div className="mail-rules-file" data-testid="mail-rules-file">
      <div className="mail-rules-file-line">
        <span className="mail-rules-file-label">Rules file</span>
        <code className="mail-rules-file-path" data-testid="mail-rules-path">{rules.path}</code>
        <span className="mail-rules-file-actions">
          <CopyPathButton text={rules.path} />
          {rules.exists && (
            <SettingsButton variant="text" data-testid="mail-rules-open" onClick={() => setViewing(true)}>
              Open in Walnut
            </SettingsButton>
          )}
        </span>
      </div>
      {!rules.exists && !missing && (
        <div className="mail-rules-file-line mail-rules-file-missing">
          <span className="mail-rules-help">{COPY.noFile}</span>
          <SettingsButton data-testid="mail-rules-create" busy={busy === 'create'} busyLabel="Creating…" onClick={onCreate}>
            Create rules file
          </SettingsButton>
        </div>
      )}
      <p className="mail-rules-help">{COPY.commentsNote}</p>
      {rules.error && (
        <div className="mail-rules-file-error" data-testid="mail-rules-file-error" role="alert">
          <SettingsNotice kind="error">{fileErrorSentence(rules.error)}</SettingsNotice>
          <div className="mail-rules-file-error-actions">
            {missing ? (
              <>
                <SettingsButton data-testid="mail-rules-restore" busy={busy === 'restore'} busyLabel="Restoring…" onClick={onRestore}>
                  Restore from backup
                </SettingsButton>
                <InlineConfirmButton
                  variant="danger"
                  label="Start with built-in rules only"
                  confirmLabel="Remove my rules?"
                  data-testid="mail-rules-builtin-only"
                  onConfirm={onBuiltinOnly}
                />
              </>
            ) : (
              <>
                <span className="mail-rules-help">{COPY.fixFirst}</span>
                <SettingsButton data-testid="mail-rules-reload" busy={busy === 'reload'} busyLabel="Reloading…" onClick={onReload}>
                  Reload
                </SettingsButton>
              </>
            )}
          </div>
        </div>
      )}
      {viewing && <FileViewer path={rules.path} onClose={() => { setViewing(false); onReload(); }} />}
    </div>
  );
}
