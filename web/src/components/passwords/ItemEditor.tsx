/**
 * New item and edit item, for every type. The form lives in component state only: a
 * typed password is never written to a draft or to storage. A save that finds the item
 * changed since it was opened (409 stale_item) says so instead of overwriting.
 */
import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { vaultApi, VaultApiError, type VaultItem, type VaultItemInput } from '@/api/vault'
import { useMenuPlacement } from '@/hooks/useMenuPlacement'
import type { AgentAccess, VaultItemType } from '../../../../src/core/vault/types'
import { StrengthMeter } from './LockScreens'
import { GeneratorPanel } from './GeneratorPanel'
import { AGENT_ACCESS_TEXT, SiteTile } from './ItemView'
import { typeLabel } from './passwords-model'
import { DiceIcon, EyeIcon, EyeOffIcon, PlusIcon, CloseIcon } from './pw-icons'

interface Form {
  type: VaultItemType
  title: string
  username: string
  password: string
  urls: string[]
  totp: string
  notes: string
  envName: string
  tags: string
  favorite: boolean
  sensitive: boolean
  agentAccess: AgentAccess
  fields: Array<{ name: string; value: string; hidden?: boolean }>
  card: { holder: string; number: string; expMonth: string; expYear: string; code: string; brand: string }
}

function toForm(type: VaultItemType, item?: VaultItem): Form {
  return {
    type: item?.type ?? type,
    title: item?.title ?? '',
    username: item?.username ?? '',
    password: item?.password ?? '',
    urls: item?.urls?.length ? [...item.urls] : [''],
    totp: item?.totp ?? '',
    notes: item?.notes ?? '',
    envName: item?.envName ?? '',
    tags: (item?.tags ?? []).join(', '),
    favorite: !!item?.favorite,
    sensitive: !!item?.sensitive,
    agentAccess: item?.agentAccess ?? 'ask',
    fields: item?.fields?.map((f) => ({ ...f })) ?? [],
    card: { holder: item?.card?.holder ?? '', number: item?.card?.number ?? '', expMonth: item?.card?.expMonth ?? '', expYear: item?.card?.expYear ?? '', code: item?.card?.code ?? '', brand: item?.card?.brand ?? '' },
  }
}

function toInput(f: Form, keep?: VaultItem): VaultItemInput {
  const t = (s: string) => s.trim() || undefined
  return {
    type: f.type,
    title: f.title.trim(),
    username: t(f.username),
    password: f.password || undefined,
    urls: f.urls.map((u) => u.trim()).filter(Boolean),
    totp: t(f.totp),
    notes: f.notes || undefined,
    envName: t(f.envName),
    tags: f.tags.split(',').map((x) => x.trim()).filter(Boolean),
    favorite: f.favorite || undefined,
    sensitive: f.sensitive || undefined,
    agentAccess: f.agentAccess,
    fields: f.fields.filter((x) => x.name.trim()),
    ...(f.type === 'card' ? { card: Object.fromEntries(Object.entries(f.card).filter(([, v]) => v.trim())) } : {}),
    ...(keep?.passkeys ? { passkeys: keep.passkeys } : {}),
  }
}

