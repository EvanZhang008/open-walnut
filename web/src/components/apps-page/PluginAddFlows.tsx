/**
 * The ways in that both Store views share (the old grid's Get more and the home screen's
 * Store): the card an install link opens, the git or npm form with its draft, and the
 * dependencies a plugin that just arrived asks for. One copy, so a fix to an install path
 * reaches both.
 */
import { useEffect, useRef, useState } from 'react'
import { SettingsGroup, SettingsNotice, SettingsRow } from '@/components/settings/SettingsSection'
import { ExposeGuide } from './ExposeGuide'
import { SettingsButton } from '@/components/settings/inputs/SettingsButton'
import { PluginPendingDependencies } from '@/components/settings/sections/PluginDependencyRows'
import { sourceRowKey } from '@/components/settings/plugin-update-types'
import { buildInstallLink, INSTALL_LINK_SCHEME, type InstallLinkTarget } from '../../../../src/core/plugin-install-link'
import { peekPendingInstall, settlePendingInstall, subscribeOpenLinks } from '@/utils/open-link'
import { useDraft } from '@/hooks/useDraft'
import { draftKey } from '@/utils/drafts'
import type { PluginStore } from './usePluginStore'
import { installedSourceFor, sourceDisplayName } from './source-sections'

/** The one line an install says before it runs: clicking Install is the consent. */
export const INSTALL_CONSENT = "Install only from a source you trust: a plugin's code runs inside Walnut with full access to your tasks, notes, credentials and this computer."

/** A git remote the local git can clone; anything else is treated as an npm spec. */
function looksLikeGitUrl(value: string): boolean {
  return /^(https?:\/\/|ssh:\/\/|git@[\w.-]+:|file:\/\/)/.test(value)
}

/** What the link card says when its install fails: the reason in plain words first. */
function linkFailureText(err: unknown): string {
  const e = err as { message?: string; gitCause?: unknown; sentence?: unknown }
  if (e?.gitCause === 'auth') return "Couldn't get the plugins: this account has no access to that repository. Ask whoever shared the link for access, then try again."
  if (e?.gitCause === 'network') return "Couldn't get the plugins: the repository could not be reached. Check the network or VPN, then try again."
  if (typeof e?.sentence === 'string' && e.gitCause && e.gitCause !== 'unknown') return `Couldn't get the plugins: ${e.sentence}`
  return `Couldn't get the plugins from that source. ${e?.message ?? String(err)}`
}

/**
 * An install link someone clicked: its own card where the page lands. A newer link replaces it.
 * It stays pending until Install, Cancel or (already installed) Done.
 */
