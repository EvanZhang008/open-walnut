/**
 * Settings › Task providers (src/core/private-tasks/provider-rules.ts): every plugin that syncs
 * tasks, as one card, with the rules a task must pass before it syncs there.
 *
 *   - The card's head: the plugin's icon and name, what is checked now in one line, and the switch
 *     that turns the check on or off (off sends every task: the plugin's default for a service only
 *     the user reads, a personal list).
 *   - Hard rules: words, phrases or /patterns/ as chips; a task whose title, description or notes
 *     contain one fails and stays in Walnut.
 *   - AI rule: what to keep out, in the user's words; the fast model reads each task against it and
 *     answers pass or fail with a reason. Walnut's default rule is shown until the user writes one.
 *   - Test a task: a title typed here is checked against the hard rules at once, and against the AI
 *     rule on one click (one model call).
 *
 * Stored per plugin in `private_tasks.providers[<id>]`; a value never set shows its default. The
 * check is also written to `private_tasks.audience[<id>]` (self = off, shared = on), the field the
 * release before this one reads, so going back keeps the user's choice; that release reads only
 * the global word list and model switch.
 */
import { useEffect, useRef, useState } from 'react'
import type { Config } from '@open-walnut/core'
import { SettingsGroup, SettingsRow, SettingsSection } from '../SettingsSection'
import { ToggleSwitch } from '../inputs/ToggleSwitch'
import { SettingsButton } from '../inputs/SettingsButton'
import { useOptimisticSetting } from '../inputs/useOptimisticSetting'
import { useCommitField } from '../inputs/useCommitField'
import { PluginIcon, pluginTileTints } from '../PluginIcon'
import { useSerialSave, type BuildPatch, type OnSave } from './GeneralSection'
import { HardRulesEditor, TryVerdict, verdictOf, wordsFromText, type AiAnswer } from './task-provider-parts'
import { listTaskProviders, testProviderRules, type ProviderRules } from '@/api/private-tasks'
import { log } from '@/utils/log'
import '@/styles/settings-controls.css'
import '@/styles/settings-task-providers.css'

export { wordsFromText }

type ProviderPatch = NonNullable<NonNullable<Config['private_tasks']>['providers']>[string]

