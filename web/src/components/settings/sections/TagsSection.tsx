/**
 * TagsSection: which tags a task shows (src/core/tag-display-rules.ts).
 *
 * One row per tag namespace (`ticket:` covers every `ticket:…` tag) and per plain tag, each
 * with a Show on tasks switch. The switch writes the user's rule; switching back to what
 * applies without it (a plugin's default, or shown) removes the rule instead of storing a
 * copy, so a plugin that changes its default later is heard. Walnut's own `walnut:` tags are
 * types with pills of their own and are not listed. Display only: a hidden tag is still
 * searched, filtered and listed in the tag editor.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  SettingsEmpty,
  SettingsGroup,
  SettingsLoadingRow,
  SettingsNotice,
  SettingsRow,
  SettingsSection,
} from '../SettingsSection';
import { ToggleSwitch } from '../inputs/ToggleSwitch';
import { useSettingsSaved } from '../settings-pane-context';
import { useEvent } from '@/hooks/useWebSocket';
import { fetchTags } from '@/api/tasks';
import { setTagDisplay, useTagDisplay, type TagDisplayRule } from '@/stores/tag-display-store';
import {
  MACHINE_TAG_NAMESPACE,
  compileTagDisplay,
  patternForTag,
  patternNamespace,
  tagNamespace,
} from '../../../../../src/core/tag-display-rules';

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
}

/** Rows above this count get a filter box. */
const FILTER_FROM = 10;

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

export function buildTagRows(counts: ReadonlyArray<{ tag: string; count: number }>, rules: readonly TagDisplayRule[]): TagRow[] {
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
  const exact = new Set(rules.filter((rule) => rule.source !== 'builtin' && !patternNamespace(rule.pattern)).map((rule) => rule.pattern));
  for (const { tag, count } of counts) {
    if (tagNamespace(tag) === MACHINE_TAG_NAMESPACE) continue;
    const row = touch(exact.has(tag) ? tag : patternForTag(tag));
    row.tags += 1;
    row.uses += count;
  }
  // A rule for tags no task carries any more stays listed, so it can still be undone.
  for (const rule of rules) {
    if (rule.source !== 'builtin') touch(rule.pattern);
  }
  return [...rows.values()].sort((a, b) =>
    Number(b.namespace) - Number(a.namespace) || b.uses - a.uses || a.label.localeCompare(b.label));
}

export function TagsSection() {
  const { rules, compiled } = useTagDisplay();
  const [counts, setCounts] = useState<Array<{ tag: string; count: number }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const { track } = useSettingsSaved();

  const loadCounts = () => {
    fetchTags()
      .then((tags) => setCounts(tags))
      .catch((err) => { setCounts([]); setError(err instanceof Error ? err.message : 'Could not load the tags.'); });
  };
  useEffect(loadCounts, []);
  // Tags come and go with tasks; a filing plugin announces its bulk writes this way.
  useEvent('task:updated', (data) => { if (!(data as { task?: unknown } | null)?.task) loadCounts(); });

  const rows = useMemo(() => buildTagRows(counts ?? [], rules), [counts, rules]);
  const needle = filter.trim().toLowerCase();
  const visible = needle ? rows.filter((row) => row.label.toLowerCase().includes(needle)) : rows;

  const toggle = async (row: TagRow, show: boolean) => {
    const next = show ? 'shown' : 'hidden';
    // What applies without the user's rule: switching back to it removes the rule.
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
    const size = row.namespace
      ? `${plural(row.tags, 'tag')}, on ${plural(row.uses, 'task')}`
      : plural(row.uses, 'task');
    const rule = compiled.ruleFor(row.probe);
    if (rule?.source === 'user') return `${size}. Your choice.`;
    if (rule?.source === 'plugin') {
      const who = rule.pluginName ?? rule.pluginId ?? 'a plugin';
      return `${size}. ${rule.display === 'hidden' ? 'Hidden' : 'Shown'} by ${who}.`;
    }
    return `${size}.`;
  };

  return (
    <SettingsSection
      id="tags"
      title="Tags"
      description="Which tags show on tasks. A hidden tag still works in search and filters, and the task's tag editor still lists it."
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
              const shown = compiled.shown(row.probe);
              const id = `tag-display-${row.pattern}`;
              return (
                <SettingsRow
                  key={row.pattern}
                  className="tags-settings-row"
                  data-tag-pattern={row.pattern}
                  label={<span className="tags-settings-label">{row.label}</span>}
                  help={help(row)}
                  control={
                    <ToggleSwitch
                      id={id}
                      checked={shown}
                      busy={busy === row.pattern}
                      aria-label={`Show ${row.label} on tasks`}
                      data-testid={`tag-display-toggle-${row.pattern}`}
                      onChange={(value: boolean) => void toggle(row, value)}
                    />
                  }
                />
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
