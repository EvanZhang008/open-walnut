/**
 * Settings, Sessions, "Message hints": the registry of Walnut text sent with
 * messages to a session's model (src/core/hints/). Reads and writes the same
 * /api/v1/hints routes agents use through hint_list / hint_set / hint_reset, so a
 * person and an agent can never see two different rule sets.
 */
import { useCallback, useEffect, useState } from 'react';
import { apiDelete, apiGet, apiPut } from '@/api/client';
import { log } from '@/utils/log';
import { useDraft } from '@/hooks/useDraft';
import { draftKey } from '@/utils/drafts';
import { SettingsGroup, SettingsRow } from '../SettingsSection';
import { ToggleSwitch } from '../inputs/ToggleSwitch';
import { SegmentedControl } from '../inputs/SegmentedControl';
import { SettingsCheckbox } from '../inputs/SettingsCheckbox';
import { setShowWalnutAdditions, useShowWalnutAdditions } from '@/hooks/useShowWalnutAdditions';

type Trigger = 'every_turn' | 'every_n_turns' | 'session_start' | 'after_compaction' | 'on_change' | 'on_drift' | 'on_request';
type Role = 'main' | 'lead' | 'worker' | 'ask' | 'other';

interface HintRow {
  kind: string;
  label: string;
  description: string;
  built_in: boolean;
  enabled: boolean;
  triggers: Trigger[];
  every_turns?: number;
  placement: 'before' | 'after';
  audience: { roles: Role[]; agents: string[]; sessions: string[] };
  allowed_triggers: Trigger[];
  text?: string;
  overridden: boolean;
  /** A built-in whose text holds a setting of the user's (hint-origin.ts). */
  user_setting?: { label: string; anchor: string; value: string | null; walnut_text: string };
}

const TRIGGER_LABEL: Record<Trigger, string> = {
  session_start: 'At session start',
  after_compaction: 'After a compaction',
  on_change: 'When it changes',
  on_drift: 'When a reply drifts from it',
  every_n_turns: 'Every few messages',
  every_turn: 'Every message',
  on_request: 'When the sender asks',
};
const ROLE_LABEL: Record<Role, string> = { main: 'Main', lead: 'Leads', worker: 'Workers', ask: 'Asks', other: 'Other tasks' };
const ROLES: Role[] = ['main', 'lead', 'worker', 'ask', 'other'];

/** Whose hint a row is: Walnut's own (the same in every Walnut) or the user's. */
export function hintOrigin(h: Pick<HintRow, 'built_in' | 'overridden'>): { label: string; title: string; kind: 'built-in' | 'changed' | 'yours' } {
  if (!h.built_in) return { kind: 'yours', label: 'Yours', title: 'A hint you added. Only your Walnut sends it.' };
  if (h.overridden) return { kind: 'changed', label: 'Built in, changed by you', title: "Walnut's built-in hint and its text, with your own settings for it (on or off, when, to whom, where). Reset to default undoes them." };
  return { kind: 'built-in', label: 'Built in', title: "Walnut's built-in hint, the same in every Walnut." };
}

export function hintWhen(h: Pick<HintRow, 'enabled' | 'triggers' | 'every_turns'>): string {
  if (!h.enabled) return 'Off.';
  if (!h.triggers.length) return 'Never sent.';
  return `${h.triggers.map((t) => (t === 'every_n_turns' ? `every ${h.every_turns ?? 5} messages` : TRIGGER_LABEL[t].toLowerCase())).join(', ')}.`.replace(/^./, (c) => c.toUpperCase());
}

