/**
 * "Add a trigger…" from the composer's "+" menu: pick a plugin's ready-made
 * trigger (a Slack channel, new mail) and arm it here, or describe the watch in
 * words and let this session's AI write it (walnut-trigger skill).
 *
 * A dialog, not a menu (it holds inputs), placed like the Engine settings
 * popover: portalled, `useMenuPlacement` against the "+" button, an outside
 * pointerdown or Escape closes it. Its height is capped by the placement and it
 * scrolls itself, so a long template or option list never pushes it off screen.
 */
import { useDraft, useDraftValue } from '@/hooks/useDraft';
import { draftKey } from '@/utils/drafts';
import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import {
  createTemplateTrigger, fetchTriggerTemplateOptions, fetchTriggerTemplates, triggerErrorMessage,
  type CreatedTemplateTrigger, type TriggerTemplate, type TriggerTemplateOption, type TriggerTemplateParam,
} from '@/api/trigger-templates';
import { useMenuPlacement } from '@/hooks/useMenuPlacement';
import { onRoutinesChanged } from '@/stores/routines-store';
import { log } from '@/utils/log';
import {
  EVERY_CHOICES, TRIGGER_IDEAS, describeText, ideaText, missingRequired, templateHandoffText, type TriggerIdea,
} from './trigger-picker-model';
import '@/styles/trigger-picker.css';
import { MicField, type BoxMicHandle } from '@/components/common/BoxMic';

export type TriggerPickerCloseReason = 'escape' | 'close' | 'outside' | 'prefill' | 'anchor-lost';

export interface TriggerPickerPopoverProps {
  sessionId: string;
  taskId: string;
  acp: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  composerRef?: RefObject<HTMLElement | null>;
  onClose: (reason: TriggerPickerCloseReason) => void;
  /** Put text at the start of this session's composer, keeping what the user already typed. */
  onPrefill: (text: string) => void;
}

type Loaded = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; templates: TriggerTemplate[] };

export function TriggerPickerPopover(props: TriggerPickerPopoverProps) {
  const { sessionId, taskId, acp, anchorRef, composerRef, onClose, onPrefill } = props;
  const rootRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const close = useCallback((reason: TriggerPickerCloseReason) => onCloseRef.current(reason), []);
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' });
  const [picked, setPicked] = useState<TriggerTemplate | null>(null);

  const placement = useMenuPlacement(true, anchorRef, rootRef, {
    preferSide: 'up', align: 'start', edgeOverflow: 'clamp', verticalAnchorRef: composerRef, margin: 12, minHeight: 240,
    onAnchorLost: () => close('anchor-lost'),
  });

  const load = useCallback(() => {
    setLoaded({ state: 'loading' });
    fetchTriggerTemplates()
      .then((templates) => setLoaded({ state: 'ready', templates }))
      .catch((err: unknown) => {
        log.warn('trigger', 'trigger templates failed to load', { sessionId, error: triggerErrorMessage(err) });
        setLoaded({ state: 'error', message: triggerErrorMessage(err) });
      });
  }, [sessionId]);
  useEffect(load, [load]);

  const placed = placement !== null;
  useEffect(() => {
    if (placed) rootRef.current?.focus({ preventScroll: true });
  }, [placed]);

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const root = rootRef.current;
      if (!root || root.contains(e.target as Node)) return;
      // At once, not on the next frame: a click on "Add a trigger…" in the "+"
      // menu reopens it in its own click, which a late close would undo.
      close('outside');
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [close]);

  const prefill = useCallback((text: string, what: string) => {
    log.info('trigger', 'trigger picker handed to the AI', { sessionId, taskId, what });
    onPrefill(text);
    close('prefill');
  }, [onPrefill, close, sessionId, taskId]);

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    if (picked) { setPicked(null); rootRef.current?.focus({ preventScroll: true }); return; }
    const anchor = anchorRef.current;
    close('escape');
    anchor?.focus({ preventScroll: true });
  };

  return createPortal(
    <div
      ref={rootRef}
      className="trigger-picker"
      role="dialog"
      aria-label="Add a trigger"
      tabIndex={-1}
      data-testid="trigger-picker"
      data-view={picked ? 'form' : 'list'}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={onKeyDown}
      style={{
        top: placement?.top,
        right: placement?.right,
        visibility: placement ? undefined : 'hidden',
        ['--menu-max-height' as string]: placement ? `${placement.maxHeight}px` : undefined,
      } as CSSProperties}
    >
      <header className="trigger-picker-header">
        {picked ? (
          <button type="button" className="trigger-picker-back" aria-label="Back to all triggers" onClick={() => setPicked(null)}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M10 3L5 8l5 5" />
            </svg>
          </button>
        ) : null}
        <h2 className="trigger-picker-title">{picked ? `${picked.pluginName}: ${picked.title}` : 'Add a trigger'}</h2>
        <button type="button" className="trigger-picker-close" aria-label="Close" onClick={() => { const a = anchorRef.current; close('close'); a?.focus({ preventScroll: true }); }}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </header>
      <div className="trigger-picker-body">
        {picked ? (
          <TemplateForm
            key={picked.id}
            template={picked}
            taskId={taskId}
            sessionId={sessionId}
            onHandoff={(shownParams) => prefill(templateHandoffText(acp, picked, shownParams), `template ${picked.id}`)}
            onDone={() => close('close')}
          />
        ) : (
          <TriggerList
            loaded={loaded}
            onRetry={load}
            onPick={setPicked}
            onDescribe={() => prefill(describeText(acp), 'describe')}
            onIdea={(idea) => prefill(ideaText(acp, idea), `idea ${idea.label}`)}
          />
        )}
      </div>
    </div>,
    document.body,
  );
}

