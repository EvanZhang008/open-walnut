/**
 * Settings › Task providers (src/core/private-tasks/provider-rules.ts): every plugin that syncs
 * tasks, listed by itself, with the rules a task must pass before it syncs there.
 *
 *   - Check tasks before they sync: off sends every task (the plugin's default for a service only
 *     the user reads, a personal list); on applies the two kinds of rules below.
 *   - Hard rules: words, phrases or /patterns/; a task whose title, description or notes match one
 *     fails and stays in Walnut.
 *   - AI rule: what to keep out, in the user's words; the fast model reads each task against it
 *     and answers pass or fail with a reason.
 *   - Try a task title: which hard rule it fails, and (one click, one model call) the AI's verdict.
 *
 * Stored per plugin in `private_tasks.providers[<id>]`; a value never set shows its default. The
 * check is also written to `private_tasks.audience[<id>]` (self = off, shared = on), the field the
 * release before this one reads, so going back keeps the user's choice; that release reads only
 * the global word list and model switch.
 */
import { useEffect, useRef, useState } from 'react';
import type { Config } from '@open-walnut/core';
import { SettingsGroup, SettingsRow, SettingsSection } from '../SettingsSection';
import { ToggleSwitch } from '../inputs/ToggleSwitch';
import { SettingsButton } from '../inputs/SettingsButton';
import { useOptimisticSetting } from '../inputs/useOptimisticSetting';
import { useCommitField } from '../inputs/useCommitField';
import { useSerialSave, type BuildPatch, type OnSave } from './GeneralSection';
import { listTaskProviders, testProviderRules, type ProviderRules, type RulesTest } from '@/api/private-tasks';
import { log } from '@/utils/log';
import '@/styles/settings-controls.css';

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

type ProviderPatch = NonNullable<NonNullable<Config['private_tasks']>['providers']>[string];

export function TaskProvidersSection({ config, onSave }: { config: Config; onSave: OnSave }) {
  const save = useSerialSave(config, onSave);
  const [providers, setProviders] = useState<ProviderRules[] | null>(null);
  const rulesKey = JSON.stringify(config.private_tasks ?? {});
  useEffect(() => {
    let alive = true;
    listTaskProviders()
      .then((r) => { if (alive) setProviders(r.providers); })
      .catch((err) => { log.warn('settings', 'task providers not read', { error: String(err) }); if (alive) setProviders([]); });
    return () => { alive = false; };
  }, [rulesKey]);

  return (
    <SettingsSection id="task-providers" title="Task providers">
      {providers === null ? null : providers.length === 0 ? (
        <SettingsGroup data-testid="task-providers-empty">
          <SettingsRow
            label="No task provider is connected"
            help="A plugin that syncs tasks (a to-do list, a team tracker) shows here once it is set up in Plugins, with the rules a task must pass before it syncs there."
          />
        </SettingsGroup>
      ) : providers.map((p) => (
        <ProviderRulesGroup
          key={p.id}
          provider={p}
          save={(patch, rowKey) => save(((c) => ({
            private_tasks: {
              ...(c.private_tasks ?? {}),
              providers: { ...(c.private_tasks?.providers ?? {}), [p.id]: { ...(c.private_tasks?.providers?.[p.id] ?? {}), ...patch } },
              ...(patch.check === undefined ? {} : {
                audience: { ...(c.private_tasks?.audience ?? {}), [p.id]: patch.check ? 'shared' : 'self' },
              }),
            },
          })) as BuildPatch, { rowKey })}
        />
      ))}
    </SettingsSection>
  );
}