function HintEditor({ hint, onSave, onReset }: {
  hint: HintRow;
  onSave: (patch: Record<string, unknown>) => Promise<boolean>;
  onReset: () => Promise<void>;
}) {
  const [triggers, setTriggers] = useState<Trigger[]>(hint.triggers);
  const [every, setEvery] = useState(String(hint.every_turns ?? 5));
  const [placement, setPlacement] = useState(hint.placement);
  const [roles, setRoles] = useState<Role[]>(hint.audience.roles);
  // The custom text keeps its unsent words across a close or a reload.
  const textDraft = useDraft(hint.built_in ? null : draftKey('message-hint-text', hint.kind), { baseline: hint.text ?? '' });
  const { text, setText } = textDraft;
  const [busy, setBusy] = useState(false);
  const toggle = <T,>(list: T[], v: T, on: boolean) => (on ? [...new Set([...list, v])] : list.filter((x) => x !== v));
  const save = async () => {
    setBusy(true);
    try {
      const n = Number(every);
      const ok = await onSave({
        triggers,
        ...(triggers.includes('every_n_turns') && Number.isInteger(n) && n >= 1 ? { every_turns: n } : {}),
        placement,
        audience: { roles },
        ...(hint.built_in ? {} : { text }),
      });
      if (ok) textDraft.clear();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="message-hint-editor" data-testid={`message-hint-editor-${hint.kind}`}>
      <p className="settings-row-help">{hint.description}</p>
      {hint.user_setting && (
        // Whose words it sends: the user's setting first, then Walnut's own sentence (2026-11-01).
        <div className="message-hint-sends" data-testid={`message-hint-sends-${hint.kind}`}>
          <p className="settings-row-help">What it sends:</p>
          <p className="message-hint-sends-part">
            <span className="message-hint-origin-badge message-hint-origin-badge--yours">Yours</span>{' '}
            {hint.user_setting.value
              ? <mark className="message-hint-yours">{hint.user_setting.value}</mark>
              : <em>Your {hint.user_setting.label} setting is empty, so this hint is not sent.</em>}{' '}
            <a className="message-hint-settings-link" href={`#${hint.user_setting.anchor}`}>Edit your {hint.user_setting.label}</a>
          </p>
          <p className="message-hint-sends-part">
            <span className="message-hint-origin-badge">Built in</span> {hint.user_setting.walnut_text}
          </p>
        </div>
      )}
      {!hint.built_in && (
        <SettingsRow
          indent
          // Stacked: a long control beside the label squeezes it to nothing (2026-10-28).
          className="settings-row-stacked"
          label="Text"
          htmlFor={`hint-text-${hint.kind}`}
          control={(
            <textarea
              id={`hint-text-${hint.kind}`}
              data-draft-key={textDraft.key ?? undefined}
              className="settings-input settings-input--long"
              rows={3}
              maxLength={2000}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          )}
        />
      )}
      {hint.allowed_triggers.map((t) => (
        <SettingsCheckbox
          key={t}
          id={`hint-${hint.kind}-${t}`}
          data-testid={`hint-trigger-${hint.kind}-${t}`}
          checked={triggers.includes(t)}
          label={<span className="settings-row-label">{TRIGGER_LABEL[t]}</span>}
          trailing={t === 'every_n_turns' && triggers.includes(t) ? (
            <input
              type="number"
              min={1}
              max={1000}
              aria-label="Messages between two sends"
              data-testid={`hint-every-${hint.kind}`}
              data-no-draft="number"
              className="settings-input"
              style={{ width: 72 }}
              value={every}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setEvery(e.target.value)}
            />
          ) : undefined}
          onChange={(on) => setTriggers((cur) => toggle(cur, t, on))}
        />
      ))}
      <SettingsRow
        indent
        label="Where"
        control={(
          <SegmentedControl<'before' | 'after'>
            id={`hint-placement-${hint.kind}`}
            aria-label="Where the hint goes"
            value={placement}
            options={[{ value: 'before', label: 'Before the message' }, { value: 'after', label: 'After the message' }]}
            onChange={setPlacement}
          />
        )}
      />
      <SettingsRow indent label="Who gets it" help="None ticked: every session." />
      {ROLES.map((r) => (
        <SettingsCheckbox
          key={r}
          id={`hint-${hint.kind}-role-${r}`}
          checked={roles.includes(r)}
          label={<span className="settings-row-label">{ROLE_LABEL[r]}</span>}
          onChange={(on) => setRoles((cur) => toggle(cur, r, on))}
        />
      ))}
      <div className="message-hint-actions">
        <button type="button" className="settings-button settings-button-primary" disabled={busy} onClick={() => void save()} data-testid={`hint-save-${hint.kind}`}>
          <span className="settings-button-label">Save</span>
        </button>
        {(hint.overridden || !hint.built_in) && (
          <button type="button" className="settings-button settings-button-default" disabled={busy} onClick={() => void onReset()} data-testid={`hint-reset-${hint.kind}`}>
            <span className="settings-button-label">{hint.built_in ? 'Reset to default' : 'Remove'}</span>
          </button>
        )}
      </div>
    </div>
  );
}