function TriggerList({ loaded, onRetry, onPick, onDescribe, onIdea }: {
  loaded: Loaded;
  onRetry: () => void;
  onPick: (template: TriggerTemplate) => void;
  onDescribe: () => void;
  onIdea: (idea: TriggerIdea) => void;
}) {
  return (
    <>
      <section className="trigger-picker-section" aria-label="From your plugins">
        <h3 className="trigger-picker-section-title">From your plugins</h3>
        {loaded.state === 'loading' && <p className="trigger-picker-note">Looking for plugin triggers…</p>}
        {loaded.state === 'error' && (
          <p className="trigger-picker-note is-error">
            Could not list plugin triggers: {loaded.message}{' '}
            <button type="button" className="trigger-picker-link" onClick={onRetry}>Try again</button>
          </p>
        )}
        {loaded.state === 'ready' && loaded.templates.length === 0 && (
          <p className="trigger-picker-note">No installed plugin offers a ready-made trigger. Describe it below and the AI sets it up.</p>
        )}
        {loaded.state === 'ready' && loaded.templates.map((t) => (
          <button key={t.id} type="button" className="trigger-picker-row" data-template={t.id} onClick={() => onPick(t)}>
            <span className="trigger-picker-row-plugin">{t.pluginName}</span>
            <span className="trigger-picker-row-text">
              <span className="trigger-picker-row-title">{t.title}</span>
              <span className="trigger-picker-row-desc">{t.description}</span>
            </span>
          </button>
        ))}
      </section>
      <section className="trigger-picker-section" aria-label="Describe it">
        <h3 className="trigger-picker-section-title">Anything else</h3>
        <button type="button" className="trigger-picker-row" data-describe="words" onClick={onDescribe}>
          <span className="trigger-picker-row-plugin" aria-hidden>AI</span>
          <span className="trigger-picker-row-text">
            <span className="trigger-picker-row-title">Describe it in words…</span>
            <span className="trigger-picker-row-desc">
              The AI writes a small check with what it has (an MCP server, a CLI like gh, a web API), tests it, then arms it.
            </span>
          </span>
        </button>
        <div className="trigger-picker-ideas" role="group" aria-label="Ideas">
          {TRIGGER_IDEAS.map((idea) => (
            <button key={idea.label} type="button" className="trigger-picker-idea" onClick={() => onIdea(idea)}>
              {idea.label}
            </button>
          ))}
        </div>
      </section>
    </>
  );
}

const EMPTY_PARAMS = { values: {}, shown: {} };

