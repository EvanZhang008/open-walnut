/**
 * Settings › Tasks › Private tasks (src/core/private-tasks/): what keeps a task out of the
 * outside service its project syncs to.
 *
 *   - Private words: one word, phrase or /pattern/ per line. A task whose text matches is
 *     created local whoever creates it, and an edit that adds one stops a synced task before its
 *     next push. Kept in the user's own config (`private_tasks.words`).
 *   - Check with AI: the fast model judges every text of a task before it is pushed (a new task,
 *     an edit, a summary); a private one stays local and the user gets a letter. On by default.
 *   - Try it: which word a title would match, against the list as typed.
 */
import { useEffect, useState } from 'react';
import type { Config } from '@open-walnut/core';
import { SettingsGroup, SettingsRow } from '../SettingsSection';
import { ToggleSwitch } from '../inputs/ToggleSwitch';
import { useOptimisticSetting } from '../inputs/useOptimisticSetting';
import { useCommitField } from '../inputs/useCommitField';
import { testPrivateWords } from '@/api/private-tasks';
import type { BuildPatch } from './GeneralSection';

/** The textarea's lines as the stored list: trimmed, no empty lines, no repeats. */
export function wordsFromText(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const w = line.trim();
    if (!w || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out;
}

export function PrivateTasksGroup({ config, save }: {
  config: Config;
  save: (build: BuildPatch, opts?: { rowKey?: string }) => Promise<void>;
}) {
  const savePrivate = (patch: NonNullable<Config['private_tasks']>, rowKey: string) =>
    save((c) => ({ private_tasks: { ...(c.private_tasks ?? {}), ...patch } }), { rowKey });
  const words = useCommitField<string>(
    (config.private_tasks?.words ?? []).join('\n'),
    (text) => savePrivate({ words: wordsFromText(text) }, 'tasks.private-words'),
    { rowKey: 'tasks.private-words', kind: 'text', multiline: true },
  );
  const modelCheck = useOptimisticSetting<boolean>(
    config.private_tasks?.model_check !== false,
    (v) => savePrivate({ model_check: v }, 'tasks.private-model-check'),
    { rowKey: 'tasks.private-model-check' },
  );
  const [sample, setSample] = useState('');
  const [result, setResult] = useState<{ match: string | null; invalid: string[] } | null>(null);
  const typed = words.inputProps.value;
  useEffect(() => {
    let alive = true;
    const list = wordsFromText(typed);
    const t = setTimeout(() => {
      if (!sample.trim() && list.length === 0) { setResult(null); return; }
      testPrivateWords(sample, list).then((r) => { if (alive) setResult(r); }).catch(() => { if (alive) setResult(null); });
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [sample, typed]);

  return (
    <SettingsGroup heading="Private tasks" data-testid="tasks-private">
      <SettingsRow
        className="settings-row-stacked"
        label="Private words"
        help="One word, phrase or /pattern/ per line. A task whose title, description or notes match stays in Walnut and never goes to the outside service its project syncs to, whoever creates it. An edit that adds one stops a synced task before its next push."
        htmlFor="settings-private-words"
        error={words.error}
        control={(
          <textarea
            id="settings-private-words"
            data-testid="settings-private-words"
            data-no-draft="autosave"
            className="settings-input settings-input--long"
            rows={5}
            placeholder={'promotion\nperformance review\n/\\bvisa\\b/'}
            {...words.inputProps}
          />
        )}
      />
      {!!result?.invalid.length && (
        <SettingsRow indent state="warning" label="Not used" help={`These lines are not used (not a valid pattern, or one that could be slow): ${result.invalid.join(', ')}`} />
      )}
      <SettingsRow
        indent
        label="Try a title"
        help={!sample.trim() ? 'Type a title to see whether it would stay local.'
          : result?.match ? `Stays local: it matches "${result.match}".`
          : 'No private word matches it (Walnut\'s check still reads it before it is sent).'}
        htmlFor="settings-private-try"
        state={sample.trim() && result?.match ? 'warning' : undefined}
        data-testid="settings-private-try-row"
        control={(
          <input
            id="settings-private-try"
            data-testid="settings-private-try"
            data-no-draft="autosave"
            type="text"
            className="settings-input"
            placeholder="A task title"
            value={sample}
            onChange={(e) => setSample(e.target.value)}
          />
        )}
      />
      <SettingsRow
        label="Check with AI before sending"
        help="Before any text of a task goes to an outside service (a new task, an edit, a summary), the fast model reads it. A private one (your own promotion or performance, feedback on a colleague, pay, health, immigration, money, family, a job search, a side project) stays local and you get a letter; so does one it cannot check. With no model set up, only your words are checked."
        htmlFor="settings-private-model-check"
        error={modelCheck.error}
        control={(
          <ToggleSwitch
            id="settings-private-model-check"
            checked={modelCheck.value}
            busy={modelCheck.busy}
            onChange={modelCheck.set}
          />
        )}
      />
    </SettingsGroup>
  );
}

