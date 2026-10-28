/**
 * The detail page's fact sections: where a plugin comes from, whether it is current, and
 * the plugins that are parts of it. Wording lives in plugin-store-model.ts; this file only
 * draws it.
 */
import { useEffect, useState } from 'react'
import { SettingsGroup, SettingsRow, SettingsTag } from '@/components/settings/SettingsSection'
import { SettingsButton } from '@/components/settings/inputs/SettingsButton'
import { ToggleSwitch } from '@/components/settings/inputs/ToggleSwitch'
import { couldntSave } from '@/components/settings/inputs/useOptimisticSetting'
import { PluginIcon } from '@/components/settings/PluginIcon'
import { PluginMcpControls } from '@/components/settings/PluginMcpControls'
import { PluginConnectionPanel } from '@/components/settings/PluginConnectionPanel'
import { PluginCascadeConfirm } from '@/components/settings/sections/PluginDependencyRows'
import { PluginUpdateChip } from '@/components/settings/PluginUpdateChip'
import { PluginUpdateButton } from '@/components/settings/PluginUpdateButton'
import { PluginUpdateFeedback } from '@/components/settings/PluginUpdateFeedback'
import { copyText } from '@/components/settings/PluginProvenanceFlyout'
import { CLOUD_LINKED_NOTE, plainText, updateButtonMode } from '@/components/settings/plugin-update-view'
import { RESTART_PENDING_STATE } from '@/components/settings/plugin-update-types'
import { firstSentence, providerFallbackState } from '@/components/settings/sections/plugin-row-view'
import { formatAbsoluteTime } from '@/components/settings/sections/addons-format'
import { homeDirFor, type PluginStore } from './usePluginStore'
import { isLinkedRow, isRunning, isUpdatableRow, originKind, sourceFacts, updateNote, type PlainNote, type RegistryRow } from './plugin-store-model'

function CopyFact({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(t)
  }, [copied])
  return (
    <button type="button" className="apps-fact-copy" onClick={() => { copyText(value); setCopied(true) }} aria-label={`Copy ${label.toLowerCase()}`} aria-live="polite">
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}

function Note({ note, testId }: { note: PlainNote; testId?: string }) {
  return (
    <div className={`apps-note apps-note--${note.tone}`} data-testid={testId}>
      <strong>{note.title}</strong>
      <span>{note.text}</span>
    </div>
  )
}

export function SourceSection({ store, row }: { store: PluginStore; row: RegistryRow }) {
  const source = row.sourceSlug ? store.sources.find((entry) => entry.slug === row.sourceSlug) : undefined
  const { facts, note } = sourceFacts(row, source, homeDirFor(row.source, store.registry?.homeDir), {
    cloud: store.registry?.cloud,
    sourcesUnavailable: store.registry?.sourcesUnavailable,
  })
  const siblings = isLinkedRow(row) ? store.siblingNamesOf(row) : []
  return (
    <SettingsGroup heading="Where it comes from" className="apps-detail-group" data-testid={`plugin-source-${row.id}`}>
      {facts.map((fact) => (
        <SettingsRow
          key={fact.label}
          label={fact.label}
          className="apps-fact"
          data-fact={fact.label}
          control={
            <span className="apps-fact-value">
              {fact.mono ? <code title={fact.copy}>{fact.value}</code> : <span>{fact.value}</span>}
              {fact.copy && <CopyFact value={fact.copy} label={fact.label} />}
            </span>
          }
        />
      ))}
      {siblings.length > 0 && (
        <SettingsRow label="Same checkout" control={<span className="apps-fact-value">{`${siblings.join(', ')} run from this checkout too`}</span>} />
      )}
      {note && <Note note={note} testId={`plugin-source-note-${row.id}`} />}
    </SettingsGroup>
  )
}