function TemplateForm({ template, taskId, sessionId, onHandoff, onDone }: {
  template: TriggerTemplate;
  taskId: string;
  sessionId: string;
  onHandoff: (params: Record<string, string>) => void;
  onDone: () => void;
}) {
  // What is filled in stays until the trigger is armed: closing the picker keeps it.
  const params = useDraftValue<{ values: Record<string, string>; shown: Record<string, string> }>(
    draftKey('trigger-form', taskId, template.id), EMPTY_PARAMS);
  const { values, shown } = params.value;
  const promptDraft = useDraft(draftKey('trigger-form', taskId, template.id, 'prompt'));
  const { text: prompt, setText: setPrompt } = promptDraft;
  const [every, setEvery] = useState(template.every);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedTemplateTrigger | null>(null);
  const missing = missingRequired(template, values);
  const firstRef = useRef<HTMLInputElement>(null);
  const promptBox = useRef<HTMLTextAreaElement | null>(null);
  const promptMic = useRef<BoxMicHandle | null>(null);
  useEffect(() => { firstRef.current?.focus({ preventScroll: true }); }, []);

  const set = (key: string, value: string, label = value) => {
    params.setValue((p) => ({ values: { ...p.values, [key]: value }, shown: { ...p.shown, [key]: label } }));
    setError(null);
  };

  const submit = async () => {
    if (saving || missing.length) return;
    setSaving(true);
    setError(null);
    try {
      // A transcription still on its way lands after the save, unsaved: drop it now.
      promptMic.current?.clear();
      const paramsKey = params.key;
      const promptKey = promptDraft.key;
      const result = await createTemplateTrigger({ template: template.id, params: values, taskId, every, prompt });
      params.clear(paramsKey);
      promptDraft.clear(promptKey);
      log.info('trigger', 'template trigger created from composer', { sessionId, taskId, template: template.id, jobId: result.id });
      onRoutinesChanged();
      setCreated(result);
    } catch (err) {
      const message = triggerErrorMessage(err);
      log.warn('trigger', 'template trigger create refused', { sessionId, taskId, template: template.id, error: message });
      setError(message);
    } finally {
      setSaving(false);
    }
  };

  if (created) {
    return (
      <div className="trigger-picker-done" data-testid="trigger-picker-done" role="status">
        <p className="trigger-picker-done-title">Trigger armed</p>
        <p className="trigger-picker-note">
          {created.description} Each fire arrives in this session; the task&apos;s trigger pill pauses or removes it.
        </p>
        <button type="button" className="trigger-picker-primary" onClick={onDone}>Done</button>
      </div>
    );
  }

  return (
    <form className="trigger-picker-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <p className="trigger-picker-note">{template.description}</p>
      {template.params.map((param, index) => (
        <ParamField
          key={param.key}
          param={param}
          template={template.id}
          inputRef={index === 0 ? firstRef : undefined}
          value={shown[param.key] ?? ''}
          onType={(text) => set(param.key, text)}
          onChoose={(option) => set(param.key, option.value, option.label)}
          draftKey={params.key}
        />
      ))}
      <label className="trigger-picker-field">
        <span className="trigger-picker-label">When it fires <span className="trigger-picker-optional">(optional)</span></span>
        <MicField boxRef={promptBox} text={prompt} setText={setPrompt} handleRef={promptMic} disabled={saving}>
          <textarea
            ref={promptBox}
            className="trigger-picker-input"
            data-draft-key={promptDraft.key ?? undefined}
            rows={2}
            value={prompt}
            placeholder="What the AI should do with each new item, e.g. summarize it and tell me if it needs me"
            onChange={(e) => setPrompt(e.target.value)}
          />
        </MicField>
      </label>
      <div className="trigger-picker-field">
        <span className="trigger-picker-label" id={`every-${template.id}`}>Check every</span>
        <div className="trigger-picker-every" role="radiogroup" aria-labelledby={`every-${template.id}`}>
          {EVERY_CHOICES.map((choice) => (
            <button
              key={choice}
              type="button"
              role="radio"
              aria-checked={every === choice}
              className={`trigger-picker-chip${every === choice ? ' is-on' : ''}`}
              onClick={() => setEvery(choice)}
            >
              {choice}
            </button>
          ))}
        </div>
      </div>
      {error && <p className="trigger-picker-note is-error" role="alert">{error}</p>}
      <div className="trigger-picker-actions">
        <button
          type="submit"
          className="trigger-picker-primary"
          disabled={saving || missing.length > 0}
          title={missing.length ? `Fill in ${missing.join(', ')}` : undefined}
        >
          {saving ? 'Creating…' : 'Create trigger'}
        </button>
        {/* The words the user sees ("#eng-oncall"), not the ids: the AI resolves a name through the template. */}
        <button type="button" className="trigger-picker-secondary" onClick={() => onHandoff(shown)}>
          Describe it to the AI instead
        </button>
      </div>
    </form>
  );
}