/** `replyLanguage`: the Reply language row's value on this page, so "What it sends" follows an edit there. */
export function MessageHintsGroup({ replyLanguage }: { replyLanguage?: string } = {}) {
  const alwaysShowAdded = useShowWalnutAdditions();
  const [hints, setHints] = useState<HintRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const kindDraft = useDraft(draftKey('message-hint-new', 'kind'));
  const textDraft = useDraft(draftKey('message-hint-new', 'text'));
  const { text: newKind, setText: setNewKind } = kindDraft;
  const { text: newText, setText: setNewText } = textDraft;

  const load = useCallback(async () => {
    try {
      const res = await apiGet<{ hints: HintRow[] }>('/api/v1/hints');
      setHints(res.hints);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);
  useEffect(() => { void load(); }, [load, replyLanguage]);

  /** True once stored; a refusal keeps the words in the box (and its draft). */
  const put = async (kind: string, patch: Record<string, unknown>): Promise<boolean> => {
    try {
      await apiPut(`/api/v1/hints/${encodeURIComponent(kind)}`, patch);
      log.info('settings', 'message hint saved', { kind });
      await load();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    }
  };
  const reset = async (kind: string) => {
    try {
      await apiDelete(`/api/v1/hints/${encodeURIComponent(kind)}`);
      setOpen(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <SettingsGroup
      heading="Message hints"
      id="message-hints"
      data-testid="message-hints"
      footer="Short text sent with a message to the AI. Built in: Walnut's own, the same in every Walnut (Reply language sends your own setting with it). Yours: a hint you added. They are for the AI and are not shown in the chat; a session's menu, Raw input & output, shows exactly what it received. Agents can change these too (hint_set)."
    >
      <SettingsRow
        anchor="settings-show-walnut-additions"
        label="Always show what Walnut added to a message"
        htmlFor="show-walnut-additions"
        help="Its notes in front of a message and the context it put first. On by default. Off: each message's Walnut added button shows them."
        control={(
          <ToggleSwitch
            id="show-walnut-additions"
            checked={alwaysShowAdded}
            onChange={(on) => setShowWalnutAdditions(on)}
          />
        )}
      />
      {error && <p className="settings-row-error" role="alert">{error}</p>}
      {!hints && !error && <SettingsRow label="Loading…" />}
      {hints?.map((h) => (
        <div key={h.kind} id={`message-hint-${h.kind}`} data-testid={`message-hint-${h.kind}`}>
          <SettingsRow
            label={(
              <button type="button" className="message-hint-name" onClick={() => setOpen((o) => (o === h.kind ? null : h.kind))} aria-expanded={open === h.kind}>
                {h.label} <span aria-hidden="true">{open === h.kind ? '▾' : '▸'}</span>
                {' '}
                <span
                  className={`message-hint-origin-badge message-hint-origin-badge--${hintOrigin(h).kind}`}
                  data-testid={`message-hint-origin-${h.kind}`}
                  title={hintOrigin(h).title}
                >
                  {hintOrigin(h).label}
                </span>
              </button>
            )}
            help={hintWhen(h)}
            control={(
              <ToggleSwitch
                id={`hint-enabled-${h.kind}`}
                checked={h.enabled}
                onChange={(on) => void put(h.kind, { enabled: on })}
              />
            )}
          />
          {open === h.kind && (
            <HintEditor key={JSON.stringify(h)} hint={h} onSave={(p) => put(h.kind, p)} onReset={() => reset(h.kind)} />
          )}
        </div>
      ))}
      {hints && (
        <SettingsRow
          // Stacked: the name, text and button beside the label squeezed it to one
          // letter per line (2026-10-28, WebKit and Chromium at 1280px).
          className="settings-row-stacked"
          label="Add a hint"
          help="A name (lowercase, dashes) and its text; sent at session start, after a compaction and when edited."
          control={(
            <span className="message-hint-add">
              <input
                aria-label="Hint name"
                data-testid="hint-new-kind"
                data-draft-key={kindDraft.key ?? undefined}
                className="settings-input"
                placeholder="tone"
                value={newKind}
                onChange={(e) => setNewKind(e.target.value.toLowerCase())}
              />
              <input
                aria-label="Hint text"
                data-testid="hint-new-text"
                data-draft-key={textDraft.key ?? undefined}
                className="settings-input settings-input--long"
                placeholder="Keep answers short."
                value={newText}
                onChange={(e) => setNewText(e.target.value)}
              />
              <button
                type="button"
                className="settings-button settings-button-default"
                data-testid="hint-add"
                disabled={!newKind.trim() || !newText.trim()}
                onClick={() => void put(newKind.trim(), { text: newText.trim() }).then((ok) => { if (ok) { kindDraft.clear(); textDraft.clear(); } })}
              >
                <span className="settings-button-label">Add</span>
              </button>
            </span>
          )}
        />
      )}
    </SettingsGroup>
  );
}
