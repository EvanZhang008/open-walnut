/**
 * The unlocked vault: sections on the left, the list in the middle, the item on the
 * right. The section, sort and selected item are kept like every view choice; the
 * opened item (with its secrets) lives only in memory and is dropped on lock.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { vaultApi, VaultApiError, isLockedError, type SecurityReport, type VaultItem, type VaultItemSummary, type VaultStatus } from '@/api/vault'
import { usePageView } from '@/utils/view-memory'
import { useMenuPlacement } from '@/hooks/useMenuPlacement'
import { log } from '@/utils/log'
import type { VaultItemType } from '../../../../src/core/vault/types'
import { displayHost } from '../../../../src/core/vault/url-match'
import {
  SECTIONS, inSection, isPasswordsSection, isPasswordsSort, isViewSection, matchesQuery, sectionCounts, sortItems, typeLabel,
  type PasswordsSection, type PasswordsSort,
} from './passwords-model'
import { ItemView, SiteTile } from './ItemView'
import { ItemEditor } from './ItemEditor'
import { ImportDialog } from './ImportDialog'
import { GeneratorPanel } from './GeneratorPanel'
import { AgentActivity } from './AgentActivity'
import {
  GridIcon, StarIcon, UserKeyIcon, ClockIcon, CodeIcon, NoteIcon, CardIcon, ShieldIcon, TrashIcon, PlusIcon, SearchIcon,
  LockIcon, ImportIcon, DiceIcon, KeyIcon, RobotIcon,
} from './pw-icons'

const SECTION_ICON: Record<PasswordsSection, React.ReactNode> = {
  all: <GridIcon size={16} />, favorites: <StarIcon size={16} />, logins: <UserKeyIcon size={16} />, codes: <ClockIcon size={16} />,
  api_keys: <CodeIcon size={16} />, notes: <NoteIcon size={16} />, cards: <CardIcon size={16} />, security: <ShieldIcon size={16} />,
  agents: <RobotIcon size={16} />, trash: <TrashIcon size={16} />,
}

const NEW_TYPES: VaultItemType[] = ['login', 'api_key', 'note', 'card']
const isString = (v: unknown): v is string => typeof v === 'string'

type Editing = null | { kind: 'new'; type: VaultItemType } | { kind: 'edit'; item: VaultItem }

function NewItemButton({ onPick }: { onPick: (t: VaultItemType) => void }) {
  const [newMenuOpen, setNewMenuOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const place = useMenuPlacement(newMenuOpen, trigger, menu, { minHeight: 120, onAnchorLost: () => setNewMenuOpen(false) })
  return (
    <>
      <button ref={trigger} type="button" className="pw-icon-btn pw-new-btn" aria-label="New item" title="New item" aria-expanded={newMenuOpen} onClick={() => setNewMenuOpen((o) => !o)}><PlusIcon /></button>
      {newMenuOpen && createPortal(
        <div className="pw-popover-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) setNewMenuOpen(false) }}>
          <div ref={menu} className="pw-menu" role="menu" onPointerDown={(e) => e.stopPropagation()}
            style={place ? { top: place.top, right: place.right, maxHeight: place.maxHeight } : { visibility: 'hidden' }}>
            {NEW_TYPES.map((t) => (
              <button key={t} type="button" role="menuitem" className="pw-menu-item" onClick={() => { setNewMenuOpen(false); onPick(t) }}>New {typeLabel(t).toLowerCase()}</button>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}

function GeneratorToolButton() {
  const [generatorPopoverOpen, setGeneratorPopoverOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const place = useMenuPlacement(generatorPopoverOpen, trigger, menu, { minHeight: 260, align: 'left', onAnchorLost: () => setGeneratorPopoverOpen(false) })
  return (
    <>
      <button ref={trigger} type="button" className="pw-side-item" aria-expanded={generatorPopoverOpen} onClick={() => setGeneratorPopoverOpen((o) => !o)}>
        <span className="pw-side-icon"><DiceIcon /></span><span className="pw-side-label">Generator</span>
      </button>
      {generatorPopoverOpen && createPortal(
        <div className="pw-popover-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) setGeneratorPopoverOpen(false) }}>
          <div ref={menu} className="pw-popover" onPointerDown={(e) => e.stopPropagation()}
            style={place ? { top: place.top, right: place.right, maxHeight: place.maxHeight } : { visibility: 'hidden' }}>
            <GeneratorPanel />
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}

function SecurityView({ items, onOpen }: { items: VaultItemSummary[]; onOpen: (id: string) => void }) {
  const [report, setReport] = useState<SecurityReport | null>(null)
  useEffect(() => { void vaultApi.report().then(setReport).catch(() => setReport(null)) }, [items])
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items])
  if (!report) return <div className="pw-detail pw-empty"><p>Checking…</p></div>
  const groups: Array<{ key: string; title: string; why: string; ids: string[] }> = [
    { key: 'weak', title: 'Weak passwords', why: 'Easy to guess. Change them to a generated password.', ids: report.weak },
    { key: 'reused', title: 'Reused passwords', why: 'One leak opens every site that shares it.', ids: report.reused.flat() },
    { key: 'old', title: 'Not changed in a year', why: 'Worth a fresh password on important accounts.', ids: report.old },
    { key: 'http', title: 'Saved for plain http', why: 'These sites send your password unencrypted.', ids: report.insecureUrl },
  ]
  const total = new Set(groups.flatMap((g) => g.ids)).size
  return (
    <div className="pw-detail pw-security" data-testid="pw-security">
      <div className="pw-detail-head">
        <span className={`pw-shield ${total ? 'warn' : 'ok'}`}><ShieldIcon size={28} /></span>
        <div className="pw-detail-title">
          <h2>{total ? `${total} item${total === 1 ? '' : 's'} to look at` : 'No problems found'}</h2>
          <span className="pw-detail-type">Checked on this Mac. No password or site leaves it.</span>
        </div>
      </div>
      <div className="pw-sec-tiles">
        {groups.map((g) => <div key={g.key} className={`pw-sec-tile${g.ids.length ? ' warn' : ''}`}><b>{g.ids.length}</b><span>{g.title}</span></div>)}
      </div>
      {groups.filter((g) => g.ids.length).map((g) => (
        <div key={g.key} className="pw-card">
          <div className="pw-f-label pw-card-label">{g.title}</div>
          <p className="pw-hint">{g.why}</p>
          {[...new Set(g.ids)].map((id) => byId.get(id)).filter(Boolean).map((i) => (
            <button key={i!.id} type="button" className="pw-sec-row" onClick={() => onOpen(i!.id)}>
              <SiteTile item={i!} size={26} /><span>{i!.title}</span><span className="pw-row-sub">{i!.username}</span>
            </button>
          ))}
        </div>
      ))}
    </div>
  )
}

export function VaultBrowser({ status, onLocked }: { status: VaultStatus; onLocked: () => void }) {
  const navigate = useNavigate()
  const [items, setItems] = useState<VaultItemSummary[] | null>(null)
  const [section, setSection] = usePageView<PasswordsSection>('passwords', 'section', 'all', isPasswordsSection)
  const [sort, setSort] = usePageView<PasswordsSort>('passwords', 'sort', 'title', isPasswordsSort)
  const [selectedId, setSelectedId] = usePageView<string>('passwords', 'selected', '', isString)
  const [query, setQuery] = useState('')
  const [opened, setOpened] = useState<VaultItem | null>(null)
  const [editing, setEditing] = useState<Editing>(null)
  const [importDialogOpen, setImportDialogOpen] = useState(false)
  const [loadError, setLoadError] = useState('')
  const openSeq = useRef(0)

  const reload = useCallback(async () => {
    try {
      setItems(await vaultApi.list())
      setLoadError('')
    } catch (err) {
      if (isLockedError(err)) { onLocked(); return }
      setLoadError(err instanceof Error ? err.message : String(err))
    }
  }, [onLocked])

  useEffect(() => { void reload() }, [reload])

  // Open the selected item; a slower answer for an item no longer selected is dropped.
  useEffect(() => {
    if (!selectedId || isViewSection(section)) { setOpened(null); return }
    const seq = ++openSeq.current
    vaultApi.get(selectedId).then((it) => { if (seq === openSeq.current) setOpened(it) }).catch((err) => {
      if (seq !== openSeq.current) return
      setOpened(null)
      if (isLockedError(err)) onLocked()
      else if (err instanceof VaultApiError && err.status === 404) setSelectedId('')
    })
  }, [selectedId, section, onLocked, setSelectedId])

  // Auto-lock: after the configured minutes with no key or pointer in this page.
  useEffect(() => {
    let last = Date.now()
    const touch = () => { last = Date.now() }
    const t = window.setInterval(() => {
      if (Date.now() - last > status.autoLockMinutes * 60_000) {
        log.info('passwords', 'auto-lock after idle', { minutes: status.autoLockMinutes })
        void vaultApi.lock().finally(onLocked)
      }
    }, 15_000)
    window.addEventListener('pointerdown', touch, true)
    window.addEventListener('keydown', touch, true)
    return () => { window.clearInterval(t); window.removeEventListener('pointerdown', touch, true); window.removeEventListener('keydown', touch, true) }
  }, [status.autoLockMinutes, onLocked])

  const counts = useMemo(() => sectionCounts(items ?? []), [items])
  const shownItems = useMemo(() => sortItems((items ?? []).filter((i) => inSection(i, section) && matchesQuery(i, query)), sort), [items, section, query, sort])

  const pickSection = (s: PasswordsSection) => { setSection(s); setEditing(null); if (isViewSection(s)) setSelectedId('') }
  const select = (id: string) => { setEditing(null); setSelectedId(id) }
  const saved = (it: VaultItem) => {
    setEditing(null)
    setOpened(it)
    setSelectedId(it.id)
    if (section !== 'all' && !inSection({ ...it, hasPassword: !!it.password, hasTotp: !!it.totp, agentAccess: it.agentAccess ?? 'ask' }, section)) setSection('all')
    void reload()
  }
  const changed = (it: VaultItem | null) => {
    if (it) setOpened(it)
    else { setOpened(null); setSelectedId('') }
    void reload()
  }

  const lock = () => { void vaultApi.lock().finally(onLocked) }
  const sectionTitle = SECTIONS.find((s) => s.id === section)?.label ?? ''

  return (
    <div className="pw-app" data-testid="pw-app">
      <aside className="pw-side">
        <div className="pw-side-brand"><KeyIcon size={18} /> Passwords</div>
        <nav className="pw-side-nav" aria-label="Sections">
          {SECTIONS.map((s) => (
            <button key={s.id} type="button" className={`pw-side-item${section === s.id ? ' on' : ''}`} aria-current={section === s.id ? 'page' : undefined} onClick={() => pickSection(s.id)} data-testid={`pw-section-${s.id}`}>
              <span className="pw-side-icon">{SECTION_ICON[s.id]}</span>
              <span className="pw-side-label">{s.label}</span>
              {!isViewSection(s.id) && <span className="pw-side-count">{counts[s.id] || ''}</span>}
            </button>
          ))}
        </nav>
        <div className="pw-side-foot">
          {(status.hasRecovery === false || status.recoveryUnsaved) && (
            // No working kit in the person's hands: a forgotten master password would lock the vault for good.
            <div className="pw-side-warn" role="note" data-testid="pw-no-recovery">
              <b>{status.recoveryUnsaved ? 'Recovery kit not saved' : 'No recovery code yet'}</b>
              <span>{status.recoveryUnsaved ? 'Your recovery code changed and the new kit was never saved. Make a new one.' : 'Forget your master password and nothing opens this vault.'}</span>
              <button type="button" className="pw-btn pw-btn-small" onClick={() => navigate('/settings#passwords')}>Make a recovery kit</button>
            </div>
          )}
          <GeneratorToolButton />
          <button type="button" className="pw-side-item" onClick={() => setImportDialogOpen(true)}><span className="pw-side-icon"><ImportIcon /></span><span className="pw-side-label">Import…</span></button>
          <button type="button" className="pw-side-item" onClick={lock} data-testid="pw-lock"><span className="pw-side-icon"><LockIcon size={16} /></span><span className="pw-side-label">Lock</span></button>
        </div>
      </aside>

      <section className="pw-list" aria-label={sectionTitle}>
        <div className="pw-list-head">
          <div>
            <h1>{sectionTitle}</h1>
            <span className="pw-list-count">{items ? `${shownItems.length} item${shownItems.length === 1 ? '' : 's'}` : ''}</span>
          </div>
          {section !== 'trash' && <NewItemButton onPick={(t) => { setEditing({ kind: 'new', type: t }); setSelectedId('') }} />}
        </div>
        <div className="pw-search">
          <SearchIcon />
          <input data-no-draft="search" type="search" placeholder="Search" aria-label="Search passwords" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div className="pw-sort" role="group" aria-label="Sort">
          {([['title', 'Name'], ['updated', 'Changed'], ['used', 'Used']] as const).map(([k, label]) => (
            <button key={k} type="button" className={sort === k ? 'on' : ''} aria-pressed={sort === k} onClick={() => setSort(k)}>{label}</button>
          ))}
        </div>
        <div className="pw-rows" role="listbox" aria-label="Items">
          {loadError && <div className="pw-hint pw-hint-bad">{loadError}</div>}
          {items && shownItems.length === 0 && (
            <div className="pw-rows-empty">{query ? 'Nothing matches.' : section === 'trash' ? 'Nothing deleted.' : 'No items yet. Add one with + or import from another app.'}</div>
          )}
          {shownItems.map((i) => (
            <button key={i.id} type="button" role="option" aria-selected={selectedId === i.id} className={`pw-row${selectedId === i.id ? ' on' : ''}`} onClick={() => select(i.id)} data-testid="pw-row">
              <SiteTile item={i} />
              <span className="pw-row-text">
                <span className="pw-row-title">{i.title}{i.favorite && <span className="pw-row-star"><StarIcon size={11} filled /></span>}</span>
                <span className="pw-row-sub">{i.username || (i.urls?.[0] ? displayHost(i.urls[0]) : typeLabel(i.type))}</span>
              </span>
            </button>
          ))}
        </div>
      </section>

      <main className="pw-main">
        {editing?.kind === 'new' && <ItemEditor key={`new-${editing.type}`} type={editing.type} onSaved={saved} onCancel={() => setEditing(null)} />}
        {editing?.kind === 'edit' && <ItemEditor key={`edit-${editing.item.id}`} type={editing.item.type} item={editing.item} onSaved={saved} onCancel={() => setEditing(null)} />}
        {!editing && section === 'security' && items && <SecurityView items={items} onOpen={(id) => { setSection('all'); setSelectedId(id) }} />}
        {!editing && section === 'agents' && items && <AgentActivity items={items} onOpen={(id) => { setSection('all'); setSelectedId(id) }} onLocked={onLocked} />}
        {!editing && !isViewSection(section) && opened && opened.id === selectedId && (
          <ItemView key={opened.id} item={opened} onEdit={() => setEditing({ kind: 'edit', item: opened })} onChanged={changed} />
        )}
        {!editing && !isViewSection(section) && !selectedId && (
          <div className="pw-detail pw-empty">
            <KeyIcon size={40} />
            <p>{items?.length ? 'Pick an item to see it.' : 'Your vault is empty.'}</p>
            {!items?.length && (
              <div className="pw-gate-actions-row">
                <button type="button" className="pw-btn pw-btn-primary" onClick={() => setEditing({ kind: 'new', type: 'login' })}><PlusIcon size={15} /> New login</button>
                <button type="button" className="pw-btn" onClick={() => setImportDialogOpen(true)}><ImportIcon /> Import</button>
              </div>
            )}
          </div>
        )}
      </main>

      {importDialogOpen && <ImportDialog onClose={() => setImportDialogOpen(false)} onImported={() => void reload()} />}
    </div>
  )
}
