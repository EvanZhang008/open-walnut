/**
 * A git source's automatic updates on a plugin's page: the switch (on by default; off for
 * someone changing the plugin in place), when it last updated, and why it did not when it
 * did not. Words live in plugin-auto-update-view.ts.
 */
import { useState } from 'react'
import { SettingsRow } from '@/components/settings/SettingsSection'
import { ToggleSwitch } from '@/components/settings/inputs/ToggleSwitch'
import { couldntSave } from '@/components/settings/inputs/useOptimisticSetting'
import { autoUpdateNote, updatedLine, type AutoUpdateSource } from '@/components/settings/plugin-auto-update-view'
import { useEvent } from '@/hooks/useWebSocket'
import { log } from '@/utils/log'
import type { PluginStore } from './usePluginStore'

export function AutoUpdateRows({ store, slug, source, rowId }: {
  store: PluginStore
  slug: string
  source: AutoUpdateSource
  rowId: string
}) {
  const [pending, setPending] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The server's own round changed this source (pulled, rolled back, skipped): read it again,
  // and the update row with it, so the chip and the line below agree without a reload.
  useEvent('plugin-sources:changed', (data) => {
    if ((data as { slug?: string } | undefined)?.slug !== slug) return
    void store.requestRefresh()
    store.updates.reload()
  })
  const on = pending ?? source.autoUpdate !== false
  const toggle = async (next: boolean) => {
    setPending(next)
    setError(null)
    try {
      const res = await fetch(`/api/plugin-sources/${encodeURIComponent(slug)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autoUpdate: next }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      log.info('plugin-auto-update', 'switch set', { slug, on: next })
      await store.requestRefresh()
    } catch (err) {
      setError(couldntSave(err instanceof Error ? err.message : String(err)))
    } finally {
      setPending(null)
    }
  }
  const line = on ? updatedLine(source) : undefined
  const note = autoUpdateNote(source)
  return (
    <>
      <SettingsRow
        label="Automatic updates"
        help={error ?? line ?? (on ? 'Walnut pulls new commits by itself.' : 'Off: new commits come only when you press Update.')}
        state={error ? 'error' : undefined}
        data-testid={`plugin-auto-update-${rowId}`}
        control={
          <ToggleSwitch
            id={`plugin-auto-update-toggle-${rowId}`}
            checked={on}
            busy={pending !== null}
            aria-label={`Turn automatic updates ${on ? 'off' : 'on'}`}
            onChange={(next) => void toggle(next)}
          />
        }
      />
      {note && (
        <div className={`apps-note apps-note--${note.tone}`} data-testid={`plugin-auto-update-note-${rowId}`}>
          <strong>{note.title}</strong>
          <span>{note.text}</span>
        </div>
      )}
    </>
  )
}
