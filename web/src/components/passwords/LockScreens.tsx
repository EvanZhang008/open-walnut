/**
 * The two screens before the vault: first-time setup (master password, then the Secret
 * Key and its recovery kit) and unlock. Nothing typed here is kept anywhere: no draft,
 * no storage, cleared from state as soon as it was used.
 */
import { useEffect, useRef, useState } from 'react'
import { copySecret, vaultApi, VaultApiError, type VaultStatus } from '@/api/vault'
import { passwordStrength, type StrengthLevel } from '../../../../src/core/vault/strength'
import { KeyIcon, LockIcon, CopyIcon, CheckIcon, RobotIcon } from './pw-icons'
import { log } from '@/utils/log'

const LEVEL_TEXT: Record<StrengthLevel, string> = {
  very_weak: 'Very weak', weak: 'Weak', fair: 'Fair', strong: 'Strong', very_strong: 'Very strong',
}
const LEVEL_STEP: Record<StrengthLevel, number> = { very_weak: 1, weak: 2, fair: 3, strong: 4, very_strong: 5 }

export function StrengthMeter({ password }: { password: string }) {
  const s = passwordStrength(password)
  const step = password ? LEVEL_STEP[s.level] : 0
  return (
    <div className={`pw-meter pw-meter-${password ? s.level : 'empty'}`} aria-label={password ? `Strength: ${LEVEL_TEXT[s.level]}` : undefined}>
      <div className="pw-meter-bars">{[1, 2, 3, 4, 5].map((i) => <span key={i} className={i <= step ? 'on' : ''} />)}</div>
      <span className="pw-meter-text">{password ? LEVEL_TEXT[s.level] : ''}</span>
    </div>
  )
}

function errorText(err: unknown): string {
  if (err instanceof VaultApiError) return err.message
  return err instanceof Error ? err.message : String(err)
}

