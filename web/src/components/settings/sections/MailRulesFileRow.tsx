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

/**
 * Loaded on the first `Open in Walnut`: the viewer brings the whole file explorer and the
 * markdown renderer, which the Settings registry (and every module that imports it) must not
 * load up front. State, not React.lazy, so a chunk a deploy replaced fails here, not the page.
 */
type FileViewerComponent = typeof import('@/components/common/FileViewer')['FileViewer'];

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
  const [Viewer, setViewer] = useState<FileViewerComponent | null>(null);
  const [opening, setOpening] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);
  const missing = isMissingFileError(rules.error);
  const open = () => {
    if (Viewer) { setViewing(true); return; }
    setOpening(true);
    setOpenFailed(false);
    import('@/components/common/FileViewer')
      .then((m) => { setViewer(() => m.FileViewer); setViewing(true); })
      .catch((error: unknown) => {
        log.warn('settings', 'the file viewer failed to load for the rules file', { error: String(error) });
        setOpenFailed(true);
      })
      .finally(() => setOpening(false));
  };
  return (
    <div className="mail-rules-file" data-testid="mail-rules-file">
      <div className="mail-rules-file-line">
        <span className="mail-rules-file-label">Rules file</span>
        <code className="mail-rules-file-path" data-testid="mail-rules-path">{rules.path}</code>
        <span className="mail-rules-file-actions">
          <CopyPathButton text={rules.path} />
          {rules.exists && (
            <SettingsButton variant="text" data-testid="mail-rules-open" busy={opening} busyLabel="Opening…" onClick={open}>
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
      {openFailed && (
        <SettingsNotice kind="error">Walnut could not load its file viewer. Reload the page and try again.</SettingsNotice>
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
      {viewing && Viewer && <Viewer path={rules.path} onClose={() => { setViewing(false); onReload(); }} />}
    </div>
  );
}