export function VersionSection({ store, row }: { store: PluginStore; row: RegistryRow }) {
  const restartPending = row.state === RESTART_PENDING_STATE
  if (!isUpdatableRow(row)) {
    const kind = row.builtin || row.source.kind === 'builtin' || row.source.kind === 'bundled' ? 'walnut'
      // A replica cannot see the Mac's sources, and a Mac that could not read them cannot
      // tell a hand-copied folder from an install: neither may say "local folder".
      : store.registry?.cloud || store.registry?.sourcesUnavailable ? 'unknown' : 'local'
    return (
      <SettingsGroup heading="Version" className="apps-detail-group" data-testid={`plugin-version-${row.id}`}>
        <SettingsRow label="Version" control={<span className="apps-fact-value">{row.version ? `v${row.version}` : 'Unknown until it starts'}</span>} />
        <SettingsRow
          label="Updates"
          control={<span className="apps-fact-value">{kind === 'walnut' ? 'Comes with each new Walnut version' : kind === 'unknown' ? 'Not known here' : 'Not tracked: a local folder has nothing to compare with'}</span>}
        />
      </SettingsGroup>
    )
  }
  const rowKey = store.rowKeyFor(row)
  const updateRow = rowKey ? store.updates.rows[rowKey] : undefined
  const state = store.stateFor(row)
  const rowBusy = rowKey ? store.updates.busy[rowKey] : undefined
  // A replica reads the Mac's checkouts and cannot touch them: words, no verbs.
  const cloudLinked = Boolean(store.registry?.cloud) && row.source.kind === 'linked'
  const source = row.sourceSlug ? store.sources.find((entry) => entry.slug === row.sourceSlug) : undefined
  const sourceKind: 'git' | 'npm' = row.source.kind === 'npm' || source?.kind === 'npm' ? 'npm' : 'git'
  const buttonMode = !cloudLinked && state?.kind !== 'missing'
    ? updateButtonMode(state, rowBusy, Boolean(store.pressedRows[row.id]), { siblingNames: store.siblingNamesOf(row), pendingActivation: restartPending })
    : { render: false as const }
  const note = updateNote(state, { checkout: row.source.checkout, branch: row.source.branch, homeDir: homeDirFor(row.source, store.registry?.homeDir) })
  return (
    <SettingsGroup heading="Version" className="apps-detail-group" data-testid={`plugin-version-${row.id}`}>
      <SettingsRow label="Version" control={<span className="apps-fact-value">{row.version ? `v${row.version}` : 'Unknown until it starts'}</span>} />
      <SettingsRow
        label="Update"
        help={updateRow?.checkedAt ? `Checked ${formatAbsoluteTime(updateRow.checkedAt)}` : undefined}
        control={
          <span className="settings-addons-inline">
            <PluginUpdateChip
              rowId={row.id}
              state={state}
              checkedAt={updateRow?.checkedAt ?? null}
              busy={rowBusy}
              transient={updateRow?.transient}
              toRef={updateRow?.target?.toRef}
              offline={store.updates.offline}
              isStatic={cloudLinked}
              staticTitle={cloudLinked ? plainText(CLOUD_LINKED_NOTE) : undefined}
              onCheck={rowKey && !cloudLinked ? () => store.checkRow(row) : undefined}
            />
            {!cloudLinked && rowKey && (
              <SettingsButton variant="text" disabled={Boolean(rowBusy)} onClick={() => store.checkRow(row)} data-testid={`plugin-check-${row.id}`}>
                Check again
              </SettingsButton>
            )}
            {!cloudLinked && (
              <PluginUpdateButton
                rowId={row.id}
                mode={buttonMode}
                onClick={() => (isLinkedRow(row)
                  ? void store.handleLinkedUpdate(row)
                  : void store.handleUpdate(row.sourceSlug!, sourceKind, row.id))}
              />
            )}
          </span>
        }
      />
      {store.feedback[row.id] && (
        <div className="settings-row settings-row-indent plugin-store-feedback-row">
          <PluginUpdateFeedback rowId={row.id} feedback={store.feedback[row.id]} />
        </div>
      )}
      {note && <Note note={note} testId={`plugin-update-note-${row.id}`} />}
    </SettingsGroup>
  )
}