function GeneratorButton({ onUse }: { onUse: (pw: string) => void }) {
  const [generatorPopoverOpen, setGeneratorPopoverOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const place = useMenuPlacement(generatorPopoverOpen, trigger, menu, { minHeight: 260, onAnchorLost: () => setGeneratorPopoverOpen(false) })
  return (
    <>
      <button ref={trigger} type="button" className="pw-icon-btn" aria-label="Generate a password" title="Generate" aria-expanded={generatorPopoverOpen}
        onClick={() => setGeneratorPopoverOpen((o) => !o)}><DiceIcon /></button>
      {generatorPopoverOpen && createPortal(
        <div className="pw-popover-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) setGeneratorPopoverOpen(false) }}>
          <div ref={menu} className="pw-popover" onPointerDown={(e) => e.stopPropagation()}
            style={place ? { top: place.top, right: place.right, maxHeight: place.maxHeight } : { visibility: 'hidden' }}>
            <GeneratorPanel onUse={(pw) => { onUse(pw); setGeneratorPopoverOpen(false) }} />
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}

export function ItemEditor({ type, item, onSaved, onCancel }: {
  type: VaultItemType
  item?: VaultItem
  onSaved: (item: VaultItem) => void
  onCancel: () => void
}) {
  const [f, setF] = useState<Form>(() => toForm(type, item))
  const [showPassword, setShowPassword] = useState(!item)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }))

  const save = async () => {
    if (!f.title.trim()) { setError('Give it a name.'); return }
    setBusy(true); setError('')
    try {
      const saved = item ? await vaultApi.update(item.id, toInput(f, item), item.updatedAt) : await vaultApi.create(toInput(f))
      onSaved(saved)
    } catch (err) {
      setError(err instanceof VaultApiError && err.code === 'stale_item'
        ? 'This item was changed elsewhere since you opened it. Cancel and open it again to see the new version.'
        : err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const isLogin = f.type === 'login'
  return (
    <form className="pw-detail pw-editor" data-testid="pw-editor" onSubmit={(e) => { e.preventDefault(); void save() }}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onCancel() } }}>
      <div className="pw-detail-head">
        <SiteTile item={{ title: f.title || typeLabel(f.type), urls: f.urls.filter(Boolean) }} size={52} />
        <div className="pw-detail-title">
          <input data-no-draft="secret" className="pw-title-input" placeholder={`${typeLabel(f.type)} name`} aria-label="Name" autoFocus={!item} value={f.title} onChange={(e) => set('title', e.target.value)} />
          <span className="pw-detail-type">{item ? 'Editing' : 'New'} {typeLabel(f.type).toLowerCase()}</span>
        </div>
      </div>

      <div className="pw-card pw-form">
        {(isLogin || f.type === 'api_key') && (
          <label className="pw-form-row"><span>{f.type === 'api_key' ? 'Account' : 'Username'}</span>
            <input data-no-draft="secret" className="pw-input" autoComplete="off" spellCheck={false} value={f.username} onChange={(e) => set('username', e.target.value)} placeholder="name@example.com" />
          </label>
        )}
        {(isLogin || f.type === 'api_key') && (
          <div className="pw-form-row"><span>{f.type === 'api_key' ? 'Key' : 'Password'}</span>
            <div className="pw-form-col">
              <div className="pw-input-group">
                <input data-no-draft="secret" className="pw-input pw-mono" type={showPassword ? 'text' : 'password'} autoComplete="new-password" spellCheck={false} aria-label="Password" value={f.password} onChange={(e) => set('password', e.target.value)} />
                <button type="button" className="pw-icon-btn" aria-label={showPassword ? 'Hide password' : 'Show password'} onClick={() => setShowPassword((s) => !s)}>{showPassword ? <EyeOffIcon /> : <EyeIcon />}</button>
                {isLogin && <GeneratorButton onUse={(pw) => { set('password', pw); setShowPassword(true) }} />}
              </div>
              {isLogin && <StrengthMeter password={f.password} />}
            </div>
          </div>
        )}
        {f.type === 'api_key' && (
          <label className="pw-form-row"><span>Env variable</span>
            <input data-no-draft="secret" className="pw-input pw-mono" placeholder="GITHUB_TOKEN" value={f.envName} onChange={(e) => set('envName', e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'))} />
          </label>
        )}
        {isLogin && (
          <label className="pw-form-row"><span>Verification code</span>
            <input data-no-draft="secret" className="pw-input pw-mono" spellCheck={false} placeholder="Setup key or otpauth:// link" value={f.totp} onChange={(e) => set('totp', e.target.value)} />
          </label>
        )}
        {f.type === 'card' && (
          <>
            <label className="pw-form-row"><span>Cardholder</span><input data-no-draft="secret" className="pw-input" value={f.card.holder} onChange={(e) => set('card', { ...f.card, holder: e.target.value })} /></label>
            <label className="pw-form-row"><span>Number</span><input data-no-draft="secret" className="pw-input pw-mono" inputMode="numeric" autoComplete="off" value={f.card.number} onChange={(e) => set('card', { ...f.card, number: e.target.value })} /></label>
            <div className="pw-form-row"><span>Expires</span>
              <div className="pw-input-group pw-exp">
                <input data-no-draft="secret" className="pw-input" placeholder="MM" aria-label="Expiry month" value={f.card.expMonth} onChange={(e) => set('card', { ...f.card, expMonth: e.target.value })} />
                <input data-no-draft="secret" className="pw-input" placeholder="YYYY" aria-label="Expiry year" value={f.card.expYear} onChange={(e) => set('card', { ...f.card, expYear: e.target.value })} />
              </div>
            </div>
            <label className="pw-form-row"><span>Security code</span><input data-no-draft="secret" className="pw-input pw-mono" type="password" autoComplete="off" value={f.card.code} onChange={(e) => set('card', { ...f.card, code: e.target.value })} /></label>
          </>
        )}
      </div>

      {(isLogin || f.type === 'api_key') && (
        <div className="pw-card pw-form">
          <div className="pw-f-label pw-card-label">Websites</div>
          {f.urls.map((u, i) => (
            <div key={i} className="pw-input-group">
              <input data-no-draft="secret" className="pw-input" spellCheck={false} placeholder="example.com" aria-label={`Website ${i + 1}`} value={u}
                onChange={(e) => set('urls', f.urls.map((x, j) => (j === i ? e.target.value : x)))} />
              {f.urls.length > 1 && <button type="button" className="pw-icon-btn" aria-label="Remove website" onClick={() => set('urls', f.urls.filter((_, j) => j !== i))}><CloseIcon /></button>}
            </div>
          ))}
          <button type="button" className="pw-link-btn" onClick={() => set('urls', [...f.urls, ''])}><PlusIcon size={14} /> Add website</button>
        </div>
      )}

      <div className="pw-card pw-form">
        <div className="pw-f-label pw-card-label">Custom fields</div>
        {f.fields.map((x, i) => (
          <div key={i} className="pw-input-group">
            <input data-no-draft="secret" className="pw-input pw-field-name" placeholder="Name" aria-label={`Field ${i + 1} name`} value={x.name} onChange={(e) => set('fields', f.fields.map((y, j) => (j === i ? { ...y, name: e.target.value } : y)))} />
            <input data-no-draft="secret" className="pw-input" type={x.hidden ? 'password' : 'text'} placeholder="Value" aria-label={`Field ${i + 1} value`} value={x.value} onChange={(e) => set('fields', f.fields.map((y, j) => (j === i ? { ...y, value: e.target.value } : y)))} />
            <label className="pw-chip-check" title="Hide the value"><input type="checkbox" checked={!!x.hidden} onChange={(e) => set('fields', f.fields.map((y, j) => (j === i ? { ...y, hidden: e.target.checked } : y)))} />Hidden</label>
            <button type="button" className="pw-icon-btn" aria-label="Remove field" onClick={() => set('fields', f.fields.filter((_, j) => j !== i))}><CloseIcon /></button>
          </div>
        ))}
        <button type="button" className="pw-link-btn" onClick={() => set('fields', [...f.fields, { name: '', value: '' }])}><PlusIcon size={14} /> Add field</button>
      </div>

      <div className="pw-card pw-form">
        <label className="pw-form-row pw-form-top"><span>Notes</span>
          <textarea data-no-draft="secret" className="pw-input pw-textarea" rows={f.type === 'note' ? 10 : 3} value={f.notes} onChange={(e) => set('notes', e.target.value)} />
        </label>
        <label className="pw-form-row"><span>Tags</span>
          <input data-no-draft="secret" className="pw-input" placeholder="work, family" value={f.tags} onChange={(e) => set('tags', e.target.value)} />
        </label>
      </div>

      <div className="pw-card pw-form">
        <div className="pw-form-row pw-form-top"><span>Agent access</span>
          <div className="pw-seg pw-seg-col" role="radiogroup" aria-label="Agent access">
            {(['ask', 'allow', 'never'] as const).map((a) => (
              <button key={a} type="button" role="radio" aria-checked={f.agentAccess === a} className={f.agentAccess === a ? 'on' : ''} onClick={() => set('agentAccess', a)}>{AGENT_ACCESS_TEXT[a]}</button>
            ))}
          </div>
        </div>
        <label className="pw-form-row pw-check-row">
          <span>Sensitive</span>
          <span className="pw-check-text"><input type="checkbox" checked={f.sensitive} onChange={(e) => set('sensitive', e.target.checked)} /> An agent's use needs Face ID or Touch ID, not a tap</span>
        </label>
      </div>

      {error && <div className="pw-hint pw-hint-bad" role="alert">{error}</div>}
      <div className="pw-editor-actions">
        <button type="button" className="pw-btn" onClick={onCancel}>Cancel</button>
        <button type="submit" className="pw-btn pw-btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </form>
  )
}
