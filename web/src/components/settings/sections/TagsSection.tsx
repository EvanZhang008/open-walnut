/**
 * TagsSection: how a task's tags show (src/core/tag-display-rules.ts).
 *
 * One row per tag key (`ticket:` covers every `ticket:…` tag) and per label, each with a
 * Show / Value / Hide choice (Value: the pill reads only the text after the key). The choice
 * writes the user's rule; choosing what applies without it (a plugin's default, Walnut's, or
 * Show) removes the rule instead of storing a copy, so a plugin that changes its default later
 * is heard. Walnut's own `walnut:` tags are types with pills of their own and are not listed.
 * Display only: a hidden tag is still searched, filtered and listed in the tag editor.
 *
 * Each row can also carry a link (TagLinkEditor): a URL with `{value}` the row's pills open.
 * A plugin's link shows as the row's own until the user changes or turns it off.
 */

import { Fragment, useEffect, useMemo, useState } from 'react';
import {
  SettingsEmpty,
  SettingsGroup,
  SettingsLoadingRow,
  SettingsNotice,
  SettingsRow,
  SettingsSection,
} from '../SettingsSection';
import { SegmentedControl, type SegmentedOption } from '../inputs/SegmentedControl';
import { SettingsButton } from '../inputs/SettingsButton';
import { TagLinkEditor, inheritedLink, linkOwner } from './TagLinkEditor';
import { useSettingsSaved } from '../settings-pane-context';
import { useEvent } from '@/hooks/useWebSocket';
import { fetchTags } from '@/api/tasks';
import { setTagDisplay, useTagDisplay, type TagDisplay, type TagDisplayRule, type TagLinkRule } from '@/stores/tag-display-store';
import {
  MACHINE_TAG_NAMESPACE,
  compileTagDisplay,
  patternForTag,
  patternNamespace,
  tagNamespace,
} from '../../../../../src/core/tag-display-rules';
import { LABEL_KEY, isDerivedTagKey, localDay } from '../../../../../src/core/tag-model';

interface TagRow {
  pattern: string;
  /** What the row reads: `ticket:` for a namespace, the tag itself otherwise. */
  label: string;
  namespace: boolean;
  /** Different tags in the namespace (1 for a plain tag). */
  tags: number;
  /** Tasks carrying them (a task with two tags of one namespace counts twice). */
  uses: number;
  /** A tag the rules can be asked about for this row. */
  probe: string;
  /** One real tag of the row (the link editor's preview). */
  example?: string;
}

/** Rows above this count get a filter box. */
const FILTER_FROM = 10;

const DISPLAY_OPTIONS = (label: string): ReadonlyArray<SegmentedOption<TagDisplay>> => [
  { value: 'shown', label: 'Show', title: `Pills read the whole tag (${label}\u2026)`, testId: 'tag-display-shown' },
  { value: 'value', label: 'Value', title: `Pills read only what follows ${label}`, testId: 'tag-display-value' },
  { value: 'hidden', label: 'Hide', title: 'No pill; still searched, filtered and editable', testId: 'tag-display-hidden' },
];
const DISPLAY_WORD: Record<TagDisplay, string> = { shown: 'Shown', value: 'Value only', hidden: 'Hidden' };

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

export function buildTagRows(
  counts: ReadonlyArray<{ tag: string; count: number }>,
  rules: readonly TagDisplayRule[],
  links: readonly TagLinkRule[] = [],
): TagRow[] {
  const rows = new Map<string, TagRow>();
  const touch = (pattern: string): TagRow => {
    let row = rows.get(pattern);
    if (!row) {
      const namespace = patternNamespace(pattern);
      // `<namespace>:*` is never itself an exact rule key, so asking about it reads the
      // namespace's own rule; a plain tag is asked about as itself.
      row = { pattern, label: namespace ? `${namespace}:` : pattern, namespace: !!namespace, tags: 0, uses: 0, probe: pattern };
      rows.set(pattern, row);
    }
    return row;
  };
  // A tag with a rule of its own gets its own row: folded into its namespace's row, the
  // switch would read the namespace's state, not the one that applies to the tag.
  // A link for one tag is a rule of its own the same way.
  const exact = new Set([
    ...rules.filter((rule) => rule.source !== 'builtin' && !patternNamespace(rule.pattern)).map((rule) => rule.pattern),
    ...links.filter((rule) => !patternNamespace(rule.pattern)).map((rule) => rule.pattern),
  ]);
  for (const { tag, count } of counts) {
    const namespace = tagNamespace(tag);
    if (namespace === MACHINE_TAG_NAMESPACE || (namespace && isDerivedTagKey(namespace))) continue;
    const row = touch(exact.has(tag) ? tag : patternForTag(tag));
    row.tags += 1;
    row.uses += count;
    row.example ??= tag;
    // Every label has a row of its own, and the `label:` row (which sets them all) counts them.
    if (namespace === LABEL_KEY) {
      const all = touch(`${LABEL_KEY}:*`);
      all.tags += 1;
      all.uses += count;
      all.example ??= tag;
    }
  }
  // A rule for tags no task carries any more stays listed, so it can still be undone.
  for (const rule of rules) {
    if (rule.source !== 'builtin') touch(rule.pattern);
  }
  for (const rule of links) touch(rule.pattern);
  return [...rows.values()].sort((a, b) =>
    Number(b.namespace) - Number(a.namespace) || b.uses - a.uses || a.label.localeCompare(b.label));
}

function hostOf(href: string): string {
  try { return new URL(href).host; } catch { return href; }
}

