/**
 * "Edit name and avatar…" from an Org row's right-click. One dialog: the name (a VP's own name,
 * or the task's title), and the avatar three ways:
 *
 *   Presets      the org's characters; pick one, then its colour. A dot marks a pair another node
 *                wears already (it can still be picked).
 *   Ask AI       a line of what to draw; the user's own model draws three (POST /org/avatars/draw)
 *                and one is picked.
 *   Upload       a PNG, JPEG, WebP, GIF or SVG; a picture is cut square and made 128 px here.
 *
 * Save writes the name, then the avatar (PUT /org/avatars/:taskId); Reset to default clears the
 * avatar. An agent does the same with org_avatar_set, so asking the node in its chat works too.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AVATAR_CHARACTERS, AVATAR_COLORS, parsePreset, presetId, presetSvg, svgDataUri } from '@open-walnut/org-avatars';
import { ModalOverlayOwner, useModalOverlay } from '@/hooks/useModalOverlay';
import { usePageView } from '@/utils/view-memory';
import { useDraft } from '@/hooks/useDraft';
import { draftKey } from '@/utils/drafts';
import { drawOrgAvatars, setOrgAvatar, type OrgAvatarSet } from '@/api/org';
import { log } from '@/utils/log';
import { MicInput, type BoxMicHandle } from '@/components/common/BoxMic';
import { useSendAfterDictation, dictationWaitProps } from '@/hooks/useSendAfterDictation';
import { useOrgAvatars } from './useOrgAvatars';
import { useStoreTask } from '@/contexts/TasksContext';
import { avatarFileValue } from './avatar-upload';
import { Tabs } from '@/components/controls';
import '@/styles/org-avatar-dialog.css';

type Tab = 'presets' | 'ai' | 'upload';
const TABS: ReadonlyArray<[Tab, string]> = [['presets', 'Presets'], ['ai', 'Ask AI to draw'], ['upload', 'Upload']];
const isTab = (v: unknown): v is Tab => v === 'presets' || v === 'ai' || v === 'upload';

/** How a node's name is changed here: a VP's name, a task's title, or not here. */
export type RenameKind = 'vp' | 'title' | null;

export interface AvatarDialogTarget {
  taskId: string;
  name: string;
  /** The CEO, which keeps its name. */
  main: boolean;
  /** The ids of the org's other nodes, for the "worn already" dots. */
  others: readonly string[];
}

interface Props {
  target: AvatarDialogTarget;
  onRename: (name: string, kind: RenameKind) => Promise<void>;
  onClose: () => void;
}