function ProviderRulesGroup({ provider: p, save }: {
  provider: ProviderRules;
  save: (patch: ProviderPatch, rowKey: string) => Promise<void>;
}) {
  const key = (k: string) => `task-providers.${p.id}.${k}`;
  const id = (k: string) => `settings-provider-${p.id}-${k}`;
  const check = useOptimisticSetting<boolean>(p.check, (v) => save({ check: v }, key('check')), { rowKey: key('check') });
  const words = useCommitField<string>(
    p.words.join('\n'), (text) => save({ words: wordsFromText(text) }, key('words')),
    { rowKey: key('words'), kind: 'text', multiline: true },
  );
  const ai = useOptimisticSetting<boolean>(p.ai, (v) => save({ ai: v }, key('ai')), { rowKey: key('ai') });
  // The default rule is shown as it is; saving it unchanged (or empty) stores '' (the default).
  const rule = useCommitField<string>(
    p.ai_rule, (text) => save({ ai_rule: text.trim() && text.trim() !== p.ai_rule_default ? text.trim() : '' }, key('ai-rule')),
    { rowKey: key('ai-rule'), kind: 'text', multiline: true },
  );
  const [sample, setSample] = useState('');
  const [wordsResult, setWordsResult] = useState<RulesTest | null>(null);
  const [aiResult, setAiResult] = useState<RulesTest['ai'] | 'asking' | null>(null);
  const typedWords = words.inputProps.value;
  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      if (!sample.trim()) { setWordsResult(null); return; }
      testProviderRules({ text: sample, words: wordsFromText(typedWords), provider: p.id })
        .then((r) => { if (alive) setWordsResult(r); })
        .catch(() => { if (alive) setWordsResult(null); });
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [sample, typedWords, p.id]);
  // Every ask has a number: an answer for an older title or rule (or a group no longer shown) is
  // dropped, so the verdict on screen is always for what is typed now.
  const asked = useRef(0);
  useEffect(() => () => { asked.current++; }, []);
  useEffect(() => { asked.current++; setAiResult(null); }, [sample, rule.inputProps.value]);
  const askAi = () => {
    const n = ++asked.current;
    const settle = (v: RulesTest['ai'] | null) => { if (asked.current === n) setAiResult(v); };
    setAiResult('asking');
    testProviderRules({ text: sample, provider: p.id, ai: true, ai_rule: rule.inputProps.value })
      .then((r) => settle(r.ai ?? { error: 'No answer' }))
      .catch((err) => settle({ error: err instanceof Error ? err.message : String(err) }));
  };

  const on = check.value;
  return (
    <SettingsGroup heading={p.name} data-testid={`task-provider-${p.id}`}>
      <SettingsRow
        label="Check tasks before they sync"
        help={on
          ? `A task must pass the rules below before it syncs to ${p.name}; one that fails stays in Walnut, and you get one letter for the tasks kept out. Turning this off syncs the tasks it kept out, except the ones you made local yourself.`
          : `Every task syncs to ${p.name}; only your own Local choice keeps one out.${p.check_default ? '' : ' Off by default: only you read it.'}`}
        htmlFor={id('check')}
        error={check.error}
        control={<ToggleSwitch id={id('check')} checked={on} busy={check.busy} onChange={check.set} />}
      />
      {on && (
        <>
          <SettingsRow
            className="settings-row-stacked"
            label="Hard rules"
            help="One word, phrase or /pattern/ per line. A task whose title, description or notes match one fails."
            htmlFor={id('words')}
            error={words.error}
            control={(
              <textarea
                id={id('words')}
                data-testid={id('words')}
                data-no-draft="autosave"
                className="settings-input settings-input--long"
                rows={4}
                placeholder={'salary\nside project\n/\\bcodename-\\w+/'}
                {...words.inputProps}
              />
            )}
          />
          {!!wordsResult?.invalid.length && (
            <SettingsRow indent state="warning" label="Not used" help={`These lines are not used (not a valid pattern, or one that could be slow): ${wordsResult.invalid.join(', ')}`} />
          )}
          <SettingsRow
            label="AI rule"
            help="The fast model reads each task against this rule and answers pass or fail, with a reason. With no model set up, only the hard rules are checked."
            htmlFor={id('ai')}
            error={ai.error}
            control={<ToggleSwitch id={id('ai')} checked={ai.value} busy={ai.busy} onChange={ai.set} />}
          />
          {ai.value && (
            <SettingsRow
              className="settings-row-stacked"
              indent
              label="What to keep out"
              help="In your own words. A task the rule keeps out fails."
              htmlFor={id('ai-rule')}
              error={rule.error}
              control={(
                <textarea
                  id={id('ai-rule')}
                  data-testid={id('ai-rule')}
                  data-no-draft="autosave"
                  className="settings-input settings-input--long"
                  rows={5}
                  maxLength={4000}
                  {...rule.inputProps}
                />
              )}
            />
          )}
          <SettingsRow
            label="Try a task title"
            help={!sample.trim() ? 'Type a title to see whether it passes.'
              : wordsResult?.match ? `Fails the hard rule "${wordsResult.match}".`
              : aiResult === 'asking' ? 'Passes the hard rules. Asking the AI…'
              : aiResult && 'error' in aiResult ? `Passes the hard rules. The AI did not answer: ${aiResult.error}`
              : aiResult && 'pass' in aiResult ? `${aiResult.pass ? 'Passes' : 'Fails'} the AI rule: ${aiResult.reason}.`
              : ai.value ? 'Passes the hard rules. Ask AI to check it against the AI rule.' : 'Passes the hard rules.'}
            htmlFor={id('try')}
            state={sample.trim() && (wordsResult?.match || (aiResult && aiResult !== 'asking' && 'pass' in aiResult && !aiResult.pass)) ? 'warning' : undefined}
            data-testid={id('try-row')}
            control={(
              <span className="settings-try-controls">
                <input
                  id={id('try')}
                  data-testid={id('try')}
                  data-no-draft="autosave"
                  type="text"
                  className="settings-input"
                  placeholder="A task title"
                  value={sample}
                  onChange={(e) => setSample(e.target.value)}
                />
                {ai.value && (
                  <SettingsButton
                    data-testid={id('ask-ai')}
                    disabled={!sample.trim() || !!wordsResult?.match || aiResult === 'asking'}
                    onClick={askAi}
                  >
                    Ask AI
                  </SettingsButton>
                )}
              </span>
            )}
          />
        </>
      )}
    </SettingsGroup>
  );
}