export function TagsSection() {
  const { rules, links, compiled } = useTagDisplay();
  const [counts, setCounts] = useState<Array<{ tag: string; count: number }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  // The row whose link editor is open.
  const [editingLink, setEditingLink] = useState<string | null>(null);
  const { track } = useSettingsSaved();

  const loadCounts = () => {
    fetchTags()
      .then((tags) => setCounts(tags))
      .catch((err) => { setCounts([]); setError(err instanceof Error ? err.message : 'Could not load the tags.'); });
  };
  useEffect(loadCounts, []);
  // Tags come and go with tasks; a filing plugin announces its bulk writes this way.
  useEvent('task:updated', (data) => { if (!(data as { task?: unknown } | null)?.task) loadCounts(); });

  const rows = useMemo(() => buildTagRows(counts ?? [], rules, links), [counts, rules, links]);
  const needle = filter.trim().toLowerCase();
  const visible = needle ? rows.filter((row) => row.label.toLowerCase().includes(needle)) : rows;

  const choose = async (row: TagRow, next: TagDisplay) => {
    // What applies without the user's rule: choosing it removes the rule.
    const baseline = compileTagDisplay(rules.filter((rule) => !(rule.source === 'user' && rule.pattern === row.pattern))).display(row.probe);
    setBusy(row.pattern);
    setError(null);
    try {
      await track(setTagDisplay(row.pattern, next === baseline ? null : next));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const help = (row: TagRow): string => {
    const namespace = patternNamespace(row.pattern);
    const size = namespace && isDerivedTagKey(namespace)
      ? `Every task's own ${namespace === 'created' ? 'creation' : 'last update'} day, searchable as ${namespace}:${localDay(new Date().toISOString())}`
      : row.namespace
        ? `${plural(row.tags, 'tag')}, on ${plural(row.uses, 'task')}`
        : plural(row.uses, 'task');
    const rule = compiled.ruleFor(row.probe);
    // What the pill opens (a link rule), e.g. "Opens tracker.example.com (Virtual Teammate)."
    const link = compiled.linkRuleFor(row.probe);
    const href = link?.link ? compiled.linkFor(row.probe) : undefined;
    const inherited = link?.source === 'user' && link.link === '' ? inheritedLink(links, link.pattern, row.probe) : undefined;
    const opens = href
      ? ` Opens ${hostOf(href)}${link?.source === 'plugin' ? ` (${link.pluginName ?? link.pluginId ?? 'a plugin'})` : ''}.`
      : inherited?.link ? ` No link: you turned ${linkOwner(inherited)} off.` : '';
    if (rule?.source === 'user') return `${size}. Your choice.${opens}`;
    if (rule?.source === 'plugin') {
      const who = rule.pluginName ?? rule.pluginId ?? 'a plugin';
      return `${size}. ${DISPLAY_WORD[rule.display]} by ${who}.${opens}`;
    }
    if (rule?.source === 'default') return `${size}. ${DISPLAY_WORD[rule.display]} by Walnut.${opens}`;
    return `${size}.${opens}`;
  };

  return (
    <SettingsSection
      id="tags"
      title="Tags"
      description="How tags show on tasks. Every tag is key:value; Value shows only what follows the key (a ticket's id). A hidden tag still works in search and filters, and the task's tag editor still lists it. A link makes a pill open a page, with the tag's value in place of {value}."
    >
      <SettingsGroup data-testid="tags-settings">
        {counts === null ? <SettingsLoadingRow /> : (
          <>
            {rows.length > FILTER_FROM && (
              <SettingsRow
                label="Find a tag"
                htmlFor="tags-filter"
                control={
                  <input
                    id="tags-filter"
                    type="search"
                    className="settings-input settings-input--short"
                    value={filter}
                    placeholder="Tag or namespace"
                    onChange={(e) => setFilter(e.target.value)}
                  />
                }
              />
            )}
            {visible.map((row) => {
              const id = `tag-display-${row.pattern}`;
              const linked = !!compiled.linkFor(row.probe);
              return (
                <Fragment key={row.pattern}>
                <SettingsRow
                  className="tags-settings-row"
                  data-tag-pattern={row.pattern}
                  label={<span className="tags-settings-label">{row.label}</span>}
                  help={help(row)}
                  control={
                    <span className="tags-settings-controls">
                      <span data-testid={`tag-display-choice-${row.pattern}`}>
                        <SegmentedControl<TagDisplay>
                          id={id}
                          value={compiled.display(row.probe)}
                          options={DISPLAY_OPTIONS(row.namespace ? row.label : `${row.label.split(':')[0]}:`)}
                          disabled={busy === row.pattern}
                          aria-label={`How ${row.label} shows on tasks`}
                          onChange={(value) => void choose(row, value)}
                        />
                      </span>
                      <SettingsButton
                        variant="text"
                        reserve={['Edit link', 'Add link']}
                        aria-expanded={editingLink === row.pattern}
                        aria-label={`${linked ? 'Edit' : 'Add'} the link ${row.label} opens`}
                        onClick={() => setEditingLink((open) => (open === row.pattern ? null : row.pattern))}
                        data-testid={`tag-link-edit-${row.pattern}`}
                      >
                        {linked ? 'Edit link' : 'Add link'}
                      </SettingsButton>
                    </span>
                  }
                />
                {editingLink === row.pattern && (
                  <TagLinkEditor
                    pattern={row.pattern}
                    probe={row.probe}
                    example={row.example}
                    links={links}
                    onClose={() => setEditingLink(null)}
                  />
                )}
                </Fragment>
              );
            })}
            {rows.length === 0 && <SettingsEmpty>No tags yet.</SettingsEmpty>}
            {rows.length > 0 && visible.length === 0 && <SettingsEmpty>No tag matches "{filter.trim()}".</SettingsEmpty>}
          </>
        )}
      </SettingsGroup>
      {error && <SettingsNotice kind="error" role="alert">{error}</SettingsNotice>}
    </SettingsSection>
  );
}