export function TaskProvidersSection({ config, onSave }: { config: Config; onSave: OnSave }) {
  const save = useSerialSave(config, onSave)
  const [providers, setProviders] = useState<ProviderRules[] | null>(null)
  const rulesKey = JSON.stringify(config.private_tasks ?? {})
  useEffect(() => {
    let alive = true
    listTaskProviders()
      .then((r) => { if (alive) setProviders(r.providers) })
      .catch((err) => { log.warn('settings', 'task providers not read', { error: String(err) }); if (alive) setProviders([]) })
    return () => { alive = false }
  }, [rulesKey])
  const tints = pluginTileTints(providers ?? [])

  return (
    <SettingsSection id="task-providers" title="Task providers">
      {providers === null ? null : providers.length === 0 ? (
        <SettingsGroup data-testid="task-providers-empty">
          <SettingsRow
            label="No task provider is connected"
            help="A plugin that syncs tasks, a to-do list or a team tracker, shows here once it is set up in Plugins"
          />
        </SettingsGroup>
      ) : providers.map((p) => (
        <ProviderCard
          key={p.id}
          provider={p}
          tint={tints.get(p.id) ?? 'var(--fg-muted)'}
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
  )
}

/** The head's one line: what is checked now. */
function summaryOf(p: ProviderRules, on: boolean, words: number, ai: boolean): string {
  if (!on) return p.check_default ? 'Not checked: every task syncs' : 'Not checked: only you read it, so every task syncs'
  const rules = [words ? `${words} hard ${words === 1 ? 'rule' : 'rules'}` : '', ai ? 'the AI rule' : ''].filter(Boolean)
  return rules.length ? `Checks every task against ${rules.join(' and ')}` : 'Checks every task, no rules yet'
}

function ProviderCard({ provider: p, tint, save }: {
  provider: ProviderRules
  tint: string
  save: (patch: ProviderPatch, rowKey: string) => Promise<void>
}) {
  const key = (k: string) => `task-providers.${p.id}.${k}`
  const id = (k: string) => `settings-provider-${p.id}-${k}`
  const check = useOptimisticSetting<boolean>(p.check, (v) => save({ check: v }, key('check')), { rowKey: key('check') })
  // One string, so the hook can tell a saved list from the server's by value.
  const wordsText = useOptimisticSetting<string>(
    p.words.join('\n'), (text) => save({ words: wordsFromText(text) }, key('words')), { rowKey: key('words') },
  )
  const words = wordsFromText(wordsText.value)
  const ai = useOptimisticSetting<boolean>(p.ai, (v) => save({ ai: v }, key('ai')), { rowKey: key('ai') })
  // The default rule is shown as it is; saving it unchanged (or empty) stores '' (the default).
  const rule = useCommitField<string>(
    p.ai_rule, (text) => save({ ai_rule: text.trim() && text.trim() !== p.ai_rule_default ? text.trim() : '' }, key('ai-rule')),
    { rowKey: key('ai-rule'), kind: 'text', multiline: true },
  )
  const ruleText = rule.inputProps.value
  const isDefaultRule = !ruleText.trim() || ruleText.trim() === p.ai_rule_default

  // Which saved lines the server cannot use, and which one a typed title matches.
  const [invalid, setInvalid] = useState<string[]>([])
  const [match, setMatch] = useState<string | null>(null)
  const [sample, setSample] = useState('')
  useEffect(() => {
    let alive = true
    const t = setTimeout(() => {
      testProviderRules({ text: sample, words, provider: p.id })
        .then((r) => { if (alive) { setInvalid(r.invalid); setMatch(sample.trim() ? r.match : null) } })
        .catch(() => { if (alive) setMatch(null) })
    }, 250)
    return () => { alive = false; clearTimeout(t) }
  }, [sample, wordsText.value, p.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Every ask has a number: an answer for an older title or rule (or a card no longer shown) is
  // dropped, so the verdict on screen is always for what is typed now.
  const [answer, setAnswer] = useState<AiAnswer>(null)
  const asked = useRef(0)
  useEffect(() => () => { asked.current++ }, [])
  useEffect(() => { asked.current++; setAnswer(null) }, [sample, ruleText])
  const askAi = () => {
    const n = ++asked.current
    const settle = (v: AiAnswer) => { if (asked.current === n) setAnswer(v) }
    setAnswer('asking')
    testProviderRules({ text: sample, provider: p.id, ai: true, ai_rule: ruleText })
      .then((r) => settle(r.ai ?? { error: 'No answer' }))
      .catch((err) => settle({ error: err instanceof Error ? err.message : String(err) }))
  }

  const on = check.value
  const verdict = verdictOf({ sample, hardMatch: match, ai: ai.value, answer })
  return (
    <SettingsGroup
      className="tp-card"
      data-testid={`task-provider-${p.id}`}
      footer={on
        ? 'A task that fails stays in Walnut, and one letter lists the tasks kept out. Turning the check off syncs them, except the ones you made local yourself.'
        : undefined}
    >
      <SettingsRow
        className="tp-head"
        label={<span className="tp-name"><PluginIcon name={p.name} iconUrl={p.icon_url} tint={tint} />{p.name}</span>}
        help={summaryOf(p, on, words.length, ai.value)}
        htmlFor={id('check')}
        error={check.error}
        data-testid={id('head')}
        control={<ToggleSwitch id={id('check')} aria-label={`Check tasks before they sync to ${p.name}`} checked={on} busy={check.busy} onChange={check.set} />}
      />
      {on && (
        <>
          <SettingsRow
            className="settings-row-stacked"
            label="Hard rules"
            help="A task whose title, description or notes contain one of these fails"
            htmlFor={id('words')}
            error={wordsText.error}
            control={<HardRulesEditor id={id('words')} words={words} invalid={invalid} busy={wordsText.busy} onChange={(w) => wordsText.set(w.join('\n'))} />}
          />
          <SettingsRow
            label="AI rule"
            help="The fast model reads each task against your words and answers pass or fail, with a reason"
            htmlFor={id('ai')}
            error={ai.error}
            control={<ToggleSwitch id={id('ai')} checked={ai.value} busy={ai.busy} onChange={ai.set} />}
          />
          {ai.value && (
            <SettingsRow
              className="settings-row-stacked tp-rule-row"
              indent
              label="What to keep out"
              help={isDefaultRule ? 'Walnut\'s default rule. Write your own in its place' : (
                <>
                  Your own rule.{' '}
                  <button
                    type="button"
                    className="tp-link"
                    data-testid={id('ai-rule-reset')}
                    onClick={() => {
                      rule.inputProps.onChange({ target: { value: p.ai_rule_default } } as Parameters<typeof rule.inputProps.onChange>[0])
                      void rule.flush()
                    }}
                  >
                    Use the default rule
                  </button>
                </>
              )}
              htmlFor={id('ai-rule')}
              error={rule.error}
              control={(
                <textarea
                    id={id('ai-rule')}
                    data-testid={id('ai-rule')}
                    data-no-draft="autosave"
                    className="tp-ai-rule-text"
                    rows={7}
                    maxLength={4000}
                  {...rule.inputProps}
                />
              )}
            />
          )}
          <SettingsRow
            className="settings-row-stacked tp-try-row"
            label="Test a task"
            htmlFor={id('try')}
            data-testid={id('try-row')}
            control={(
              <div className="tp-try">
                <div className="tp-try-field">
                  <input
                    id={id('try')}
                    data-testid={id('try')}
                    data-no-draft="autosave"
                    type="text"
                    className="settings-input tp-try-input"
                    placeholder="A task title"
                    value={sample}
                    onChange={(e) => setSample(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && ai.value && sample.trim() && !match && answer !== 'asking') askAi() }}
                  />
                  {ai.value && (
                    <SettingsButton
                      data-testid={id('ask-ai')}
                      disabled={!sample.trim() || !!match || answer === 'asking'}
                      busy={answer === 'asking'}
                      busyLabel="Asking"
                      onClick={askAi}
                    >
                      Ask AI
                    </SettingsButton>
                  )}
                </div>
                <TryVerdict id={id('verdict')} tone={verdict.tone} text={verdict.text} />
              </div>
            )}
          />
        </>
      )}
    </SettingsGroup>
  )
}