export function LinkRequestCards({ store }: { store: PluginStore }) {
  const [linkRequest, setLinkRequest] = useState<InstallLinkTarget | null>(null)
  const [linkError, setLinkError] = useState<string | null>(null)
  useEffect(() => {
    const take = () => {
      const target = peekPendingInstall()
      if (!target) return
      setLinkRequest(target)
      setLinkError(null)
      store.setNotice(null)
      store.setError(null)
    }
    take()
    return subscribeOpenLinks(take)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleLinkInstall = async () => {
    if (!linkRequest) return
    const target = linkRequest
    store.setBusy('link')
    setLinkError(null)
    store.setNotice(null)
    store.setError(null)
    try {
      await store.installSource({ url: buildInstallLink(target) })
      settlePendingInstall(target)
      setLinkRequest((current) => (current === target ? null : current))
    } catch (err) {
      setLinkError(linkFailureText(err))
    } finally {
      store.setBusy(null)
    }
  }

  const linkInstalled = linkRequest ? installedSourceFor(linkRequest, store.sources) : null
  // Until the installed sources are read, the card cannot tell a fresh install from one already
  // there: it says it is checking rather than offer an Install that may be wrong.
  const linkChecking = linkRequest !== null && !store.sourcesLoaded
  return (
    <>
      {linkRequest && linkInstalled && (
        <SettingsGroup heading="Already installed" className="plugin-store-group plugin-link-request" data-testid="plugin-link-request" data-link-installed="true">
          <SettingsRow
            label={`${sourceDisplayName(linkInstalled)} is installed`}
            help={
              <span>
                {(linkInstalled.plugins.length > 0 ? linkInstalled.plugins : linkInstalled.lastKnownPlugins ?? [])
                  .map((plugin) => plugin.name ?? plugin.id).filter(Boolean).join(', ') || 'Its plugins are listed below.'}
                {' '}Nothing to install. Its section below says whether it is up to date.
              </span>
            }
            control={
              <span className="settings-addons-inline">
                <SettingsButton
                  variant="text"
                  onClick={() => {
                    void store.updates.checkRow(sourceRowKey(linkInstalled.slug), { kind: 'source', slug: linkInstalled.slug })
                    document.querySelector(`[data-testid="apps-source-${CSS.escape(linkInstalled.slug)}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
                  }}
                  data-testid="plugin-link-check"
                >
                  Check for updates
                </SettingsButton>
                <SettingsButton
                  variant="primary"
                  onClick={() => { settlePendingInstall(linkRequest); setLinkRequest(null); setLinkError(null) }}
                  data-testid="plugin-link-done"
                >
                  Done
                </SettingsButton>
              </span>
            }
          />
        </SettingsGroup>
      )}

      {linkRequest && !linkInstalled && (
        <SettingsGroup heading="Install from a link" className="plugin-store-group plugin-link-request" data-testid="plugin-link-request" data-link-checking={linkChecking ? 'true' : undefined}>
          <SettingsRow
            label="Source"
            help={
              <span>
                <code className="settings-addons-mono" data-testid="plugin-link-source">
                  {linkRequest.kind === 'npm' ? linkRequest.spec : linkRequest.url}
                  {linkRequest.kind === 'git' && linkRequest.ref ? ` (branch ${linkRequest.ref})` : ''}
                </code>
                <span className="plugin-install-consent" data-testid="plugin-link-consent">{INSTALL_CONSENT}</span>
                {store.sourcesFailed && (
                  <span className="plugin-install-consent" data-testid="plugin-link-unknown">Walnut could not read its installed sources just now, so this one may be installed already.</span>
                )}
              </span>
            }
            error={linkError ?? undefined}
            control={
              <span className="settings-addons-inline">
                <SettingsButton variant="text" disabled={store.busy === 'link'} onClick={() => { settlePendingInstall(linkRequest); setLinkRequest(null); setLinkError(null) }} data-testid="plugin-link-cancel">
                  Cancel
                </SettingsButton>
                <SettingsButton
                  variant="primary"
                  busy={store.busy === 'link' || linkChecking}
                  busyLabel={linkChecking ? 'Checking...' : 'Installing...'}
                  reserve={['Checking...']}
                  onClick={() => void handleLinkInstall()}
                  data-testid="plugin-link-install"
                >
                  Install
                </SettingsButton>
              </span>
            }
          />
        </SettingsGroup>
      )}
    </>
  )
}

export interface AddSource {
  url: string
  setUrl: (value: string) => void
  draftKey: string | null
  open: boolean
  setOpen: (open: boolean) => void
  /** Opens or closes the form, the field focused when it opens. */
  toggle: () => void
  inputRef: React.RefObject<HTMLInputElement | null>
  submit: () => Promise<void>
}

/** The git or npm form's state. A source typed and not installed yet survives leaving the page; a successful Add ends it. */
export function useAddSource(store: PluginStore): AddSource {
  const urlDraft = useDraft(draftKey('plugin-source', 'new'))
  const { text: url, setText: setUrl } = urlDraft
  const [open, setOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  // A source typed earlier and not installed yet keeps the form open.
  useEffect(() => { if (url.trim()) setOpen(true) }, [url])
  const submit = async () => {
    const value = url.trim()
    if (!value) return
    store.setBusy('add')
    store.setError(null)
    store.setNotice(null)
    const sentKey = urlDraft.key
    try {
      const isSnippet = value.startsWith('{')
      const isInstallLink = value.toLowerCase().startsWith(INSTALL_LINK_SCHEME)
      await store.installSource(isSnippet || isInstallLink || looksLikeGitUrl(value) ? { url: value } : { spec: value })
      urlDraft.clear(sentKey)
    } catch (err) {
      store.setError(err instanceof Error ? err.message : String(err))
    } finally {
      store.setBusy(null)
    }
  }
  const toggle = () => {
    setOpen(!open)
    if (!open) requestAnimationFrame(() => inputRef.current?.focus())
  }
  return { url, setUrl, draftKey: urlDraft.key ?? null, open, setOpen, toggle, inputRef, submit }
}

/** The free-form install, for anything the catalog does not list. Shown while open or holding a draft. */
export function AddSourceForm({ store, add }: { store: PluginStore; add: AddSource }) {
  const registry = store.registry
  if (!add.open && add.url.trim() === '') return null
  return (
    <SettingsGroup
      heading="Install from git or npm"
      className="apps-add-form"
      footer={registry?.cloud
        ? 'Read from your Mac over the bridge; installing and removing sources happens on the Mac.'
        : registry?.sourcesUnavailable
          ? "The installed-source list couldn't be read, so Update and Remove are unavailable here."
          : 'Neither kind ever updates itself: you press Update.'}
    >
      <SettingsRow
        label="Git URL or npm package"
        htmlFor="plugin-source-url"
        help={`A repo holds one plugin or one per folder; npm installs pin an exact version with scripts off. ${INSTALL_CONSENT}`}
        wide
        className="settings-row-stacked"
        control={
          <span className="settings-addons-inline">
            <input
              id="plugin-source-url"
              ref={add.inputRef}
              type="text"
              data-draft-key={add.draftKey ?? undefined}
              className="settings-input settings-input--long settings-input--mono"
              value={add.url}
              onChange={(e) => add.setUrl(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void add.submit() } }}
              placeholder="https://github.com/example/walnut-plugin"
              spellCheck={false}
            />
            <SettingsButton
              variant="primary"
              disabled={!add.url.trim()}
              title={!add.url.trim() ? 'Paste a Git URL or an npm package first.' : undefined}
              busy={store.busy === 'add'}
              busyLabel="Installing..."
              onClick={() => void add.submit()}
              data-testid="plugin-source-add"
            >
              Install
            </SettingsButton>
          </span>
        }
      />
    </SettingsGroup>
  )
}

/**
 * Phase two of an install from the form: the plugin that just arrived needs another one. These
 * rows name every source it would add and ARE the consent.
 */
export function PendingDependencies({ store }: { store: PluginStore }) {
  if (!store.pending || store.pending.rowId) return null
  return (
    <SettingsGroup heading="Dependencies">
      <PluginPendingDependencies
        plan={store.pending.plan}
        busy={store.busy === `pending:${store.pending.slug}`}
        nameFor={store.nameOf}
        onInstall={() => void store.installDependencies(store.pending!.slug, `pending:${store.pending!.slug}`)}
        onDismiss={() => store.setPending(null)}
      />
    </SettingsGroup>
  )
}

/** The store's page-level words: a Remove that needs a restart, an error, a notice and what an add exposed. */
export function StoreNotices({ store }: { store: PluginStore }) {
  return (
    <>
      {/* Only Remove needs a page-level word: no plugin survives to carry the tag. */}
      {store.restartNeeded && <SettingsNotice kind="warn">Restart Walnut to finish removing that plugin&apos;s code.</SettingsNotice>}
      {store.error && <SettingsNotice kind="error" role="alert">{store.error}</SettingsNotice>}
      {store.notice && <SettingsNotice kind="success">{store.notice}</SettingsNotice>}
      {store.notice && store.addedPluginIds.length > 0 && <ExposeGuide pluginIds={store.addedPluginIds} testId="expose-guide-added" />}
    </>
  )
}