export function SetupFlow({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<'password' | 'kit'>('password')
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [agents, setAgents] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [secretKey, setSecretKey] = useState('')
  const [saved, setSaved] = useState(false)
  const [copied, setCopied] = useState(false)
  const strength = passwordStrength(pw)
  const strongEnough = pw.length >= 10 && LEVEL_STEP[strength.level] >= 3
  const matches = pw === pw2

  const create = async () => {
    if (!strongEnough || !matches) return
    setBusy(true); setError('')
    try {
      const r = await vaultApi.setup(pw, agents)
      setPw(''); setPw2('')
      setSecretKey(r.secretKey)
      setStep('kit')
      log.info('passwords', 'vault set up', { agentsWhileAway: agents })
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  if (step === 'kit') {
    return (
      <div className="pw-gate">
        <div className="pw-gate-card pw-gate-wide">
          <div className="pw-gate-icon"><KeyIcon size={30} /></div>
          <h1>Save your recovery kit</h1>
          <p className="pw-gate-sub">Your Secret Key and your master password together open your vault on a new machine or from a backup. Walnut cannot recover either for you.</p>
          <div className="pw-secret-key" data-testid="pw-secret-key">{secretKey}</div>
          <div className="pw-gate-actions-row">
            <button type="button" className="pw-btn" onClick={() => { void copySecret(secretKey).then(() => setCopied(true)) }}>
              {copied ? <CheckIcon /> : <CopyIcon />} {copied ? 'Copied' : 'Copy Secret Key'}
            </button>
            <button type="button" className="pw-btn" onClick={() => downloadRecoveryKit(secretKey)}>Download recovery kit</button>
          </div>
          <label className="pw-check">
            <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
            I saved my recovery kit somewhere safe, away from this computer.
          </label>
          <button type="button" className="pw-btn pw-btn-primary pw-btn-block" disabled={!saved} onClick={() => { setSecretKey(''); onDone() }}>Open Passwords</button>
        </div>
      </div>
    )
  }

  return (
    <div className="pw-gate">
      <form className="pw-gate-card" onSubmit={(e) => { e.preventDefault(); void create() }}>
        <div className="pw-gate-icon"><KeyIcon size={30} /></div>
        <h1>Set up Passwords</h1>
        <p className="pw-gate-sub">Your logins, codes and keys, encrypted on this Mac. Pick a master password you can remember; a few random words work well.</p>
        <label className="pw-field-label" htmlFor="pw-setup-1">Master password</label>
        <input data-no-draft="secret" id="pw-setup-1" className="pw-input" type="password" autoComplete="new-password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} />
        <StrengthMeter password={pw} />
        <label className="pw-field-label" htmlFor="pw-setup-2">Confirm master password</label>
        <input data-no-draft="secret" id="pw-setup-2" className="pw-input" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
        {pw2 && !matches && <div className="pw-hint pw-hint-bad">The two passwords differ.</div>}
        {pw && !strongEnough && <div className="pw-hint">At least 10 characters and Fair or better.</div>}
        <div className="pw-toggle-row">
          <span className="pw-toggle-icon"><RobotIcon /></span>
          <label className="pw-toggle-text" htmlFor="pw-setup-agents">
            <b>Let agents ask while you are away</b>
            <span>Keeps a key on this Mac so a task can use an item after you approve it on your phone, even when no window is unlocked. Each use still needs your approval, but any program running as you on this Mac could then read the vault without the master password. Off by default; you can turn it on later in Settings.</span>
          </label>
          <input id="pw-setup-agents" type="checkbox" className="pw-switch" checked={agents} onChange={(e) => setAgents(e.target.checked)} />
        </div>
        {error && <div className="pw-hint pw-hint-bad" role="alert">{error}</div>}
        <button type="submit" className="pw-btn pw-btn-primary pw-btn-block" disabled={!strongEnough || !matches || busy}>{busy ? 'Creating…' : 'Create vault'}</button>
      </form>
    </div>
  )
}

export function UnlockScreen({ status, onUnlocked }: { status: VaultStatus; onUnlocked: () => void }) {
  const [pw, setPw] = useState('')
  const [secretKey, setSecretKey] = useState('')
  const [needKey, setNeedKey] = useState(!status.hasSecretKey)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [waitUntil, setWaitUntil] = useState(status.waitMs > 0 ? Date.now() + status.waitMs : 0)
  const [, tick] = useState(0)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!waitUntil) return
    const t = window.setInterval(() => { if (Date.now() >= waitUntil) setWaitUntil(0); tick((n) => n + 1) }, 1000)
    return () => window.clearInterval(t)
  }, [waitUntil])

  const unlock = async () => {
    if (!pw || busy) return
    setBusy(true); setError('')
    try {
      await vaultApi.unlock(pw, status.kdf, needKey ? secretKey : undefined)
      setPw(''); setSecretKey('')
      onUnlocked()
    } catch (err) {
      if (err instanceof VaultApiError && err.code === 'secret_key_needed') setNeedKey(true)
      if (err instanceof VaultApiError && err.code === 'unlock_slowed' && err.waitMs) setWaitUntil(Date.now() + err.waitMs)
      setError(errorText(err))
      setPw('')
      input.current?.focus()
    } finally {
      setBusy(false)
    }
  }

  const waitS = waitUntil ? Math.max(0, Math.ceil((waitUntil - Date.now()) / 1000)) : 0
  return (
    <div className="pw-gate">
      <form className="pw-gate-card" onSubmit={(e) => { e.preventDefault(); void unlock() }} data-testid="pw-unlock">
        <div className="pw-gate-icon pw-gate-icon-lock"><LockIcon size={28} /></div>
        <h1>Passwords are locked</h1>
        <p className="pw-gate-sub">Enter your master password to unlock{status.itemCount ? ` ${status.itemCount} items` : ''}.</p>
        <input data-no-draft="secret" ref={input} className="pw-input pw-input-big" type="password" autoComplete="current-password" autoFocus placeholder="Master password" aria-label="Master password"
          value={pw} onChange={(e) => setPw(e.target.value)} disabled={waitS > 0} />
        {needKey && (
          <>
            <label className="pw-field-label" htmlFor="pw-sk">Secret Key (from your recovery kit)</label>
            <input data-no-draft="secret" id="pw-sk" className="pw-input pw-mono" autoComplete="off" spellCheck={false} placeholder="W1-XXXXXX-XXXXX-XXXXX-XXXXX-XXXXX" value={secretKey} onChange={(e) => setSecretKey(e.target.value)} />
          </>
        )}
        {error && <div className="pw-hint pw-hint-bad" role="alert">{waitS > 0 ? `Too many wrong passwords. Try again in ${waitS} s.` : error}</div>}
        <button type="submit" className="pw-btn pw-btn-primary pw-btn-block" disabled={!pw || busy || waitS > 0 || (needKey && !secretKey)}>{busy ? 'Unlocking…' : 'Unlock'}</button>
        <p className="pw-gate-foot">Locks again after {status.autoLockMinutes} minutes unused.</p>
      </form>
    </div>
  )
}

export function downloadRecoveryKit(secretKey: string): void {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))
  const when = new Date().toLocaleString()
  const html = `<!doctype html><meta charset="utf-8"><title>Walnut Passwords recovery kit</title>
<style>body{font:15px -apple-system,system-ui,sans-serif;max-width:640px;margin:40px auto;color:#1d1d1f}h1{font-size:24px}.k{font:20px ui-monospace,Menlo,monospace;letter-spacing:1px;padding:14px 18px;border:2px solid #1d1d1f;border-radius:10px;margin:12px 0}.box{border:1px dashed #999;border-radius:10px;height:56px;margin:8px 0}small{color:#666}</style>
<h1>Walnut Passwords recovery kit</h1>
<p>Made ${esc(when)} on ${esc(location.host)}.</p>
<h3>Secret Key</h3><div class="k">${esc(secretKey)}</div>
<h3>Master password</h3><div class="box"></div><small>Write it here by hand only if this paper is kept somewhere safe.</small>
<p>You need both to open your vault on a new machine or from a backup. Walnut cannot recover them. Print this page or keep it in a safe place, away from this computer.</p>`
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
  const a = document.createElement('a')
  a.href = url
  a.download = 'Walnut-Passwords-Recovery-Kit.html'
  a.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
