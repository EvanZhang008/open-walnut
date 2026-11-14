/**
 * The folders a router watches, one field wherever it is set: a router's settings on the Org page
 * and the Mail plugin's page in Apps (2026-11-14, the user: the router is what the Mail plugin
 * provides, so its folders are set there too). Both write the same saved list, the router's own
 * (PATCH /api/v1/org/routers/:id `folders`), and both read it back from GET /api/v1/router/areas,
 * so there is one value and never two copies.
 *
 * Typed as names separated by commas; empty means the plugin's default, the Inbox. A list that
 * leaves the Inbox out warns while it is typed, before anything is saved.
 */
import { useId, type ReactNode } from 'react';
import '@/styles/router-folders.css';

export const ROUTER_FOLDERS_NOTE = 'Folder or label names, separated by commas. Empty: the Inbox.';
export const ROUTER_NO_INBOX_LINE = 'Inbox is not in this list: new Inbox mail of these accounts goes to no one. Add Inbox to keep it.';

/** The typed folder list as the server keeps it: trimmed, no repeats, no blanks. */
export function folderList(text: string): string[] {
  return [...new Set(text.split(',').map((one) => one.trim()).filter(Boolean))];
}

/** Whether a typed folder list leaves the Inbox out (an empty list means the Inbox). */
export function foldersSkipInbox(text: string): boolean {
  const list = folderList(text);
  return list.length > 0 && !list.some((one) => one.toLowerCase() === 'inbox');
}

/** Whether two typed lists save as the same folders. */
export function sameFolders(a: string, b: string): boolean {
  const left = folderList(a);
  const right = folderList(b);
  return left.length === right.length && left.every((one, i) => one === right[i]);
}

interface Props {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  /** The draft the field belongs to (data-draft-key), so a reload keeps what was typed. */
  draftKey?: string | null;
  /** testid prefix: `<prefix>` on the input, `<prefix>-no-inbox` on the warning. */
  testId: string;
  /** The input's id, for the label that names it. */
  inputId?: string;
  /** Said under the field after the format line (where else it is set, what it applies to). */
  note?: ReactNode;
}

export function RouterFoldersField({ value, onChange, disabled, draftKey, testId, note, inputId }: Props) {
  const hintId = useId();
  const skips = foldersSkipInbox(value);
  return (
    <div className="router-folders">
      <input
        id={inputId}
        className="router-folders-input"
        value={value}
        placeholder="Inbox"
        spellCheck={false}
        autoComplete="off"
        aria-describedby={hintId}
        aria-invalid={skips || undefined}
        data-draft-key={draftKey ?? undefined}
        data-testid={testId}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
      <span id={hintId} className="router-folders-hint">{ROUTER_FOLDERS_NOTE}{note ? <> {note}</> : null}</span>
      {skips ? <span className="router-folders-warn" role="status" data-testid={`${testId}-no-inbox`}>{ROUTER_NO_INBOX_LINE}</span> : null}
    </div>
  );
}