/**
 * A part with no account report of its own still says when it is not set up or failed
 * (N06), and nothing when it simply runs: the switch already says on. Never a guess about
 * how it signs in (F16). A part WITH a report gets the full account panel instead.
 */
function PartState({ part }: { part: RegistryRow }) {
  const fallback = providerFallbackState(part)
  if (!fallback.tag) return null
  return (
    <span className="apps-part-account" data-testid={`plugin-provider-${part.id}`} data-provider-state={fallback.tag.text}>
      <SettingsTag tone={fallback.tag.tone}>{fallback.tag.text}</SettingsTag> {fallback.help}
    </span>
  )
}

/**
 * The plugins that are parts of this one, each with its own switch, what it runs (an MCP
 * server, an account) and a way into its own settings. A part's settings stay on its own
 * page, so a form never has two homes.
 */
export function PartsSection({ store, row, parts, tints, onOpen }: {
  store: PluginStore
  row: RegistryRow
  parts: RegistryRow[]
  tints: Map<string, string>
  onOpen: (pluginId: string) => void
}) {
  if (parts.length === 0) return null
  return (
    <SettingsGroup heading={`Parts of ${row.name}`} className="apps-detail-group" data-testid={`plugin-parts-${row.id}`}>
      {parts.map((part) => {
        const on = isRunning(part)
        const switchOn = store.cascadeAsk?.target.id === part.id ? true : (store.pendingToggle[part.id] ?? on)
        const connection = store.connections[part.id]
        return (
          <div key={part.id} className="apps-part" data-testid={`plugin-part-${part.id}`} data-plugin-status={part.status}>
            <SettingsRow
              className="plugin-row-with-icon"
              label={
                <span className="settings-addons-inline">
                  <PluginIcon name={part.name} iconUrl={part.iconUrl} tint={tints.get(part.id) ?? 'var(--fg-muted)'} />
                  <span className="plugin-store-name">{part.name}</span>
                  {part.version && <span className="settings-addons-muted">v{part.version}</span>}
                  <SettingsTag tone="neutral">{originKind(part)}</SettingsTag>
                </span>
              }
              help={
                <>
                  {firstSentence(part.description)}
                  {!connection && <> <PartState part={part} /></>}
                </>
              }
              error={store.toggleError[part.id] ? couldntSave(store.toggleError[part.id]) : undefined}
              control={
                <>
                  <SettingsButton onClick={() => onOpen(part.id)} data-testid={`plugin-part-open-${part.id}`}>
                    {part.configurable ? 'Settings' : 'Details'}
                  </SettingsButton>
                  {part.toggleable ? (
                    <ToggleSwitch
                      id={`plugin-toggle-${part.id}`}
                      checked={switchOn}
                      busy={part.id in store.pendingToggle}
                      aria-label={`Turn ${part.name} ${switchOn ? 'off' : 'on'}`}
                      onChange={(next) => void store.handleToggle(part, next)}
                    />
                  ) : <span className="settings-switch-slot" aria-hidden="true" />}
                </>
              }
            />
            {/* Turning off a part others run on asks here, under the part, as its own row did. */}
            {store.cascadeAsk?.target.id === part.id && (
              <PluginCascadeConfirm
                name={part.name}
                dependents={store.cascadeAsk.dependents.map(store.nameOf).sort((a, b) => a.localeCompare(b))}
                busy={store.busy === part.id}
                onConfirm={() => void store.handleToggle(part, false, { cascade: true })}
                onCancel={() => store.setCascadeAsk(null)}
              />
            )}
            {on && <PluginMcpControls pluginId={part.id} />}
            {on && connection && <PluginConnectionPanel pluginId={part.id} initial={connection} onReport={store.onConnectionReport} />}
          </div>
        )
      })}
    </SettingsGroup>
  )
}