function ParamField({ param, template, value, inputRef, onType, onChoose, draftKey: formKey }: {
  draftKey: string | null;
  param: TriggerTemplateParam;
  template: string;
  value: string;
  inputRef?: RefObject<HTMLInputElement | null>;
  onType: (text: string) => void;
  onChoose: (option: TriggerTemplateOption) => void;
}) {
  const [options, setOptions] = useState<TriggerTemplateOption[] | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const fieldRef = useRef<HTMLDivElement>(null);
  // The newest lookup wins: each keystroke cancels the one still waiting, and
  // an answer for an older one (or after unmount) is dropped.
  const requestRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    requestRef.current += 1;
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const query = useCallback((q: string) => {
    if (!param.options) return;
    const id = ++requestRef.current;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      fetchTriggerTemplateOptions(template, param.key, q)
        .then((list) => { if (requestRef.current === id) { setOptions(list); setOptionsError(null); } })
        .catch((err: unknown) => { if (requestRef.current === id) setOptionsError(triggerErrorMessage(err)); });
    }, q ? 200 : 0);
  }, [param.options, param.key, template]);

  return (
    <div
      ref={fieldRef}
      className="trigger-picker-field"
      onBlur={(e) => { if (!fieldRef.current?.contains(e.relatedTarget as Node | null)) setListOpen(false); }}
    >
      <label className="trigger-picker-label" htmlFor={`tp-${template}-${param.key}`}>
        {param.label}{!param.required && <span className="trigger-picker-optional"> (optional)</span>}
      </label>
      <div className="trigger-picker-combo">
        <input
          id={`tp-${template}-${param.key}`}
          ref={inputRef}
          className="trigger-picker-input"
          data-draft-key={formKey ?? undefined}
          value={value}
          placeholder={param.placeholder}
          autoComplete="off"
          onFocus={() => { if (param.options) { setListOpen(true); if (!options) query(value); } }}
          // A click into the field it already has focus in (after Escape closed the choices) opens them again.
          onClick={() => { if (param.options && !listOpen) setListOpen(true); }}
          onChange={(e) => { onType(e.target.value); if (param.options) { setListOpen(true); query(e.target.value); } }}
          onKeyDown={(e) => {
            // Escape closes the choices first; only the next one leaves the form.
            if (e.key === 'Escape' && listOpen) { e.preventDefault(); e.stopPropagation(); setListOpen(false); }
          }}
        />
        {param.options && listOpen && (
          <div
            className="trigger-picker-options"
            role="listbox"
            aria-label={`${param.label} choices`}
            // Keep the focus in the input: WebKit does not focus a clicked button, so the
            // blur would name no target, close the list and drop the click.
            onMouseDown={(e) => e.preventDefault()}
          >
            {optionsError && <p className="trigger-picker-note is-error">{optionsError}</p>}
            {!optionsError && options === null && <p className="trigger-picker-note">Loading…</p>}
            {!optionsError && options?.length === 0 && <p className="trigger-picker-note">No match. You can still type a name.</p>}
            {options?.map((option) => (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={value === option.label}
                className="trigger-picker-option"
                onClick={() => { onChoose(option); setListOpen(false); }}
              >
                <span>{option.label}</span>
                {option.hint && <span className="trigger-picker-option-hint">{option.hint}</span>}
              </button>
            ))}
          </div>
        )}
      </div>
      {param.description && <span className="trigger-picker-hint">{param.description}</span>}
    </div>
  );
}