export function OrgAvatarDialog({ target, onRename, onClose }: Props) {
  const modalOwner = useModalOverlay(onClose);
  const task = useStoreTask(target.taskId);
  // A VP has a name of its own; a router or a project's one task is named by its title (unless
  // its router settings named it); the CEO keeps its name.
  const renameKind: RenameKind = target.main ? null : task?.org_role === 'lead' ? 'vp' : task?.org_name ? null : 'title';
  const avatars = useOrgAvatars();
  const current = avatars.of(target.taskId, target.name);
  const [tab, setTab] = usePageView<Tab>('org', 'avatar-dialog-tab', 'presets', isTab);
  const [name, setName] = useState(target.name);
  /** What Save will set: null = leave the avatar as it is. */
  const [picked, setPicked] = useState<OrgAvatarSet | null>(null);
  const [character, setCharacter] = useState(() => parsePreset(current.preset ?? '')?.character.id ?? AVATAR_CHARACTERS[0]!.id);
  // What to draw is kept per node until it is saved, like any typed words.
  const promptDraft = useDraft(draftKey('org-avatar-prompt', target.taskId));
  const prompt = promptDraft.text;
  const setPrompt = promptDraft.setText;
  const [drawn, setDrawn] = useState<string[]>([]);
  const [drawing, setDrawing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const drawAbort = useRef<AbortController | null>(null);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    box.current?.focus({ preventScroll: true });
    return () => { drawAbort.current?.abort(); if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  }, []);

  const worn = useMemo(() => new Set(target.others.filter((id) => id !== target.taskId).map((id) => avatars.of(id, '').preset).filter(Boolean) as string[]), [avatars, target]);
  const shown = picked ? pickedSrc(picked) : current.src;

  const draw = async () => {
    drawAbort.current?.abort();
    const ac = new AbortController();
    drawAbort.current = ac;
    setDrawing(true); setError(''); setDrawn([]);
    try {
      const svgs = await drawOrgAvatars({ prompt: prompt.trim() || undefined, name: name.trim() || target.name, taskId: target.taskId }, ac.signal);
      if (ac.signal.aborted) return;
      setDrawn(svgs);
      if (svgs[0]) setPicked({ svg: svgs[0] });
    } catch (err) {
      if (!ac.signal.aborted) setError(err instanceof Error ? err.message : 'The AI could not draw one.');
    } finally {
      if (!ac.signal.aborted) setDrawing(false);
    }
  };

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setError('');
    try { setPicked(await avatarFileValue(file)); } catch (err) { setError(err instanceof Error ? err.message : 'That file could not be used.'); }
  };

  // A task's title is never blank (a VP's blank name gives it back its project's).
  const blankTitle = renameKind === 'title' && !name.trim();
  const save = async (value: OrgAvatarSet | null) => {
    if (blankTitle && !(value && 'reset' in value)) { setError('A task needs a title.'); return; }
    setBusy(true); setError('');
    try {
      const nextName = name.trim();
      // The picture first: when the server refuses it, nothing (not the name either) has changed.
      if (value) await setOrgAvatar(target.taskId, value);
      if (renameKind && nextName !== target.name.trim()) await onRename(nextName, renameKind);
      promptDraft.clear();
      log.info('org', 'avatar dialog saved', { taskId: target.taskId, renamed: nextName !== target.name.trim(), avatar: value ? Object.keys(value)[0] : 'unchanged' });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Not saved.');
      setBusy(false);
    }
  };

  // Save, Reset and Draw take the words of their box once its mic has written them in.
  const nameMic = useRef<BoxMicHandle | null>(null);
  const promptMic = useRef<BoxMicHandle | null>(null);
  const saving = useRef<OrgAvatarSet | null>(null);
  const saveGate = useSendAfterDictation([nameMic], () => void save(saving.current), target.taskId);
  const saveAs = (value: OrgAvatarSet | null) => { saving.current = value; saveGate.send(); };
  const drawGate = useSendAfterDictation([promptMic], () => void draw(), target.taskId);

  const titleId = `org-avatar-title-${target.taskId}`;
  return createPortal(
    <ModalOverlayOwner.Provider value={modalOwner}>
      <div className="app-modal-overlay org-avatar-overlay" onMouseDown={onClose}>
        <div className="app-modal org-avatar-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} data-testid="org-avatar-dialog"
          ref={box} tabIndex={-1} onMouseDown={(e) => e.stopPropagation()}>
          <header className="org-avatar-head">
            <h2 id={titleId}>Edit {target.name}</h2>
            <button type="button" className="org-avatar-close" aria-label="Close" onClick={onClose}>×</button>
          </header>
          <div className="org-avatar-who">
            <img className="org-avatar-now" src={shown} width={64} height={64} alt="" data-testid="org-avatar-current" />
            <label className="org-avatar-name">
              <span>Name</span>
              <MicInput value={name} setText={setName} disabled={!renameKind} maxLength={renameKind === 'vp' ? 60 : 200} fieldClassName="mic-field-compact"
                data-testid="org-avatar-name" data-no-draft="rename" micRef={nameMic} onEnter={() => saveAs(picked)} />
              <small>{renameKind === 'vp' ? 'Blank gives it its project’s name.' : renameKind ? 'The task’s title.' : 'The CEO keeps its name.'}</small>
            </label>
          </div>
          <Tabs className="org-avatar-tabs" aria-label="Pick the picture from" value={tab} onChange={setTab}
            items={TABS.map(([id, label]) => ({ value: id, label, testId: `org-avatar-tab-${id}` }))} />
          <div className="org-avatar-body">
            {tab === 'presets' && (<>
              <div className="org-avatar-grid" data-testid="org-avatar-characters">
                {AVATAR_CHARACTERS.map((c) => {
                  const id = presetId(c.id, c.color);
                  return (
                    <button key={c.id} type="button" title={c.label} aria-label={c.label} aria-pressed={character === c.id}
                      className={`org-avatar-cell${character === c.id ? ' is-on' : ''}`} data-testid="org-avatar-character" data-character={c.id}
                      onClick={() => { setCharacter(c.id); setPicked({ preset: id }); }}>
                      <img src={svgDataUri(presetSvg(id)!)} width={48} height={48} alt="" />
                    </button>
                  );
                })}
              </div>
              <div className="org-avatar-colors" data-testid="org-avatar-colors" aria-label="Colour">
                {AVATAR_COLORS.map((col, i) => {
                  const id = presetId(character, i);
                  const on = 'preset' in (picked ?? {}) ? (picked as { preset: string }).preset === id : current.preset === id && !picked;
                  return (
                    <button key={i} type="button" className={`org-avatar-swatch${on ? ' is-on' : ''}${worn.has(id) ? ' is-worn' : ''}`}
                      style={{ background: col.body }} aria-label={`Colour ${i + 1}${worn.has(id) ? ' (worn by another node)' : ''}`}
                      data-testid="org-avatar-color" data-preset={id} onClick={() => setPicked({ preset: id })} />
                  );
                })}
              </div>
              <p className="org-avatar-note">A grey dot: another node wears that one already.</p>
            </>)}
            {tab === 'ai' && (<>
              <div className="org-avatar-ask">
                <MicInput value={prompt} setText={setPrompt} placeholder={`What should ${target.name} look like? (blank: one that fits its name)`} fieldClassName="mic-field-compact mic-field-grow"
                  maxLength={400} data-testid="org-avatar-prompt" data-draft-key={promptDraft.key ?? undefined} micRef={promptMic} onEnter={() => { if (!drawing) drawGate.send(); }} />
                <button type="button" className="btn btn-primary" disabled={drawing} data-testid="org-avatar-draw" onClick={() => drawGate.send()} {...dictationWaitProps(drawGate)}>{drawing ? 'Drawing…' : drawn.length ? 'Draw again' : 'Draw'}</button>
              </div>
              {drawing && <p className="org-avatar-note" data-testid="org-avatar-drawing">Your AI is drawing three; this takes up to a minute.</p>}
              {drawn.length > 0 && (
                <div className="org-avatar-drawn" data-testid="org-avatar-drawn">
                  {drawn.map((svg, i) => {
                    const on = !!picked && 'svg' in picked && picked.svg === svg;
                    return (
                      <button key={i} type="button" className={`org-avatar-cell is-big${on ? ' is-on' : ''}`} aria-pressed={on} aria-label={`Drawing ${i + 1}`}
                        data-testid="org-avatar-drawn-pick" onClick={() => setPicked({ svg })}>
                        <img src={svgDataUri(svg)} width={72} height={72} alt="" />
                      </button>
                    );
                  })}
                </div>
              )}
            </>)}
            {tab === 'upload' && (
              <label className="org-avatar-drop" data-testid="org-avatar-drop"
                onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); void upload(e.dataTransfer.files[0]); }}>
                <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" data-testid="org-avatar-file" onChange={(e) => void upload(e.target.files?.[0])} />
                <span>Drop a PNG, JPEG, WebP or SVG here, or <u>choose a file</u>.</span>
                <small>A picture is cut square and made 128 px.</small>
              </label>
            )}
            {error && <p className="org-avatar-error" role="alert" data-testid="org-avatar-error">{error}</p>}
          </div>
          <footer className="org-avatar-foot">
            <button type="button" className="btn" disabled={busy || !current.custom} data-testid="org-avatar-reset" onClick={() => saveAs({ reset: true })}>Reset to default</button>
            <span className="org-avatar-gap" />
            <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
            <button type="button" className="btn btn-primary" disabled={busy || ((blankTitle || (!picked && name.trim() === target.name.trim())) && !saveGate.micBusy && !saveGate.waiting)} data-testid="org-avatar-save" onClick={() => saveAs(picked)} {...dictationWaitProps(saveGate)}>{busy ? 'Saving…' : 'Save'}</button>
          </footer>
        </div>
      </div>
    </ModalOverlayOwner.Provider>,
    document.body,
  );
}

function pickedSrc(v: OrgAvatarSet): string {
  if ('preset' in v) return svgDataUri(presetSvg(v.preset) ?? '');
  if ('svg' in v) return svgDataUri(v.svg);
  if ('image' in v) return v.image;
  return '';
}
