/**
 * TagLinkEditor: the user's link for one Tags row (a key like `ticket:` or one label), shown
 * as a child row under it. A link is a URL with `{value}` where the tag's value goes; the pill
 * opens it.
 *
 * Same rule as the display switch: saving what applies without the user's rule (a plugin's
 * link, or the user's own link for the whole key) removes the rule instead of storing a copy,
 * so a plugin that changes its link later is heard. An empty field over an inherited link is
 * the user's `''`, which turns that link off; "Use X's" removes the user's rule again.
 */

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { SettingsRow } from '../SettingsSection';
import { SettingsButton } from '../inputs/SettingsButton';
import { useSettingsSaved } from '../settings-pane-context';
import { setTagLink, type TagLinkRule } from '@/stores/tag-display-store';
import { compileTagDisplay, normalizeTagLink, tagHref } from '../../../../../src/core/tag-display-rules';

const LINK_HINT = 'A link is an http(s) URL with {value} where the tag\'s value goes, like https://tracker.example.com/{value}.';

export interface TagLinkEditorProps {
  pattern: string;
  /** A tag the row's rules can be asked about (the pattern itself for one tag). */
  probe: string;
  /** A real tag of the row, for the preview. */
  example?: string;
  links: readonly TagLinkRule[];
  onClose: () => void;
}

/** A link rule as the editor names it: "Virtual Teammate's link", "your ticket: link". */
export function linkOwner(rule: TagLinkRule): string {
  if (rule.source === 'plugin') return `${rule.pluginName ?? rule.pluginId ?? 'a plugin'}'s link`;
  return `your ${rule.pattern.replace(/\*$/, '')} link`;
}

/** The link that applies to `probe` without the user's rule for `pattern`: a plugin's, or the
 *  user's key-wide link. Matched by pattern, never identity (compiled rules are copies). */
export function inheritedLink(links: readonly TagLinkRule[], pattern: string, probe: string): TagLinkRule | undefined {
  return compileTagDisplay([], links.filter((rule) => !(rule.source === 'user' && rule.pattern === pattern))).linkRuleFor(probe);
}

/** What one Save writes: a template, '' (no link over an inherited one), null (remove the
 *  user's rule), 'same' (nothing to write), or an error for a template that is not one. */
export function linkToWrite(
  typed: string,
  own: TagLinkRule | undefined,
  inherited: TagLinkRule | undefined,
): { write: string | null } | { same: true } | { error: string } {
  const text = typed.trim();
  let next: string | null;
  if (!text) {
    next = inherited?.link ? '' : null;
  } else {
    const link = normalizeTagLink(text);
    if (link === null || link === '') return { error: LINK_HINT };
    next = inherited && link === inherited.link ? null : link;
  }
  return next === (own?.link ?? null) ? { same: true } : { write: next };
}

export function TagLinkEditor({ pattern, probe, example, links, onClose }: TagLinkEditorProps) {
  const own = links.find((rule) => rule.source === 'user' && rule.pattern === pattern);
  const inherited = inheritedLink(links, pattern, probe);
  const [text, setText] = useState(own ? own.link : inherited?.link ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const { track } = useSettingsSaved();
  const id = `tag-link-${pattern}`;

  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);

  const write = async (next: string | null) => {
    setBusy(true);
    setError(null);
    try {
      await track(setTagLink(pattern, next));
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    const plan = linkToWrite(text, own, inherited);
    if ('error' in plan) { setError(plan.error); return; }
    if ('same' in plan) { onClose(); return; }
    void write(plan.write);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); save(); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
  };

  const typed = normalizeTagLink(text.trim());
  const sample = example ?? (probe.endsWith(':*') ? undefined : probe);
  const help = own?.link === '' && inherited?.link
    ? `No link: you turned ${linkOwner(inherited)} off.`
    : typed && sample
      ? `${sample} opens ${tagHref(typed, sample)}`
      : !text.trim() && inherited?.link
        ? `Saving it empty turns ${linkOwner(inherited)} off.`
        : '{value} is where the tag\'s value goes.';

  // The second action undoes the user's rule, or turns an inherited link off.
  const secondary = own
    ? { label: inherited?.link ? `Use ${linkOwner(inherited)}` : 'Remove link', next: null }
    : inherited?.link
      ? { label: 'No link', next: '' }
      : null;

  return (
    <SettingsRow
      indent
      wide
      className="tags-settings-link-row"
      data-testid={`tag-link-editor-${pattern}`}
      label="Link"
      htmlFor={id}
      help={help}
      error={error ?? undefined}
      control={
        <span className="tags-settings-link-controls">
          <input
            id={id}
            ref={input}
            type="url"
            className="settings-input"
            value={text}
            placeholder="https://tracker.example.com/{value}"
            spellCheck={false}
            autoComplete="off"
            disabled={busy}
            onChange={(e) => { setText(e.target.value); setError(null); }}
            onKeyDown={onKeyDown}
            data-testid="tag-link-input"
          />
          <SettingsButton variant="primary" busy={busy} busyLabel="Saving..." onClick={save} data-testid="tag-link-save">Save</SettingsButton>
          {secondary && (
            <SettingsButton disabled={busy} onClick={() => void write(secondary.next)} data-testid="tag-link-clear">{secondary.label}</SettingsButton>
          )}
          <SettingsButton variant="text" disabled={busy} onClick={onClose} data-testid="tag-link-cancel">Cancel</SettingsButton>
        </span>
      }
    />
  );
}
